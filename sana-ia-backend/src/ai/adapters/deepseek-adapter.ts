import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProviderPort } from '../ports/llm-provider.port';
import { ModelTier, MODEL_TIER_FAST, MODEL_TIER_MID, MODEL_TIER_PRO } from '../config/model-tiers.config';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { classifyGeminiError } from '../utils/error-classifier';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * DeepSeek Adapter — implements LlmProviderPort for DeepSeek's OpenAI-compatible REST API.
 *
 * Uses native fetch (Node >= 18) instead of adding another SDK dependency — DeepSeek's
 * API surface is a plain chat/completions POST, identical in shape to OpenAI/Groq.
 *
 * Mirrors GeminiClientService/GroqAdapter structure: tier-based model selection,
 * per-tier timeout, retry with exponential backoff on transient errors only.
 */
@Injectable()
export class DeepSeekAdapter implements LlmProviderPort {
  private readonly logger = new Logger(DeepSeekAdapter.name);
  private readonly apiKey: string;

  // Model tier mapping (DeepSeek-specific — deepseek-chat/deepseek-reasoner are
  // deprecated 2026-07-24, so we go straight to the v4 model line).
  private readonly modelFast: string;
  private readonly modelMid: string;
  private readonly modelSlow: string;

  private readonly timeoutFastMs: number;
  private readonly timeoutSlowMs: number;

  private readonly retryMax: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('DEEPSEEK_API_KEY') ?? '';
    if (!this.apiKey) {
      this.logger.warn('DEEPSEEK_API_KEY not configured — DeepSeekAdapter will not function.');
    }

    const cfg = this.configService.get<Record<string, unknown>>('aiModels') ?? {};
    this.modelFast = (cfg['deepseekModelCollecting'] as string | undefined) ?? 'deepseek-v4-flash';
    this.modelMid = (cfg['deepseekModelAnalyzing'] as string | undefined) ?? 'deepseek-v4-flash';
    this.modelSlow = (cfg['deepseekModelCompleted'] as string | undefined) ?? 'deepseek-v4-pro';

    this.timeoutFastMs = (cfg['timeoutFastMs'] as number | undefined) ?? 8000;
    this.timeoutSlowMs = (cfg['timeoutSlowMs'] as number | undefined) ?? 25000;

    this.retryMax = (cfg['deepseekRetryMax'] as number | undefined) ?? 0;
    this.retryBaseMs = (cfg['retryBaseMs'] as number | undefined) ?? 500;
    this.retryCapMs = (cfg['retryCapMs'] as number | undefined) ?? 4000;
  }

  async generateWithResilience(tier: ModelTier, prompt: string | any[]): Promise<string> {
    const modelName = this.resolveModelName(tier);
    const timeoutMs = this.resolveTimeout(tier);

    let lastKind: GeminiErrorKind = GeminiErrorKind.UNKNOWN;
    let attempt = 0;

    while (attempt <= this.retryMax) {
      if (attempt > 0) {
        const backoff = this.computeBackoff(attempt);
        this.logger.warn(
          `Retrying DeepSeek call (attempt ${attempt}/${this.retryMax}) after ${backoff}ms — kind: ${lastKind}`,
        );
        await this.sleep(backoff);
      }

      try {
        return await this.callWithTimeout(modelName, prompt, timeoutMs);
      } catch (err: unknown) {
        const kind = this.classifyError(err);
        lastKind = kind;

        this.logger.error(`DeepSeek error on attempt ${attempt} — kind: ${kind}, model: ${modelName}`);

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
    return 'deepseek';
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
    const content = typeof prompt === 'string' ? prompt : this.flattenPromptParts(prompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content }],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const httpError = new Error(`DeepSeek HTTP ${res.status}: ${errBody.substring(0, 200)}`);
        (httpError as any).status = res.status;
        throw httpError;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * DeepSeek's chat/completions endpoint is text-only (no multimodal image parts,
   * unlike Gemini Vision). If a Part[] prompt (used for OCR) reaches this adapter,
   * flatten to text-only content — image parts are dropped with a warning.
   */
  private flattenPromptParts(parts: any[]): string {
    const textParts = parts
      .filter((p) => typeof p?.text === 'string')
      .map((p) => p.text);

    if (textParts.length !== parts.length) {
      this.logger.warn('DeepSeek does not support image parts — non-text parts were dropped from the prompt.');
    }

    return textParts.join('\n');
  }

  /**
   * fetch's AbortController rejects with a DOMException named 'AbortError' —
   * that doesn't carry a __kind sentinel or HTTP status, so it's special-cased
   * here before delegating the rest (429/503, policy block, message patterns)
   * to the shared classifyGeminiError.
   */
  private classifyError(err: unknown): GeminiErrorKind {
    if (err instanceof Error && err.name === 'AbortError') {
      return GeminiErrorKind.TIMEOUT;
    }
    return classifyGeminiError(err);
  }

  private toAppException(kind: GeminiErrorKind, attempt: number): AppException {
    const messages: Record<GeminiErrorKind, { code: ErrorCode; message: string }> = {
      [GeminiErrorKind.RATE_LIMITED]: {
        code: ErrorCode.AI_RATE_LIMITED,
        message: `DeepSeek rate limited after ${attempt} attempts. Please try again in a moment.`,
      },
      [GeminiErrorKind.TIMEOUT]: {
        code: ErrorCode.AI_TIMEOUT,
        message: `DeepSeek request timed out after ${attempt} attempts.`,
      },
      [GeminiErrorKind.UNAVAILABLE]: {
        code: ErrorCode.AI_UNAVAILABLE,
        message: `DeepSeek service temporarily unavailable after ${attempt} attempts.`,
      },
      [GeminiErrorKind.POLICY_BLOCK]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `DeepSeek policy violation after ${attempt} attempts.`,
      },
      [GeminiErrorKind.PARSE]: {
        code: ErrorCode.AI_PARSE_FAILED,
        message: `DeepSeek response format error after ${attempt} attempts.`,
      },
      [GeminiErrorKind.UNKNOWN]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `DeepSeek error after ${attempt} attempts.`,
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
