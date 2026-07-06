import { ConfigService } from '@nestjs/config';
import { ResilientLlmService, getLlmFailureDiagnostics } from './resilient-llm.service';
import { LlmProviderPort } from '../ports/llm-provider.port';
import { MODEL_TIER_FAST } from '../config/model-tiers.config';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';

function fakeProvider(name: string, vision = true): jest.Mocked<LlmProviderPort> {
    return {
        getName: jest.fn().mockReturnValue(name),
        generateWithResilience: jest.fn(),
        supportsVision: jest.fn().mockReturnValue(vision),
    };
}

/** Gemini-style multimodal Part[] prompt (as built by OcrWorker). */
const MULTIMODAL_PROMPT = [
    { text: 'extrae los biomarcadores' },
    { inlineData: { data: 'base64data', mimeType: 'image/png' } },
];

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Builds the LlmGenerationResult shape returned by a successful provider call. */
function genResult(text: string, model = 'test-model') {
    return { text, usage: ZERO_USAGE, model };
}

function rateLimitedError(): AppException {
    return new AppException({
        errorCode: ErrorCode.AI_RATE_LIMITED,
        message: 'rate limited',
        statusCode: 500,
    });
}

function unavailableError(): AppException {
    return new AppException({
        errorCode: ErrorCode.AI_UNAVAILABLE,
        message: 'unavailable',
        statusCode: 500,
    });
}

function parseError(): AppException {
    return new AppException({
        errorCode: ErrorCode.AI_PARSE_FAILED,
        message: 'parse failed',
        statusCode: 500,
    });
}

function createConfigService(overrides: Record<string, unknown> = {}): ConfigService {
    const defaults: Record<string, unknown> = {
        LLM_PRIMARY_PROVIDER: 'gemini',
        LLM_FALLBACK_CHAIN: 'groq,cerebras',
        ...overrides,
    };

    return {
        get: jest.fn((key: string) => defaults[key]),
    } as unknown as ConfigService;
}

describe('ResilientLlmService', () => {
    let gemini: jest.Mocked<LlmProviderPort>;
    let groq: jest.Mocked<LlmProviderPort>;
    let cerebras: jest.Mocked<LlmProviderPort>;
    let providers: Map<string, LlmProviderPort>;

    beforeEach(() => {
        gemini = fakeProvider('gemini');
        groq = fakeProvider('groq');
        cerebras = fakeProvider('cerebras', false); // Cerebras is text-only
        providers = new Map([
            ['gemini', gemini],
            ['groq', groq],
            ['cerebras', cerebras],
        ]);
    });

    it('returns the primary provider result when it succeeds', async () => {
        gemini.generateWithResilience.mockResolvedValueOnce(genResult('respuesta de gemini'));

        const service = new ResilientLlmService(providers, createConfigService());
        const result = await service.generateWithFallback(MODEL_TIER_FAST, 'hola');

        expect(result.text).toBe('respuesta de gemini');
        expect(result.provider).toBe('gemini');
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).not.toHaveBeenCalled();
        expect(cerebras.generateWithResilience).not.toHaveBeenCalled();
    });

    it('falls back to the next provider in the chain on RATE_LIMITED', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockResolvedValueOnce(genResult('respuesta de groq'));

        const service = new ResilientLlmService(providers, createConfigService());
        const result = await service.generateWithFallback(MODEL_TIER_FAST, 'hola');

        expect(result.text).toBe('respuesta de groq');
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(cerebras.generateWithResilience).not.toHaveBeenCalled();
    });

    it('walks the full chain (gemini -> groq -> cerebras) when both prior providers are rate-limited', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockRejectedValueOnce(unavailableError());
        cerebras.generateWithResilience.mockResolvedValueOnce(genResult('respuesta de cerebras'));

        const service = new ResilientLlmService(providers, createConfigService());
        const result = await service.generateWithFallback(MODEL_TIER_FAST, 'hola');

        expect(result.text).toBe('respuesta de cerebras');
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(cerebras.generateWithResilience).toHaveBeenCalledTimes(1);
    });

    it('throws when every provider in the chain is exhausted', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockRejectedValueOnce(unavailableError());
        cerebras.generateWithResilience.mockRejectedValueOnce(rateLimitedError());

        const service = new ResilientLlmService(providers, createConfigService());

        await expect(service.generateWithFallback(MODEL_TIER_FAST, 'hola')).rejects.toThrow(
            AppException,
        );
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(cerebras.generateWithResilience).toHaveBeenCalledTimes(1);
    });

    it('attaches provider diagnostics (full chain + failed model) when the chain is exhausted', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockRejectedValueOnce(unavailableError());
        cerebras.generateWithResilience.mockRejectedValueOnce(rateLimitedError());

        const service = new ResilientLlmService(providers, createConfigService());

        const err = await service
            .generateWithFallback(MODEL_TIER_FAST, 'hola')
            .catch((e) => e);

        const diag = getLlmFailureDiagnostics(err);
        expect(diag).toBeDefined();
        expect(diag?.attemptedProviders).toEqual(['gemini', 'groq', 'cerebras']);
        expect(diag?.failedProvider).toBe('cerebras');
    });

    it('records the failing model for a multimodal prompt (cerebras skipped, groq the last vision provider)', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockRejectedValueOnce(unavailableError());

        const service = new ResilientLlmService(providers, createConfigService());

        const err = await service
            .generateWithFallback(MODEL_TIER_FAST, MULTIMODAL_PROMPT)
            .catch((e) => e);

        const diag = getLlmFailureDiagnostics(err);
        // cerebras is text-only → never attempted for an image prompt.
        expect(diag?.attemptedProviders).toEqual(['gemini', 'groq']);
        expect(diag?.failedProvider).toBe('groq');
        expect(cerebras.generateWithResilience).not.toHaveBeenCalled();
    });

    it('falls back on PARSE errors too (fallback-on-all-errors policy)', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(parseError());
        groq.generateWithResilience.mockResolvedValueOnce(genResult('respuesta de groq'));

        const service = new ResilientLlmService(providers, createConfigService());
        const result = await service.generateWithFallback(MODEL_TIER_FAST, 'hola');

        expect(result.text).toBe('respuesta de groq');
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(cerebras.generateWithResilience).not.toHaveBeenCalled();
    });

    it('skips text-only providers (cerebras) for multimodal prompts', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockRejectedValueOnce(rateLimitedError());

        const service = new ResilientLlmService(providers, createConfigService());

        // Both vision-capable providers fail — cerebras must NOT be tried,
        // because it would drop the image and hallucinate biomarkers.
        await expect(
            service.generateWithFallback(MODEL_TIER_FAST, MULTIMODAL_PROMPT),
        ).rejects.toThrow(AppException);
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(cerebras.generateWithResilience).not.toHaveBeenCalled();
    });

    it('serves multimodal prompts via the groq vision fallback when gemini is rate-limited', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockResolvedValueOnce(genResult('{"biomarkers":[]}'));

        const service = new ResilientLlmService(providers, createConfigService());
        const result = await service.generateWithFallback(MODEL_TIER_FAST, MULTIMODAL_PROMPT);

        expect(result.text).toBe('{"biomarkers":[]}');
        expect(cerebras.generateWithResilience).not.toHaveBeenCalled();
    });

    it('throws AI_UNAVAILABLE when no vision-capable provider exists for a multimodal prompt', async () => {
        const textOnly = fakeProvider('cerebras', false);
        const service = new ResilientLlmService(
            new Map([['cerebras', textOnly]]),
            createConfigService({ LLM_PRIMARY_PROVIDER: 'cerebras', LLM_FALLBACK_CHAIN: '' }),
        );

        await expect(
            service.generateWithFallback(MODEL_TIER_FAST, MULTIMODAL_PROMPT),
        ).rejects.toMatchObject({ errorCode: ErrorCode.AI_UNAVAILABLE });
        expect(textOnly.generateWithResilience).not.toHaveBeenCalled();
    });

    it('respects a single-provider legacy LLM_FALLBACK_PROVIDER when LLM_FALLBACK_CHAIN is unset', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockResolvedValueOnce(genResult('respuesta de groq'));

        const service = new ResilientLlmService(
            providers,
            createConfigService({ LLM_FALLBACK_CHAIN: undefined, LLM_FALLBACK_PROVIDER: 'groq' }),
        );
        const result = await service.generateWithFallback(MODEL_TIER_FAST, 'hola');

        expect(result.text).toBe('respuesta de groq');
        expect(cerebras.generateWithResilience).not.toHaveBeenCalled();
    });

    it('throws the primary error directly when no fallback provider is configured', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());

        const service = new ResilientLlmService(
            new Map([['gemini', gemini]]),
            createConfigService({ LLM_FALLBACK_CHAIN: '' }),
        );

        await expect(service.generateWithFallback(MODEL_TIER_FAST, 'hola')).rejects.toThrow(
            AppException,
        );
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
    });
});


