import { ConfigService } from '@nestjs/config';
import { ResilientLlmService } from './resilient-llm.service';
import { LlmProviderPort } from '../ports/llm-provider.port';
import { MODEL_TIER_FAST } from '../config/model-tiers.config';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';

function fakeProvider(name: string): jest.Mocked<LlmProviderPort> {
    return {
        getName: jest.fn().mockReturnValue(name),
        generateWithResilience: jest.fn(),
    };
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
        LLM_FALLBACK_CHAIN: 'groq,deepseek',
        ...overrides,
    };

    return {
        get: jest.fn((key: string) => defaults[key]),
    } as unknown as ConfigService;
}

describe('ResilientLlmService', () => {
    let gemini: jest.Mocked<LlmProviderPort>;
    let groq: jest.Mocked<LlmProviderPort>;
    let deepseek: jest.Mocked<LlmProviderPort>;
    let providers: Map<string, LlmProviderPort>;

    beforeEach(() => {
        gemini = fakeProvider('gemini');
        groq = fakeProvider('groq');
        deepseek = fakeProvider('deepseek');
        providers = new Map([
            ['gemini', gemini],
            ['groq', groq],
            ['deepseek', deepseek],
        ]);
    });

    it('returns the primary provider result when it succeeds', async () => {
        gemini.generateWithResilience.mockResolvedValueOnce('respuesta de gemini');

        const service = new ResilientLlmService(providers, createConfigService());
        const result = await service.generateWithFallback(MODEL_TIER_FAST, 'hola');

        expect(result).toBe('respuesta de gemini');
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).not.toHaveBeenCalled();
        expect(deepseek.generateWithResilience).not.toHaveBeenCalled();
    });

    it('falls back to the next provider in the chain on RATE_LIMITED', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockResolvedValueOnce('respuesta de groq');

        const service = new ResilientLlmService(providers, createConfigService());
        const result = await service.generateWithFallback(MODEL_TIER_FAST, 'hola');

        expect(result).toBe('respuesta de groq');
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(deepseek.generateWithResilience).not.toHaveBeenCalled();
    });

    it('walks the full chain (gemini -> groq -> deepseek) when both prior providers are rate-limited', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockRejectedValueOnce(unavailableError());
        deepseek.generateWithResilience.mockResolvedValueOnce('respuesta de deepseek');

        const service = new ResilientLlmService(providers, createConfigService());
        const result = await service.generateWithFallback(MODEL_TIER_FAST, 'hola');

        expect(result).toBe('respuesta de deepseek');
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(deepseek.generateWithResilience).toHaveBeenCalledTimes(1);
    });

    it('throws when every provider in the chain is exhausted', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockRejectedValueOnce(unavailableError());
        deepseek.generateWithResilience.mockRejectedValueOnce(rateLimitedError());

        const service = new ResilientLlmService(providers, createConfigService());

        await expect(service.generateWithFallback(MODEL_TIER_FAST, 'hola')).rejects.toThrow(
            AppException,
        );
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(deepseek.generateWithResilience).toHaveBeenCalledTimes(1);
    });

    it('does NOT fall back on a non-transient error (PARSE) — stops immediately', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(parseError());

        const service = new ResilientLlmService(providers, createConfigService());

        await expect(service.generateWithFallback(MODEL_TIER_FAST, 'hola')).rejects.toThrow(
            AppException,
        );
        expect(gemini.generateWithResilience).toHaveBeenCalledTimes(1);
        expect(groq.generateWithResilience).not.toHaveBeenCalled();
        expect(deepseek.generateWithResilience).not.toHaveBeenCalled();
    });

    it('respects a single-provider legacy LLM_FALLBACK_PROVIDER when LLM_FALLBACK_CHAIN is unset', async () => {
        gemini.generateWithResilience.mockRejectedValueOnce(rateLimitedError());
        groq.generateWithResilience.mockResolvedValueOnce('respuesta de groq');

        const service = new ResilientLlmService(
            providers,
            createConfigService({ LLM_FALLBACK_CHAIN: undefined, LLM_FALLBACK_PROVIDER: 'groq' }),
        );
        const result = await service.generateWithFallback(MODEL_TIER_FAST, 'hola');

        expect(result).toBe('respuesta de groq');
        expect(deepseek.generateWithResilience).not.toHaveBeenCalled();
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
