import { ConfigService } from '@nestjs/config';
import { GroqAdapter } from './groq-adapter';
import { AppException } from '../../common/exceptions/app-exception';
import { MODEL_TIER_FAST, MODEL_TIER_PRO } from '../config/model-tiers.config';

/**
 * Minimal mock for the groq-sdk default export.
 * Mirrors the pattern used in gemini-client.service.spec.ts.
 */
jest.mock('groq-sdk', () => {
    const mockCreate = jest.fn();
    function GroqMock() {
        return {
            chat: { completions: { create: mockCreate } },
        };
    }

    return {
        __esModule: true,
        default: GroqMock,
        __mockCreate: mockCreate,
    };
});

const { __mockCreate: mockCreate } = jest.requireMock('groq-sdk');

function createConfigService(overrides: Record<string, unknown> = {}): ConfigService {
    const defaults: Record<string, unknown> = {
        GROQ_API_KEY: 'test-groq-key',
        aiModels: {
            groqModelCollecting: 'llama-3.3-70b-versatile',
            groqModelAnalyzing: 'llama-3.3-70b-versatile',
            groqModelCompleted: 'llama-3.3-70b-versatile',
            groqModelVision: 'qwen/qwen3.6-27b',
            timeoutFastMs: 200,
            timeoutSlowMs: 500,
            groqRetryMax: 1,
            retryBaseMs: 10,
            retryCapMs: 50,
        },
        ...overrides,
    };

    return {
        get: jest.fn((key: string) => defaults[key]),
    } as unknown as ConfigService;
}

describe('GroqAdapter', () => {
    let adapter: GroqAdapter;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        adapter = new GroqAdapter(createConfigService());
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    it('reports its provider name as "groq"', () => {
        expect(adapter.getName()).toBe('groq');
    });

    it('reports vision support', () => {
        expect(adapter.supportsVision()).toBe(true);
    });

    it('converts Gemini Part[] prompts to OpenAI vision format and uses the vision model', async () => {
        mockCreate.mockResolvedValueOnce({
            choices: [{ message: { content: '{"biomarkers":[]}' } }],
        });

        const parts = [
            { text: 'extrae biomarcadores' },
            { inlineData: { data: 'abc123', mimeType: 'image/png' } },
        ];
        const result = await adapter.generateWithResilience(MODEL_TIER_PRO, parts);

        expect(result).toBe('{"biomarkers":[]}');
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'qwen/qwen3.6-27b',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'extrae biomarcadores' },
                            {
                                type: 'image_url',
                                image_url: { url: 'data:image/png;base64,abc123' },
                            },
                        ],
                    },
                ],
            }),
        );
    });

    describe('generateWithResilience', () => {
        it('returns the raw text on a successful call', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{ message: { content: 'hola, como puedo ayudarte' } }],
            });

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test prompt');
            expect(result).toBe('hola, como puedo ayudarte');
        });

        it('retries once on a rate-limited error and succeeds on the second attempt', async () => {
            mockCreate
                .mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' })
                .mockResolvedValueOnce({
                    choices: [{ message: { content: 'recovered after retry' } }],
                });

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result).toBe('recovered after retry');
            expect(mockCreate).toHaveBeenCalledTimes(2);
        });

        it('retries on a 503 unavailable error', async () => {
            mockCreate
                .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' })
                .mockResolvedValueOnce({
                    choices: [{ message: { content: 'back online' } }],
                });

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result).toBe('back online');
        });

        it('does not retry on a parse-style error and throws AppException', async () => {
            mockCreate.mockRejectedValueOnce(new Error('JSON parse failed'));

            await expect(adapter.generateWithResilience(MODEL_TIER_FAST, 'test')).rejects.toThrow(
                AppException,
            );
            expect(mockCreate).toHaveBeenCalledTimes(1);
        });

        it('exhausts retries and throws AppException on persistent rate limiting', async () => {
            mockCreate
                .mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' })
                .mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' });

            await expect(adapter.generateWithResilience(MODEL_TIER_FAST, 'test')).rejects.toThrow(
                AppException,
            );
            // retryMax=1 → 1 initial + 1 retry = 2 attempts total
            expect(mockCreate).toHaveBeenCalledTimes(2);
        });

        it('uses the configured model for MODEL_TIER_PRO', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{ message: { content: 'pro response' } }],
            });

            const result = await adapter.generateWithResilience(MODEL_TIER_PRO, 'test');
            expect(result).toBe('pro response');
            expect(mockCreate).toHaveBeenCalledWith(
                expect.objectContaining({ model: 'llama-3.3-70b-versatile' }),
            );
        });

        it('returns empty string when the response has no choices', async () => {
            mockCreate.mockResolvedValueOnce({ choices: [] });

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result).toBe('');
        });
    });
});
