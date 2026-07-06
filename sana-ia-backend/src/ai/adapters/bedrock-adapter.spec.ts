import { ConfigService } from '@nestjs/config';
import { BedrockAdapter } from './bedrock-adapter';
import { AppException } from '../../common/exceptions/app-exception';
import { MODEL_TIER_FAST, MODEL_TIER_PRO } from '../config/model-tiers.config';

function createConfigService(overrides: Record<string, unknown> = {}): ConfigService {
    const defaults: Record<string, unknown> = {
        BEDROCK_MANTLE_API_KEY: 'test-mantle-key',
        AWS_REGION: 'us-east-1',
        aiModels: {
            bedrockModelCollecting: 'openai.gpt-oss-20b',
            bedrockModelAnalyzing: 'openai.gpt-oss-20b',
            bedrockModelCompleted: 'openai.gpt-oss-120b',
            bedrockModelVision: 'qwen.qwen3-vl-235b-a22b-instruct',
            timeoutFastMs: 200,
            timeoutSlowMs: 500,
            bedrockRetryMax: 1,
            retryBaseMs: 10,
            retryCapMs: 50,
        },
        ...overrides,
    };

    return {
        get: jest.fn((key: string) => defaults[key]),
    } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
    return {
        ok,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as Response;
}

describe('BedrockAdapter', () => {
    let adapter: BedrockAdapter;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
        adapter = new BedrockAdapter(createConfigService());
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    it('reports its provider name as "bedrock"', () => {
        expect(adapter.getName()).toBe('bedrock');
    });

    it('reports vision support', () => {
        expect(adapter.supportsVision()).toBe(true);
    });

    it('calls the Mantle endpoint for the configured region with the Authorization header', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        );

        await adapter.generateWithResilience(MODEL_TIER_FAST, 'test prompt');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-mantle-key',
                }),
            }),
        );
    });

    it('converts Gemini Part[] prompts to OpenAI vision format and uses the vision model', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ choices: [{ message: { content: '{"biomarkers":[]}' } }] }),
        );

        const parts = [
            { text: 'extrae biomarcadores' },
            { inlineData: { data: 'abc123', mimeType: 'image/png' } },
        ];
        const result = await adapter.generateWithResilience(MODEL_TIER_PRO, parts);

        expect(result.text).toBe('{"biomarkers":[]}');
        const [, requestInit] = fetchMock.mock.calls[0];
        const body = JSON.parse(requestInit.body as string);
        expect(body.model).toBe('qwen.qwen3-vl-235b-a22b-instruct');
        expect(body.messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'extrae biomarcadores' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
                ],
            },
        ]);
    });

    describe('generateWithResilience', () => {
        it('returns text, usage and model on a successful call', async () => {
            fetchMock.mockResolvedValueOnce(
                jsonResponse({
                    choices: [{ message: { content: 'hola, como puedo ayudarte' } }],
                    usage: { prompt_tokens: 74, completion_tokens: 12, total_tokens: 86 },
                }),
            );

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test prompt');

            expect(result.text).toBe('hola, como puedo ayudarte');
            expect(result.model).toBe('openai.gpt-oss-20b');
            expect(result.usage).toEqual({ promptTokens: 74, completionTokens: 12, totalTokens: 86 });
        });

        it('retries once on HTTP 429 and succeeds on the second attempt', async () => {
            fetchMock
                .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, false, 429))
                .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'recovered' } }] }));

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.text).toBe('recovered');
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('retries on HTTP 503 unavailable', async () => {
            fetchMock
                .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, false, 503))
                .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'back online' } }] }));

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.text).toBe('back online');
        });

        it('exhausts retries and throws AppException on persistent 429', async () => {
            fetchMock
                .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, false, 429))
                .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, false, 429));

            await expect(adapter.generateWithResilience(MODEL_TIER_FAST, 'test')).rejects.toThrow(
                AppException,
            );
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('does not retry a non-transient HTTP error (400)', async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad request' }, false, 400));

            await expect(adapter.generateWithResilience(MODEL_TIER_FAST, 'test')).rejects.toThrow(
                AppException,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('uses the completed-tier model for MODEL_TIER_PRO text prompts', async () => {
            fetchMock.mockResolvedValueOnce(
                jsonResponse({ choices: [{ message: { content: 'pro result' } }] }),
            );

            await adapter.generateWithResilience(MODEL_TIER_PRO, 'test');

            const [, requestInit] = fetchMock.mock.calls[0];
            const body = JSON.parse(requestInit.body as string);
            expect(body.model).toBe('openai.gpt-oss-120b');
        });

        it('defaults usage to zeros (with a warning) when the response has no usage block', async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'sin usage' } }] }));

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        });

        it('returns empty string when the response has no choices', async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.text).toBe('');
        });
    });
});
