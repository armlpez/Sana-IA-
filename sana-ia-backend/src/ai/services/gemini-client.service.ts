import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpStatus } from '@nestjs/common';
import {
    GoogleGenerativeAI,
    GenerativeModel,
    Part
} from '@google/generative-ai';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { classifyGeminiError } from '../utils/error-classifier';
import { ModelTier, MODEL_TIER_FAST, MODEL_TIER_MID } from '../config/model-tiers.config';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';
import { LlmGenerationResult, LlmTokenUsage } from '../ports/llm-provider.port';

/**
 * The set of GeminiErrorKinds that are transient and eligible for retry.
 * Timeout, parse failures, policy blocks, and unknown errors are NOT retried.
 */
const RETRYABLE_KINDS = new Set<GeminiErrorKind>([
    GeminiErrorKind.RATE_LIMITED,
    GeminiErrorKind.UNAVAILABLE,
]);

/**
 * GeminiClientService — single injectable that owns all Gemini SDK interactions.
 *
 * Responsibilities:
 *   - Tier-based model selection (from aiModels config).
 *   - Per-tier timeout via SDK RequestOptions.timeout + Promise.race guard.
 *   - Exponential-backoff retry with full jitter for RATE_LIMITED / UNAVAILABLE only.
 *   - Error classification via classifyGeminiError.
 *   - Throws AppException on terminal failure so callers use SafeFallbackBuilder.
 *
 * AiService and ChatService MUST use this service; neither should construct
 * GoogleGenerativeAI instances directly.
 */
@Injectable()
export class GeminiClientService {
    private readonly logger = new Logger(GeminiClientService.name);

    /** Lazily-built model instances, keyed by model name. Thread-safe (Node.js single-threaded). */
    private readonly modelCache = new Map<string, GenerativeModel>();

    private readonly genAI: GoogleGenerativeAI;

    // Tier config resolved at construction time
    private readonly modelFast: string;
    private readonly modelMid: string;
    private readonly modelSlow: string;
    private readonly timeoutFastMs: number;
    private readonly timeoutSlowMs: number;
    private readonly retryMax: number;
    private readonly retryBaseMs: number;
    private readonly retryCapMs: number;

    constructor(private readonly configService: ConfigService) {
        const apiKey = this.configService.get<string>('GEMINI_API_KEY');
        if (!apiKey) {
            this.logger.warn('GEMINI_API_KEY not configured — GeminiClientService will not function.');
        }
        this.genAI = new GoogleGenerativeAI(apiKey ?? '');

        const cfg = this.configService.get<Record<string, unknown>>('aiModels') ?? {};

        this.modelFast = (cfg['modelCollecting'] as string | undefined) ?? 'gemini-2.0-flash-lite';
        this.modelMid = (cfg['modelAnalyzing'] as string | undefined) ?? 'gemini-2.0-flash';
        this.modelSlow = (cfg['modelCompleted'] as string | undefined) ?? 'gemini-1.5-pro';

        this.timeoutFastMs = (cfg['timeoutFastMs'] as number | undefined) ?? 8000;
        this.timeoutSlowMs = (cfg['timeoutSlowMs'] as number | undefined) ?? 25000;

        this.retryMax = (cfg['retryMax'] as number | undefined) ?? 2;
        this.retryBaseMs = (cfg['retryBaseMs'] as number | undefined) ?? 500;
        this.retryCapMs = (cfg['retryCapMs'] as number | undefined) ?? 4000;
    }

    /**
     * Wraps `model.generateContent(prompt)` with:
     *   - tier-based model selection
     *   - per-tier timeout (SDK timeout option + Promise.race fallback)
     *   - retry with exponential backoff + jitter for transient errors only
     *   - error classification
     *
     * Returns the raw text plus token usage/model name from the model response on success.
     * Throws AppException on terminal (non-retryable or exhausted) failure.
     */
    async generateWithResilience(tier: ModelTier, prompt: string | Part[]): Promise<LlmGenerationResult> {
        const modelName = this.resolveModelName(tier);
        const timeoutMs = this.resolveTimeout(tier);
        const model = this.getOrCreateModel(modelName);

        let lastKind: GeminiErrorKind = GeminiErrorKind.UNKNOWN;
        let attempt = 0;

        while (attempt <= this.retryMax) {
            const isRetry = attempt > 0;

            if (isRetry) {
                const backoff = this.computeBackoff(attempt);
                this.logger.warn(
                    `Retrying Gemini call (attempt ${attempt}/${this.retryMax}) after ${backoff}ms — kind: ${lastKind}`,
                );
                await this.sleep(backoff);
            }

            try {
                const { text, usage } = await this.callWithTimeout(model, prompt, timeoutMs);
                return { text, usage, model: modelName };
            } catch (err: unknown) {
                const kind = classifyGeminiError(err);
                lastKind = kind;

                const errDetail = this.extractErrorDetail(err);
                this.logger.error(
                    `Gemini error on attempt ${attempt} — kind: ${kind}, model: ${modelName}, ` +
                    `status: ${errDetail.status}, message: ${errDetail.message}`,
                );
                if (errDetail.raw) {
                    this.logger.error(`Gemini raw error detail: ${errDetail.raw}`);
                }

                if (!RETRYABLE_KINDS.has(kind) || attempt >= this.retryMax) {
                    throw this.toAppException(kind, attempt);
                }

                attempt++;
            }
        }

        // Should be unreachable, but satisfies TypeScript
        throw this.toAppException(lastKind, attempt);
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private resolveModelName(tier: ModelTier): string {
        if (tier === MODEL_TIER_FAST) return this.modelFast;
        if (tier === MODEL_TIER_MID) return this.modelMid;
        return this.modelSlow;
    }

    private resolveTimeout(tier: ModelTier): number {
        return tier === MODEL_TIER_FAST || tier === MODEL_TIER_MID
            ? this.timeoutFastMs
            : this.timeoutSlowMs;
    }

    /**
     * Returns a cached GenerativeModel for the given model name.
     * Models are stateless and safe to reuse across requests.
     */
    private getOrCreateModel(modelName: string): GenerativeModel {
        const cached = this.modelCache.get(modelName);
        if (cached) return cached;

        const model = this.genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.3,
            },
        });

        this.modelCache.set(modelName, model);
        return model;
    }

    /**
     * Calls generateContent with the SDK timeout option.
     * Also races against a manual timer as a portability guard.
     */
    private async callWithTimeout(
        model: GenerativeModel,
        prompt: string | Part[],
        timeoutMs: number,
    ): Promise<{ text: string; usage: LlmTokenUsage }> {
        const timeoutError: Record<string, unknown> = {
            __kind: GeminiErrorKind.TIMEOUT,
            message: `Gemini call timed out after ${timeoutMs}ms`,
        };

        const sdkCall = model.generateContent(prompt, { timeout: timeoutMs });

        const timeoutGuard = new Promise<never>((_, reject) =>
            setTimeout(() => reject(timeoutError), timeoutMs + 500), // small buffer so SDK fires first
        );

        const result = await Promise.race([sdkCall, timeoutGuard]);
        const text = result.response.text();

        const usageMetadata = result.response.usageMetadata;
        if (!usageMetadata) {
            this.logger.warn('Gemini response missing usageMetadata — cost tracking will be inaccurate for this call');
        }
        const usage: LlmTokenUsage = {
            promptTokens: usageMetadata?.promptTokenCount ?? 0,
            completionTokens: usageMetadata?.candidatesTokenCount ?? 0,
            totalTokens: usageMetadata?.totalTokenCount ?? 0,
        };

        return { text, usage };
    }

    /**
     * Full-jitter exponential backoff.
     * delay = random(0, min(cap, base * 2^attempt))
     */
    private computeBackoff(attempt: number): number {
        const ceiling = Math.min(this.retryCapMs, this.retryBaseMs * Math.pow(2, attempt));
        return Math.floor(Math.random() * ceiling);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Extract structured detail from any error shape for rich logging.
     * Handles: Gemini SDK GoogleGenerativeAIError, plain Error, timeout sentinel objects.
     */
    private extractErrorDetail(err: unknown): { status: string; message: string; raw?: string } {
        if (!err) return { status: 'N/A', message: 'null/undefined error' };

        const e = err as any;
        const status = e.status ?? e.statusCode ?? e.httpStatus ?? e.code ?? 'N/A';
        const message = e.message ?? String(err);
        // Gemini SDK errors may expose .errorDetails or .response
        let raw: string | undefined;
        try {
            const details = e.errorDetails ?? e.response?.data ?? e.cause;
            if (details) {
                raw = typeof details === 'string' ? details.substring(0, 500) : JSON.stringify(details).substring(0, 500);
            }
        } catch { /* ignore serialization errors */ }

        return { status: String(status), message: message.substring(0, 300), raw };
    }

    private toAppException(kind: GeminiErrorKind, attempt: number): AppException {
        const attemptInfo = `after ${attempt + 1} attempt(s)`;

        switch (kind) {
            case GeminiErrorKind.RATE_LIMITED:
                return new AppException({
                    errorCode: ErrorCode.AI_RATE_LIMITED,
                    message: `Gemini rate-limited ${attemptInfo}`,
                    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
                    publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
                });

            case GeminiErrorKind.UNAVAILABLE:
                return new AppException({
                    errorCode: ErrorCode.AI_UNAVAILABLE,
                    message: `Gemini unavailable ${attemptInfo}`,
                    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
                    publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
                });

            case GeminiErrorKind.TIMEOUT:
                return new AppException({
                    errorCode: ErrorCode.AI_TIMEOUT,
                    message: `Gemini timed out ${attemptInfo}`,
                    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
                    publicMessage: 'El servicio de IA tardó demasiado. Por favor, intentá de nuevo.',
                });

            case GeminiErrorKind.PARSE:
                return new AppException({
                    errorCode: ErrorCode.AI_PARSE_FAILED,
                    message: `Gemini parse failure ${attemptInfo}`,
                    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
                    publicMessage: 'El servicio de IA no pudo procesar la respuesta. Por favor, intentá de nuevo.',
                });

            default:
                return new AppException({
                    errorCode: ErrorCode.AI_SERVICE_ERROR,
                    message: `Gemini unknown error (kind=${kind}) ${attemptInfo}`,
                    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
                    publicMessage: 'Error interno en el servicio de IA.',
                });
        }
    }
}
