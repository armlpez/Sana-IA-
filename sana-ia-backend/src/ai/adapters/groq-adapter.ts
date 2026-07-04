import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import { LlmProviderPort } from '../ports/llm-provider.port';
import { ModelTier, MODEL_TIER_FAST, MODEL_TIER_MID, MODEL_TIER_PRO } from '../config/model-tiers.config';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { classifyGeminiError } from '../utils/error-classifier';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';

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

    // Reuse timeout from Gemini config for consistency
    this.timeoutFastMs = (cfg['timeoutFastMs'] as number | undefined) ?? 8000;
    this.timeoutSlowMs = (cfg['timeoutSlowMs'] as number | undefined) ?? 25000;

    this.retryMax = (cfg['groqRetryMax'] as number | undefined) ?? 0;
    this.retryBaseMs = (cfg['retryBaseMs'] as number | undefined) ?? 500;
    this.retryCapMs = (cfg['retryCapMs'] as number | undefined) ?? 4000;
  }

  async generateWithResilience(tier: ModelTier, prompt: string | any[]): Promise<string> {
    const modelName = this.resolveModelName(tier);
    const timeoutMs = this.resolveTimeout(tier);

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
        const response = await this.callWithTimeout(modelName, prompt, timeoutMs);
        return response;
      } catch (err: unknown) {
        const kind = this.classifyError(err);
        lastKind = kind;

        this.logger.error(
          `Groq error on attempt ${attempt} — kind: ${kind}, model: ${modelName}`,
        );

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

  private async callWithTimeout(modelName: string, prompt: string | any[], timeoutMs: number): Promise<string> {
    const messages: any[] =
      typeof prompt === 'string'
        ? [{ role: 'user', content: prompt }]
        : [{ role: 'user', content: prompt as any }];

    const racePromise = Promise.race([
      this.client.chat.completions.create({
        model: modelName,
        messages,
        temperature: 1, // For consistency with Gemini's sampling
      }),
      this.timeoutPromise(timeoutMs),
    ]);

    const completion = (await racePromise) as any;
    const text = completion.choices[0]?.message?.content ?? '';
    return text;
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
    const messages: Record<GeminiErrorKind, { code: ErrorCode; message: string }> = {
      [GeminiErrorKind.RATE_LIMITED]: {
        code: ErrorCode.AI_RATE_LIMITED,
        message: `Groq rate limited after ${attempt} attempts. Please try again in a moment.`,
      },
      [GeminiErrorKind.TIMEOUT]: {
        code: ErrorCode.AI_TIMEOUT,
        message: `Groq request timed out after ${attempt} attempts.`,
      },
      [GeminiErrorKind.UNAVAILABLE]: {
        code: ErrorCode.AI_UNAVAILABLE,
        message: `Groq service temporarily unavailable after ${attempt} attempts.`,
      },
      [GeminiErrorKind.POLICY_BLOCK]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `Groq policy violation after ${attempt} attempts.`,
      },
      [GeminiErrorKind.PARSE]: {
        code: ErrorCode.AI_PARSE_FAILED,
        message: `Groq response format error after ${attempt} attempts.`,
      },
      [GeminiErrorKind.UNKNOWN]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `Groq error after ${attempt} attempts.`,
      },
    };

    const { code, message } = messages[kind];
    return new AppException({
      errorCode: code,
      message,
      statusCode: 500,
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
