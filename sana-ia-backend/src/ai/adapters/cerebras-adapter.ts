import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmGenerationResult, LlmProviderPort, LlmTokenUsage } from '../ports/llm-provider.port';
import { ModelTier } from '../config/model-tiers.config';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { classifyGeminiError } from '../utils/error-classifier';
import { computeBackoff, sleep } from '../resilience/backoff.util';
import { extractErrorDetail } from '../resilience/error-detail.util';
import { buildAiProviderException } from '../resilience/exception.util';
import { resolveModelName, resolveTimeout } from '../resilience/model-resolution.util';

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
    const modelName = resolveModelName(tier, { fast: this.modelFast, mid: this.modelMid, slow: this.modelSlow });
    const timeoutMs = resolveTimeout(tier, { fastMs: this.timeoutFastMs, slowMs: this.timeoutSlowMs });

    let lastKind: GeminiErrorKind = GeminiErrorKind.UNKNOWN;
    let attempt = 0;

    while (attempt <= this.retryMax) {
      if (attempt > 0) {
        const backoff = computeBackoff(attempt, this.retryBaseMs, this.retryCapMs);
        this.logger.warn(
          `Retrying cerebras call (attempt ${attempt}/${this.retryMax}) after ${backoff}ms — kind: ${lastKind}`,
        );
        await sleep(backoff);
      }

      try {
        const { text, usage } = await this.callWithTimeout(modelName, prompt, timeoutMs);
        return { text, usage, model: modelName };
      } catch (err: unknown) {
        const kind = this.classifyError(err);
        lastKind = kind;

        const errDetail = extractErrorDetail(err);
        this.logger.error(
          `cerebras error on attempt ${attempt} — kind: ${kind}, model: ${modelName}, ` +
          `status: ${errDetail.status}, message: ${errDetail.message}`,
        );
        if (errDetail.raw) {
          this.logger.error(`cerebras raw error detail: ${errDetail.raw}`);
        }

        const RETRYABLE = new Set([GeminiErrorKind.RATE_LIMITED, GeminiErrorKind.UNAVAILABLE]);
        if (!RETRYABLE.has(kind) || attempt >= this.retryMax) {
          throw buildAiProviderException({ providerName: 'Cerebras', kind, attempt });
        }

        attempt++;
      }
    }

    throw buildAiProviderException({ providerName: 'Cerebras', kind: lastKind, attempt });
  }

  getName(): string {
    return 'cerebras';
  }

  supportsVision(): boolean {
    return false; // Cerebras inference is text-only — no image input support
  }

  // ========== Private helpers ==========

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
}
