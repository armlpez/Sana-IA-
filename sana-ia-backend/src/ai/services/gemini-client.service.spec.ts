import { ConfigService } from '@nestjs/config';
import { GeminiClientService } from './gemini-client.service';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { AppException } from '../../common/exceptions/app-exception';
import { MODEL_TIER_FAST, MODEL_TIER_PRO } from '../config/model-tiers.config';

/**
 * Minimal mock for GoogleGenerativeAI and GenerativeModel.
 * We need to mock the module so the constructor doesn't try to init the real SDK.
 */
jest.mock('@google/generative-ai', () => {
    const mockGenerateContent = jest.fn();
    const mockGetGenerativeModel = jest.fn(() => ({
        generateContent: mockGenerateContent,
    }));

    return {
        GoogleGenerativeAI: jest.fn(() => ({
            getGenerativeModel: mockGetGenerativeModel,
        })),
        __mockGenerateContent: mockGenerateContent,
        __mockGetGenerativeModel: mockGetGenerativeModel,
    };
});

// Access the mock functions after jest.mock hoisting
const {
    __mockGenerateContent: mockGenerateContent,
} = jest.requireMock('@google/generative-ai');

function createConfigService(overrides: Record<string, unknown> = {}): ConfigService {
    const defaults: Record<string, unknown> = {
        GEMINI_API_KEY: 'test-key',
        aiModels: {
            modelCollecting: 'gemini-2.0-flash-lite',
            modelAnalyzing: 'gemini-2.0-flash',
            modelCompleted: 'gemini-1.5-pro',
            timeoutFastMs: 200,  // Very short for tests
            timeoutSlowMs: 500,
            retryMax: 1,
            retryBaseMs: 10,
            retryCapMs: 50,
        },
        ...overrides,
    };

    return {
        get: jest.fn((key: string) => defaults[key]),
    } as unknown as ConfigService;
}

describe('GeminiClientService', () => {
    let service: GeminiClientService;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        service = new GeminiClientService(createConfigService());
    });

    afterEach(() => {
        // Clear any pending timers (e.g., from Promise.race timeout guards)
        jest.clearAllTimers();
    });

    describe('generateWithResilience', () => {
        it('should return raw text on successful SDK call', async () => {
            mockGenerateContent.mockResolvedValueOnce({
                response: { text: () => '{"result": "ok"}' },
            });

            const result = await service.generateWithResilience(MODEL_TIER_FAST, 'test prompt');
            expect(result).toBe('{"result": "ok"}');
        });

        it('should throw AppException on timeout (no indefinite hang)', async () => {
            // Mock SDK to never resolve (simulates a hang)
            mockGenerateContent.mockImplementationOnce(
                () => new Promise(() => { /* never resolves */ }),
            );

            await expect(
                service.generateWithResilience(MODEL_TIER_FAST, 'test'),
            ).rejects.toThrow(AppException);
        }, 10_000);

        it('should retry on 429 and succeed on second attempt', async () => {
            const rateLimitedError: Record<string, unknown> = {
                status: 429,
                message: 'Too Many Requests',
            };

            mockGenerateContent
                .mockRejectedValueOnce(rateLimitedError)
                .mockResolvedValueOnce({
                    response: { text: () => 'success after retry' },
                });

            const result = await service.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result).toBe('success after retry');
            expect(mockGenerateContent).toHaveBeenCalledTimes(2);
        });

        it('should retry on 503 and succeed on second attempt', async () => {
            const unavailableError: Record<string, unknown> = {
                status: 503,
                message: 'Service Unavailable',
            };

            mockGenerateContent
                .mockRejectedValueOnce(unavailableError)
                .mockResolvedValueOnce({
                    response: { text: () => 'recovered' },
                });

            const result = await service.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result).toBe('recovered');
        });

        it('should NOT retry on parse errors', async () => {
            const parseError: Record<string, unknown> = {
                __kind: GeminiErrorKind.PARSE,
                message: 'bad json',
            };

            mockGenerateContent.mockRejectedValueOnce(parseError);

            await expect(
                service.generateWithResilience(MODEL_TIER_FAST, 'test'),
            ).rejects.toThrow(AppException);

            // Only 1 call — no retry for parse errors
            expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        });

        it('should NOT retry on timeout errors', async () => {
            const timeoutError: Record<string, unknown> = {
                __kind: GeminiErrorKind.TIMEOUT,
                message: 'timed out',
            };

            mockGenerateContent.mockRejectedValueOnce(timeoutError);

            await expect(
                service.generateWithResilience(MODEL_TIER_FAST, 'test'),
            ).rejects.toThrow(AppException);

            expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        });

        it('should exhaust retries and throw AppException', async () => {
            const rateLimitedError: Record<string, unknown> = {
                status: 429,
                message: 'Too Many Requests',
            };

            // retryMax=1 → 1 initial + 1 retry = 2 attempts total
            mockGenerateContent
                .mockRejectedValueOnce(rateLimitedError)
                .mockRejectedValueOnce(rateLimitedError);

            await expect(
                service.generateWithResilience(MODEL_TIER_FAST, 'test'),
            ).rejects.toThrow(AppException);

            expect(mockGenerateContent).toHaveBeenCalledTimes(2);
        });

        it('should use the pro tier model for MODEL_TIER_PRO', async () => {
            mockGenerateContent.mockResolvedValueOnce({
                response: { text: () => 'pro result' },
            });

            await service.generateWithResilience(MODEL_TIER_PRO, 'test');
            expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        });
    });
});
