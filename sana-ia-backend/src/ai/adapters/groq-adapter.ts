import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import { LlmGenerationResult, LlmProviderPort, LlmTokenUsage } from '../ports/llm-provider.port';
import { ModelTier, MODEL_TIER_FAST, MODEL_TIER_MID, MODEL_TIER_PRO } from '../config/model-tiers.config';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { classifyGeminiError } from '../utils/error-classifier';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';
import { isMultimodalPrompt, partsToOpenAiContent } from '../utils/multimodal.util';

/**
 * Groq Adapter — implements LlmProviderPort for Groq's LPU-based inference.
 *
 * Groq SDK is OpenAI-compatible, so this mirrors GeminiClientService structure:
 * tier-based model selection, timeout per tier, retry with exponential backoff,
 * error classification, and AppException on terminal failure.
 */
@Injectable()
export class GroqAdapter implements LlmProviderPort {
  private readonly logger = new Logger(GroqAdapter.name);
  private readonly client: Groq;

  // Model tier mapping (Groq-specific)
  private readonly modelFast: string;
  private readonly modelMid: string;
  private readonly modelSlow: string;
  private readonly modelVision: string;

  // Timeout config (reuse from Gemini config for consistency)
  private readonly timeoutFastMs: number;
  private readonly timeoutSlowMs: number;

  // Retry config
  private readonly retryMax: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GROQ_API_KEY');
    if (!apiKey) {
      this.logger.warn('GROQ_API_KEY not configured — GroqAdapter will not function.');
    }
    this.client = new Groq({ apiKey: apiKey ?? '' });

    // Model resolution from config — Groq has its own model names (llama-3.3-70b-versatile),
    // distinct from the Gemini model names ('modelCollecting' etc) in the same config namespace.
    const cfg = this.configService.get<Record<string, unknown>>('aiModels') ?? {};
    this.modelFast = (cfg['groqModelCollecting'] as string | undefined) ?? 'llama-3.3-70b-versatile';
    this.modelMid = (cfg['groqModelAnalyzing'] as string | undefined) ?? 'llama-3.3-70b-versatile';
    this.modelSlow = (cfg['groqModelCompleted'] as string | undefined) ?? 'llama-3.3-70b-versatile';
    // Vision model for multimodal (OCR) prompts. llama-3.3-70b is text-only;
    // qwen3.6-27b is Groq's currently-supported multimodal model
    // (llama-3.2-*-vision-preview and llama-4-scout are deprecated/decommissioned).
    this.modelVision = (cfg['groqModelVision'] as string | undefined) ?? 'qwen/qwen3.6-27b';

    // Reuse timeout from Gemini config for consistency
    this.timeoutFastMs = (cfg['timeoutFastMs'] as number | undefined) ?? 8000;
    this.timeoutSlowMs = (cfg['timeoutSlowMs'] as number | undefined) ?? 25000;

    this.retryMax = (cfg['groqRetryMax'] as number | undefined) ?? 0;
    this.retryBaseMs = (cfg['retryBaseMs'] as number | undefined) ?? 500;
    this.retryCapMs = (cfg['retryCapMs'] as number | undefined) ?? 4000;
  }

  async generateWithResilience(tier: ModelTier, prompt: string | any[]): Promise<LlmGenerationResult> {
    // Multimodal prompts need a vision-capable model regardless of tier,
    // and always get the slow timeout budget (image processing is not fast-tier work).
    const multimodal = isMultimodalPrompt(prompt);
    const modelName = multimodal ? this.modelVision : this.resolveModelName(tier);
    const timeoutMs = multimodal ? this.timeoutSlowMs : this.resolveTimeout(tier);

    let lastKind: GeminiErrorKind = GeminiErrorKind.UNKNOWN;
    let attempt = 0;

    while (attempt <= this.retryMax) {
      const isRetry = attempt > 0;

      if (isRetry) {
        const backoff = this.computeBackoff(attempt);
        this.logger.warn(
          `Retrying Groq call (attempt ${attempt}/${this.retryMax}) after ${backoff}ms — kind: ${lastKind}`,
        );
        await this.sleep(backoff);
      }

      try {
        const { text, usage } = await this.callWithTimeout(modelName, prompt, timeoutMs);
        return { text, usage, model: modelName };
      } catch (err: unknown) {
        const kind = this.classifyError(err);
        lastKind = kind;

        const errDetail = this.extractErrorDetail(err);
        this.logger.error(
          `Groq error on attempt ${attempt} — kind: ${kind}, model: ${modelName}, ` +
          `status: ${errDetail.status}, message: ${errDetail.message}`,
        );
        if (errDetail.raw) {
          this.logger.error(`Groq raw error detail: ${errDetail.raw}`);
        }

        // Retry only RATE_LIMITED and UNAVAILABLE
        const RETRYABLE = new Set([GeminiErrorKind.RATE_LIMITED, GeminiErrorKind.UNAVAILABLE]);
        if (!RETRYABLE.has(kind) || attempt >= this.retryMax) {
          throw this.toAppException(kind, attempt);
        }

        attempt++;
      }
    }

    throw this.toAppException(lastKind, attempt);
  }

  getName(): string {
    return 'groq';
  }

  supportsVision(): boolean {
    return true; // via the configured vision model (qwen/qwen3.6-27b by default)
  }

  // ========== Private helpers ==========

  private resolveModelName(tier: ModelTier): string {
    if (tier === MODEL_TIER_FAST) return this.modelFast;
    if (tier === MODEL_TIER_MID) return this.modelMid;
    if (tier === MODEL_TIER_PRO) return this.modelSlow;
    return this.modelFast;
  }

  private resolveTimeout(tier: ModelTier): number {
    if (tier === MODEL_TIER_PRO) return this.timeoutSlowMs;
    return this.timeoutFastMs;
  }

  private async callWithTimeout(
    modelName: string,
    prompt: string | any[],
    timeoutMs: number,
  ): Promise<{ text: string; usage: LlmTokenUsage }> {
    // Gemini Part[] prompts must be converted to OpenAI-style content
    // ({type:'text'} / {type:'image_url'}) — Groq rejects Gemini's raw shape.
    const messages: any[] =
      typeof prompt === 'string'
        ? [{ role: 'user', content: prompt }]
        : [{ role: 'user', content: partsToOpenAiContent(prompt) }];

    const racePromise = Promise.race([
      this.client.chat.completions.create({
        model: modelName,
        messages,
        temperature: 1, // For consistency with Gemini's sampling
        response_format: { type: 'json_object' },
      }),
      this.timeoutPromise(timeoutMs),
    ]);

    const completion = (await racePromise) as any;
    const text = completion.choices[0]?.message?.content ?? '';

    if (!completion.usage) {
      this.logger.warn('Groq response missing usage — cost tracking will be inaccurate for this call');
    }
    const usage: LlmTokenUsage = {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
    };

    return { text, usage };
  }

  /**
   * Delegates to the shared classifyGeminiError (duck-types on __kind sentinel,
   * status/statusCode/httpStatus, and message patterns — works for plain
   * objects AND Error instances, which is what the Groq SDK's APIError is).
   */
  private classifyError(err: unknown): GeminiErrorKind {
    return classifyGeminiError(err);
  }

  private toAppException(kind: GeminiErrorKind, attempt: number): AppException {
    const messages: Record<GeminiErrorKind, { code: ErrorCode; message: string; publicMessage: string }> = {
      [GeminiErrorKind.RATE_LIMITED]: {
        code: ErrorCode.AI_RATE_LIMITED,
        message: `Groq rate limited after ${attempt} attempts. Please try again in a moment.`,
        publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.TIMEOUT]: {
        code: ErrorCode.AI_TIMEOUT,
        message: `Groq request timed out after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA tardó demasiado. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.UNAVAILABLE]: {
        code: ErrorCode.AI_UNAVAILABLE,
        message: `Groq service temporarily unavailable after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.POLICY_BLOCK]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `Groq policy violation after ${attempt} attempts.`,
        publicMessage: 'Error interno en el servicio de IA.',
      },
      [GeminiErrorKind.PARSE]: {
        code: ErrorCode.AI_PARSE_FAILED,
        message: `Groq response format error after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA no pudo procesar la respuesta. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.UNKNOWN]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `Groq error after ${attempt} attempts.`,
        publicMessage: 'Error interno en el servicio de IA.',
      },
    };

    const { code, message, publicMessage } = messages[kind];
    return new AppException({
      errorCode: code,
      message,
      statusCode: 500,
      publicMessage,
    });
  }

  private computeBackoff(attempt: number): number {
    const exponential = this.retryBaseMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * exponential;
    return Math.min(exponential + jitter, this.retryCapMs);
  }

  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(
        () => reject({ __kind: GeminiErrorKind.TIMEOUT, message: `Groq call timed out after ${ms}ms` }),
        ms,
      );
    });
  }

  /**
   * Extract structured detail from any error shape for rich logging.
   * Handles: Groq SDK APIError, plain Error, timeout sentinel objects.
   */
  private extractErrorDetail(err: unknown): { status: string; message: string; raw?: string } {
    if (!err) return { status: 'N/A', message: 'null/undefined error' };

    const e = err as any;
    const status = e.status ?? e.statusCode ?? e.httpStatus ?? 'N/A';
    const message = e.message ?? String(err);
    // Capture first 500 chars of the raw error body (Groq SDK exposes .error or .body)
    let raw: string | undefined;
    try {
      const body = e.error ?? e.body ?? e.response?.data;
      if (body) {
        raw = typeof body === 'string' ? body.substring(0, 500) : JSON.stringify(body).substring(0, 500);
      }
    } catch { /* ignore serialization errors */ }

    return { status: String(status), message: message.substring(0, 300), raw };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
