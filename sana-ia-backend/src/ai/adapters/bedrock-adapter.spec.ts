import { ConfigService } from '@nestjs/config';
import { BedrockAdapter } from './bedrock-adapter';
import { AppException } from '../../common/exceptions/app-exception';
import { MODEL_TIER_FAST, MODEL_TIER_PRO } from '../config/model-tiers.config';

/**
 * Minimal mock for @aws-sdk/client-bedrock-runtime.
 * Mirrors the pattern used in groq-adapter.spec.ts.
 */
jest.mock('@aws-sdk/client-bedrock-runtime', () => {
    const mockSend = jest.fn();
    function BedrockRuntimeClientMock() {
        return { send: mockSend };
    }
    function ConverseCommandMock(input: unknown) {
        return { input };
    }

    return {
        __esModule: true,
        BedrockRuntimeClient: BedrockRuntimeClientMock,
        ConverseCommand: ConverseCommandMock,
        __mockSend: mockSend,
    };
});

const { __mockSend: mockSend } = jest.requireMock('@aws-sdk/client-bedrock-runtime');

function createConfigService(overrides: Record<string, unknown> = {}): ConfigService {
    const defaults: Record<string, unknown> = {
        AWS_REGION: 'us-east-1',
        aiModels: {
            bedrockModelCollecting: 'us.amazon.nova-micro-v1:0',
            bedrockModelAnalyzing: 'us.amazon.nova-micro-v1:0',
            bedrockModelCompleted: 'us.amazon.nova-lite-v1:0',
            bedrockModelVision: 'us.amazon.nova-lite-v1:0',
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

/** Builds a successful Converse API response shape. */
function converseResponse(text: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }) {
    return {
        output: { message: { content: [{ text }] } },
        usage,
    };
}

/** AWS SDK service exceptions carry a `name` and `$metadata.httpStatusCode`. */
function awsError(name: string, httpStatusCode: number): Error {
    const err = new Error(name);
    err.name = name;
    (err as any).$metadata = { httpStatusCode };
    return err;
}

describe('BedrockAdapter', () => {
    let adapter: BedrockAdapter;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
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

    describe('generateWithResilience', () => {
        it('returns text, usage and model on a successful call', async () => {
            mockSend.mockResolvedValueOnce(
                converseResponse('respuesta de nova', { inputTokens: 120, outputTokens: 45, totalTokens: 165 }),
            );

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test prompt');

            expect(result.text).toBe('respuesta de nova');
            expect(result.model).toBe('us.amazon.nova-micro-v1:0');
            expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 45, totalTokens: 165 });
        });

        it('sends string prompts as a single text content block', async () => {
            mockSend.mockResolvedValueOnce(converseResponse('ok'));

            await adapter.generateWithResilience(MODEL_TIER_FAST, 'hola nova');

            const [command] = mockSend.mock.calls[0];
            expect(command.input).toEqual(
                expect.objectContaining({
                    modelId: 'us.amazon.nova-micro-v1:0',
                    messages: [{ role: 'user', content: [{ text: 'hola nova' }] }],
                }),
            );
        });

        it('converts Gemini Part[] prompts to Converse image blocks and uses the vision model', async () => {
            mockSend.mockResolvedValueOnce(converseResponse('{"biomarkers":[]}'));

            const parts = [
                { text: 'extrae biomarcadores' },
                { inlineData: { data: Buffer.from('img-bytes').toString('base64'), mimeType: 'image/png' } },
            ];
            const result = await adapter.generateWithResilience(MODEL_TIER_PRO, parts);

            expect(result.text).toBe('{"biomarkers":[]}');
            const [command] = mockSend.mock.calls[0];
            expect(command.input.modelId).toBe('us.amazon.nova-lite-v1:0');
            expect(command.input.messages[0].content).toEqual([
                { text: 'extrae biomarcadores' },
                {
                    image: {
                        format: 'png',
                        source: { bytes: Buffer.from('img-bytes') },
                    },
                },
            ]);
        });

        it('retries once on ThrottlingException and succeeds on the second attempt', async () => {
            mockSend
                .mockRejectedValueOnce(awsError('ThrottlingException', 429))
                .mockResolvedValueOnce(converseResponse('recovered'));

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.text).toBe('recovered');
            expect(mockSend).toHaveBeenCalledTimes(2);
        });

        it('retries on ServiceUnavailableException', async () => {
            mockSend
                .mockRejectedValueOnce(awsError('ServiceUnavailableException', 503))
                .mockResolvedValueOnce(converseResponse('back online'));

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.text).toBe('back online');
        });

        it('exhausts retries and throws AppException on persistent throttling', async () => {
            mockSend
                .mockRejectedValueOnce(awsError('ThrottlingException', 429))
                .mockRejectedValueOnce(awsError('ThrottlingException', 429));

            await expect(adapter.generateWithResilience(MODEL_TIER_FAST, 'test')).rejects.toThrow(
                AppException,
            );
            // bedrockRetryMax=1 → 1 initial + 1 retry = 2 attempts total
            expect(mockSend).toHaveBeenCalledTimes(2);
        });

        it('does not retry a non-transient error (ValidationException)', async () => {
            mockSend.mockRejectedValueOnce(awsError('ValidationException', 400));

            await expect(adapter.generateWithResilience(MODEL_TIER_FAST, 'test')).rejects.toThrow(
                AppException,
            );
            expect(mockSend).toHaveBeenCalledTimes(1);
        });

        it('uses the completed-tier model for MODEL_TIER_PRO text prompts', async () => {
            mockSend.mockResolvedValueOnce(converseResponse('pro result'));

            const result = await adapter.generateWithResilience(MODEL_TIER_PRO, 'test');
            expect(result.text).toBe('pro result');
            const [command] = mockSend.mock.calls[0];
            expect(command.input.modelId).toBe('us.amazon.nova-lite-v1:0');
        });

        it('defaults usage to zeros (with a warning) when the response has no usage block', async () => {
            mockSend.mockResolvedValueOnce(converseResponse('sin usage'));

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        });

        it('returns empty text when the response has no content', async () => {
            mockSend.mockResolvedValueOnce({ output: { message: { content: [] } } });

            const result = await adapter.generateWithResilience(MODEL_TIER_FAST, 'test');
            expect(result.text).toBe('');
        });
    });
});
