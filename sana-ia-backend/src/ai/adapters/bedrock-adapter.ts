import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmGenerationResult, LlmProviderPort, LlmTokenUsage } from '../ports/llm-provider.port';
import { ModelTier, MODEL_TIER_FAST, MODEL_TIER_MID, MODEL_TIER_PRO } from '../config/model-tiers.config';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { classifyGeminiError } from '../utils/error-classifier';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';
import { isMultimodalPrompt, partsToOpenAiContent } from '../utils/multimodal.util';

/**
 * Bedrock Adapter — implements LlmProviderPort for Amazon Bedrock Mantle, the
 * OpenAI-compatible gateway to third-party/open-weight models on Bedrock
 * (GPT-OSS, Qwen, DeepSeek, etc). This is a DIFFERENT product from the classic
 * Bedrock Runtime (which only serves Amazon's own Nova/Titan models) — Mantle
 * exists because this AWS account's Nova access is gated by an account-level
 * `authorizationStatus: NOT_AUTHORIZED` restriction (confirmed via
 * get-foundation-model-availability; identical failure across IAM user, EC2
 * role, and classic Bedrock API key). Mantle uses a separate Bearer-token API
 * key and is authorized on this account today.
 *
 * Auth: Bearer token (BEDROCK_MANTLE_API_KEY), NOT AWS SigV4 — no IAM
 * permission needed, unlike every other AWS-native call in this codebase (S3,
 * Secrets Manager). Plain fetch, same shape as CerebrasAdapter.
 */
@Injectable()
export class BedrockAdapter implements LlmProviderPort {
  private readonly logger = new Logger(BedrockAdapter.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;

  // Model per tier — GPT-OSS 20B for fast/mid, 120B for the completed tier.
  private readonly modelFast: string;
  private readonly modelMid: string;
  private readonly modelSlow: string;
  // Qwen3-VL is the only vision-capable model of the three — used for OCR
  // regardless of tier, same pattern as GroqAdapter's separate modelVision.
  private readonly modelVision: string;

  private readonly timeoutFastMs: number;
  private readonly timeoutSlowMs: number;

  private readonly retryMax: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('BEDROCK_MANTLE_API_KEY') ?? '';
    if (!this.apiKey) {
      this.logger.warn('BEDROCK_MANTLE_API_KEY not configured — BedrockAdapter will not function.');
    }

    const region = this.configService.get<string>('AWS_REGION') ?? 'us-east-1';
    this.baseUrl = `https://bedrock-mantle.${region}.api.aws/v1/chat/completions`;

    const cfg = this.configService.get<Record<string, unknown>>('aiModels') ?? {};
    this.modelFast = (cfg['bedrockModelCollecting'] as string | undefined) ?? 'openai.gpt-oss-20b';
    this.modelMid = (cfg['bedrockModelAnalyzing'] as string | undefined) ?? 'openai.gpt-oss-20b';
    this.modelSlow = (cfg['bedrockModelCompleted'] as string | undefined) ?? 'openai.gpt-oss-120b';
    this.modelVision = (cfg['bedrockModelVision'] as string | undefined) ?? 'qwen.qwen3-vl-235b-a22b-instruct';

    this.timeoutFastMs = (cfg['timeoutFastMs'] as number | undefined) ?? 8000;
    this.timeoutSlowMs = (cfg['timeoutSlowMs'] as number | undefined) ?? 25000;

    // Bedrock is the PRIMARY provider — it retries deeply; fallback providers
    // (gemini/groq/cerebras) fail-fast because the chain itself is the
    // macro-level retry mechanism.
    this.retryMax = (cfg['bedrockRetryMax'] as number | undefined) ?? 2;
    this.retryBaseMs = (cfg['retryBaseMs'] as number | undefined) ?? 500;
    this.retryCapMs = (cfg['retryCapMs'] as number | undefined) ?? 4000;
  }

  async generateWithResilience(tier: ModelTier, prompt: string | any[]): Promise<LlmGenerationResult> {
    const multimodal = isMultimodalPrompt(prompt);
    const modelName = multimodal ? this.modelVision : this.resolveModelName(tier);
    const timeoutMs = multimodal ? this.timeoutSlowMs : this.resolveTimeout(tier);

    let lastKind: GeminiErrorKind = GeminiErrorKind.UNKNOWN;
    let attempt = 0;

    while (attempt <= this.retryMax) {
      if (attempt > 0) {
        const backoff = this.computeBackoff(attempt);
        this.logger.warn(
          `Retrying Bedrock call (attempt ${attempt}/${this.retryMax}) after ${backoff}ms — kind: ${lastKind}`,
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
          `Bedrock error on attempt ${attempt} — kind: ${kind}, model: ${modelName}, ` +
          `status: ${errDetail.status}, message: ${errDetail.message}`,
        );
        if (errDetail.raw) {
          this.logger.error(`Bedrock raw error detail: ${errDetail.raw}`);
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
    return 'bedrock';
  }

  supportsVision(): boolean {
    return true; // via the configured vision model (Qwen3-VL by default)
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
    // ({type:'text'} / {type:'image_url'}) — Mantle speaks the OpenAI schema.
    const messages: any[] =
      typeof prompt === 'string'
        ? [{ role: 'user', content: prompt }]
        : [{ role: 'user', content: partsToOpenAiContent(prompt) }];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: modelName, messages }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const httpError = new Error(`Bedrock Mantle HTTP ${res.status}: ${errBody.substring(0, 200)}`);
        (httpError as any).status = res.status;
        throw httpError;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const text = data.choices?.[0]?.message?.content ?? '';

      if (!data.usage) {
        this.logger.warn('Bedrock Mantle response missing usage — token tracking will be inaccurate for this call');
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
        message: `Bedrock rate limited after ${attempt} attempts. Please try again in a moment.`,
        publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.TIMEOUT]: {
        code: ErrorCode.AI_TIMEOUT,
        message: `Bedrock request timed out after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA tardó demasiado. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.UNAVAILABLE]: {
        code: ErrorCode.AI_UNAVAILABLE,
        message: `Bedrock service temporarily unavailable after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.POLICY_BLOCK]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `Bedrock policy violation after ${attempt} attempts.`,
        publicMessage: 'Error interno en el servicio de IA.',
      },
      [GeminiErrorKind.PARSE]: {
        code: ErrorCode.AI_PARSE_FAILED,
        message: `Bedrock response format error after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA no pudo procesar la respuesta. Por favor, intentá de nuevo.',
      },
      [GeminiErrorKind.UNKNOWN]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `Bedrock error after ${attempt} attempts.`,
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
