import { ConfigService } from '@nestjs/config';
import { CerebrasAdapter } from './cerebras-adapter';
import { AppException } from '../../common/exceptions/app-exception';
import { MODEL_TIER_FAST, MODEL_TIER_PRO } from '../config/model-tiers.config';

function createConfigService(overrides: Record<string, unknown> = {}): ConfigService {
    const defaults: Record<string, unknown> = {
        cerebras_API_KEY: 'test-cerebras-key',
        aiModels: {
            cerebrasModelCollecting: 'cerebras-v4-flash',
            cerebrasModelAnalyzing: 'cerebras-v4-flash',
            cerebrasModelCompleted: 'cerebras-v4-pro',
            timeoutFastMs: 200,
            timeoutSlowMs: 500,
            cerebrasRetryMax: 1,
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

describe('CerebrasAdapter', () => {
    let adapter: CerebrasAdapter;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
        adapter = new CerebrasAdapter(createConfigService());
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    it('reports its provider name as "cerebras"', () => {
        expect(adapter.getName()).toBe('cerebras');
    });

    describe('generateWithResilience', () => {
        it('returns the raw text on a successful call', async () => {
            fetchMock.mockResolvedValueOnce(
                jsonResponse({ choices: [{ message: { content: 'respuesta de cerebras' } }] }),
            );

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test prompt');
            expect(result.text).toBe('respuesta de cerebras');
        });

        it('calls the chat/completions endpoint with the Authorization header', async () => {
            fetchMock.mockResolvedValueOnce(
                jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
            );

            await adapter.generateWithResilience(MODEL_TIER_FAST, 'test prompt');

            expect(fetchMock).toHaveBeenCalledWith(
                'https://api.cerebras.ai/v1/chat/completions',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        Authorization: 'Bearer test-cerebras-key',
                    }),
                }),
            );
        });

        it('retries once on HTTP 429 and succeeds on the second attempt', async () => {
            fetchMock
                .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, false, 429))
                .mockResolvedValueOnce(
                    jsonResponse({ choices: [{ message: { content: 'recovered' } }] }),
                );

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.text).toBe('recovered');
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('retries on HTTP 503 unavailable', async () => {
            fetchMock
                .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, false, 503))
                .mockResolvedValueOnce(
                    jsonResponse({ choices: [{ message: { content: 'back online' } }] }),
                );

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

        it('uses the pro-tier model for MODEL_TIER_PRO', async () => {
            fetchMock.mockResolvedValueOnce(
                jsonResponse({ choices: [{ message: { content: 'pro result' } }] }),
            );

            await adapter.generateWithResilience(MODEL_TIER_PRO, 'test');

            const [, requestInit] = fetchMock.mock.calls[0];
            const body = JSON.parse(requestInit.body as string);
            expect(body.model).toBe('cerebras-v4-pro');
        });

        it('flattens multimodal Part[] prompts to text-only content (no image support)', async () => {
            fetchMock.mockResolvedValueOnce(
                jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
            );

            const parts = [
                { text: 'analiza esto' },
                { inlineData: { data: 'base64...', mimeType: 'image/png' } },
            ];

            await adapter.generateWithResilience(MODEL_TIER_FAST, parts as any);

            const [, requestInit] = fetchMock.mock.calls[0];
            const body = JSON.parse(requestInit.body as string);
            expect(body.messages[0].content).toBe('analiza esto');
        });

        it('returns empty string when the response has no choices', async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.text).toBe('');
        });
    });
});


