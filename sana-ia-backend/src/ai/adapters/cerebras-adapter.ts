import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmGenerationResult, LlmProviderPort, LlmTokenUsage } from '../ports/llm-provider.port';
import { ModelTier, MODEL_TIER_FAST, MODEL_TIER_MID, MODEL_TIER_PRO } from '../config/model-tiers.config';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { classifyGeminiError } from '../utils/error-classifier';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';

const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

/**
 * cerebras Adapter — implements LlmProviderPort for cerebras's OpenAI-compatible REST API.
 *
 * Uses native fetch (Node >= 18) instead of adding another SDK dependency — cerebras's
 * API surface is a plain chat/completions POST, identical in shape to OpenAI/Groq.
 *
 * Mirrors GeminiClientService/GroqAdapter structure: tier-based model selection,
 * per-tier timeout, retry with exponential backoff on transient errors only.
 */
@Injectable()
export class CerebrasAdapter implements LlmProviderPort {
  private readonly logger = new Logger(CerebrasAdapter.name);
  private readonly apiKey: string;

  // Model tier mapping (Cerebras-specific — text-only Llama/Qwen models).
  private readonly modelFast: string;
  private readonly modelMid: string;
  private readonly modelSlow: string;

  private readonly timeoutFastMs: number;
  private readonly timeoutSlowMs: number;

  private readonly retryMax: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;

  constructor(private readonly configService: ConfigService) {
    // CEREBRAS_API_KEY is canonical; cerebras_API_KEY kept for deployed .env compatibility
    this.apiKey =
      this.configService.get<string>('CEREBRAS_API_KEY') ??
      this.configService.get<string>('cerebras_API_KEY') ??
      '';
    if (!this.apiKey) {
      this.logger.warn('CEREBRAS_API_KEY not configured — CerebrasAdapter will not function.');
    }

    const cfg = this.configService.get<Record<string, unknown>>('aiModels') ?? {};
    // Defaults are real Cerebras model IDs — 'cerebras-v4-*' does not exist.
    this.modelFast = (cfg['cerebrasModelCollecting'] as string | undefined) ?? 'llama3.1-8b';
    this.modelMid = (cfg['cerebrasModelAnalyzing'] as string | undefined) ?? 'llama3.1-8b';
    this.modelSlow = (cfg['cerebrasModelCompleted'] as string | undefined) ?? 'llama-3.3-70b';

    this.timeoutFastMs = (cfg['timeoutFastMs'] as number | undefined) ?? 8000;
    this.timeoutSlowMs = (cfg['timeoutSlowMs'] as number | undefined) ?? 25000;

    this.retryMax = (cfg['cerebrasRetryMax'] as number | undefined) ?? 0;
    this.retryBaseMs = (cfg['retryBaseMs'] as number | undefined) ?? 500;
    this.retryCapMs = (cfg['retryCapMs'] as number | undefined) ?? 4000;
  }

  async generateWithResilience(tier: ModelTier, prompt: string | any[]): Promise<LlmGenerationResult> {
    const modelName = this.resolveModelName(tier);
    const timeoutMs = this.resolveTimeout(tier);

    let lastKind: GeminiErrorKind = GeminiErrorKind.UNKNOWN;
    let attempt = 0;

    while (attempt <= this.retryMax) {
      if (attempt > 0) {
        const backoff = this.computeBackoff(attempt);
        this.logger.warn(
          `Retrying cerebras call (attempt ${attempt}/${this.retryMax}) after ${backoff}ms — kind: ${lastKind}`,
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
          `cerebras error on attempt ${attempt} — kind: ${kind}, model: ${modelName}, ` +
          `status: ${errDetail.status}, message: ${errDetail.message}`,
        );
        if (errDetail.raw) {
          this.logger.error(`cerebras raw error detail: ${errDetail.raw}`);
        }

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
    return 'cerebras';
  }

  supportsVision(): boolean {
    return false; // Cerebras inference is text-only — no image input support
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
    const content = typeof prompt === 'string' ? prompt : this.flattenPromptParts(prompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
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
        const httpError = new Error(`cerebras HTTP ${res.status}: ${errBody.substring(0, 200)}`);
        (httpError as any).status = res.status;
        throw httpError;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const text = data.choices?.[0]?.message?.content ?? '';

      if (!data.usage) {
        this.logger.warn('cerebras response missing usage — cost tracking will be inaccurate for this call');
      }
      const usage: LlmTokenUsage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      };

      return { text, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * cerebras's chat/completions endpoint is text-only (no multimodal image parts,
   * unlike Gemini Vision). If a Part[] prompt (used for OCR) reaches this adapter,
   * flatten to text-only content — image parts are dropped with a warning.
   */
  private flattenPromptParts(parts: any[]): string {
    const textParts = parts
      .filter((p) => typeof p?.text === 'string')
      .map((p) => p.text);

    if (textParts.length !== parts.length) {
      this.logger.warn('cerebras does not support image parts — non-text parts were dropped from the prompt.');
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
    const messages: Record<GeminiErrorKind, { code: ErrorCode; message: string; publicMessage: string }> = {
      [GeminiErrorKind.RATE_LIMITED]: {
        code: ErrorCode.AI_RATE_LIMITED,
        message: `cerebras rate limited after ${attempt} attempts. Please try again in a moment.`,
        publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.TIMEOUT]: {
        code: ErrorCode.AI_TIMEOUT,
        message: `cerebras request timed out after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA tardó demasiado. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.UNAVAILABLE]: {
        code: ErrorCode.AI_UNAVAILABLE,
        message: `cerebras service temporarily unavailable after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.POLICY_BLOCK]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `cerebras policy violation after ${attempt} attempts.`,
        publicMessage: 'Error interno en el servicio de IA.',
      },
      [GeminiErrorKind.PARSE]: {
        code: ErrorCode.AI_PARSE_FAILED,
        message: `cerebras response format error after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA no pudo procesar la respuesta. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.UNKNOWN]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `cerebras error after ${attempt} attempts.`,
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

  /**
   * Extract structured detail from any error shape for rich logging.
   * Handles: fetch HTTP errors, AbortError, plain Error instances.
   */
  private extractErrorDetail(err: unknown): { status: string; message: string; raw?: string } {
    if (!err) return { status: 'N/A', message: 'null/undefined error' };

    const e = err as any;
    const status = e.status ?? e.statusCode ?? e.httpStatus ?? 'N/A';
    const message = e.message ?? String(err);
    // For fetch-based errors, the message already contains the body snippet
    // (we set it in callWithTimeout), but also check for .body/.cause
    let raw: string | undefined;
    try {
      const body = e.cause ?? e.body ?? e.response?.data;
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


