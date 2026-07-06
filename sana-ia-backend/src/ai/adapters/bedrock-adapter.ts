import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ContentBlock,
  ImageFormat,
} from '@aws-sdk/client-bedrock-runtime';
import { LlmGenerationResult, LlmProviderPort, LlmTokenUsage } from '../ports/llm-provider.port';
import { ModelTier, MODEL_TIER_FAST, MODEL_TIER_MID, MODEL_TIER_PRO } from '../config/model-tiers.config';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { classifyGeminiError } from '../utils/error-classifier';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';
import { isMultimodalPrompt } from '../utils/multimodal.util';

/**
 * Bedrock Adapter — implements LlmProviderPort for Amazon Bedrock (Nova models)
 * via the Converse API.
 *
 * Auth: NO API key. The SDK resolves credentials through the default provider
 * chain — on EC2 that's the instance role (same mechanism S3StorageAdapter
 * already uses), locally it's the AWS CLI profile. Requires bedrock:InvokeModel
 * on the Nova inference profiles (see infrastructure/stacks/iam/template.yml).
 *
 * Model IDs are cross-region inference profiles (us.amazon.nova-*) — Nova does
 * NOT support on-demand invocation of the bare foundation-model ID.
 *
 * Nova Micro is text-only; Nova Lite is multimodal. Multimodal (OCR) prompts
 * always route to the vision model, mirroring GroqAdapter's pattern.
 */
@Injectable()
export class BedrockAdapter implements LlmProviderPort {
  private readonly logger = new Logger(BedrockAdapter.name);
  private readonly client: BedrockRuntimeClient;

  // Model tier mapping (Bedrock-specific — Nova inference profile IDs)
  private readonly modelFast: string;
  private readonly modelMid: string;
  private readonly modelSlow: string;
  private readonly modelVision: string;

  private readonly timeoutFastMs: number;
  private readonly timeoutSlowMs: number;

  private readonly retryMax: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>('AWS_REGION') ?? 'us-east-1';
    this.client = new BedrockRuntimeClient({ region });

    const cfg = this.configService.get<Record<string, unknown>>('aiModels') ?? {};
    this.modelFast = (cfg['bedrockModelCollecting'] as string | undefined) ?? 'us.amazon.nova-micro-v1:0';
    this.modelMid = (cfg['bedrockModelAnalyzing'] as string | undefined) ?? 'us.amazon.nova-micro-v1:0';
    this.modelSlow = (cfg['bedrockModelCompleted'] as string | undefined) ?? 'us.amazon.nova-lite-v1:0';
    // Nova Micro is text-only — multimodal (OCR) prompts must use Nova Lite.
    this.modelVision = (cfg['bedrockModelVision'] as string | undefined) ?? 'us.amazon.nova-lite-v1:0';

    this.timeoutFastMs = (cfg['timeoutFastMs'] as number | undefined) ?? 8000;
    this.timeoutSlowMs = (cfg['timeoutSlowMs'] as number | undefined) ?? 25000;

    // Bedrock is the PRIMARY provider — it retries deeply (like Gemini did when
    // it was primary); the fallback chain handles what retries can't.
    this.retryMax = (cfg['bedrockRetryMax'] as number | undefined) ?? 2;
    this.retryBaseMs = (cfg['retryBaseMs'] as number | undefined) ?? 500;
    this.retryCapMs = (cfg['retryCapMs'] as number | undefined) ?? 4000;
  }

  async generateWithResilience(tier: ModelTier, prompt: string | any[]): Promise<LlmGenerationResult> {
    // Multimodal prompts need the vision-capable model regardless of tier,
    // and always get the slow timeout budget (image processing is not fast-tier work).
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
    return true; // via the configured vision model (Nova Lite by default)
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
    const content = this.toConverseContent(prompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.client.send(
        new ConverseCommand({
          modelId: modelName,
          messages: [{ role: 'user', content }],
          // 0.3 for consistency with the Gemini primary config this replaces —
          // the prompts expect deterministic, JSON-shaped output.
          inferenceConfig: { temperature: 0.3 },
        }),
        { abortSignal: controller.signal },
      );

      const text =
        response.output?.message?.content
          ?.map((block) => block.text ?? '')
          .join('') ?? '';

      if (!response.usage) {
        this.logger.warn('Bedrock response missing usage — token tracking will be inaccurate for this call');
      }
      const usage: LlmTokenUsage = {
        promptTokens: response.usage?.inputTokens ?? 0,
        completionTokens: response.usage?.outputTokens ?? 0,
        totalTokens: response.usage?.totalTokens ?? 0,
      };

      return { text, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Converts the canonical Gemini Part[] prompt (or plain string) into
   * Converse API content blocks:
   *   string / { text }             → { text }
   *   { inlineData: {data, mime} }  → { image: { format, source: { bytes } } }
   *
   * Converse takes raw bytes (not base64 data URLs like OpenAI-style APIs).
   */
  private toConverseContent(prompt: string | any[]): ContentBlock[] {
    if (typeof prompt === 'string') {
      return [{ text: prompt }];
    }

    return prompt
      .map((p): ContentBlock | null => {
        if (typeof p?.text === 'string') {
          return { text: p.text };
        }
        if (p?.inlineData?.data) {
          return {
            image: {
              format: this.mimeToImageFormat(p.inlineData.mimeType),
              source: { bytes: Buffer.from(p.inlineData.data, 'base64') },
            },
          };
        }
        return null;
      })
      .filter((block): block is ContentBlock => block !== null);
  }

  /** Converse accepts png | jpeg | gif | webp; defaults to jpeg for unknown MIME types. */
  private mimeToImageFormat(mimeType?: string): ImageFormat {
    switch (mimeType) {
      case 'image/png': return 'png';
      case 'image/gif': return 'gif';
      case 'image/webp': return 'webp';
      default: return 'jpeg';
    }
  }

  /**
   * AWS SDK errors carry a `name` (ThrottlingException, ServiceUnavailableException…)
   * and `$metadata.httpStatusCode` instead of a bare `status` field, and the
   * AbortController rejects with an AbortError — all special-cased here before
   * delegating the rest to the shared classifyGeminiError.
   */
  private classifyError(err: unknown): GeminiErrorKind {
    if (err instanceof Error && err.name === 'AbortError') {
      return GeminiErrorKind.TIMEOUT;
    }

    const e = err as any;
    switch (e?.name) {
      case 'ThrottlingException':
        return GeminiErrorKind.RATE_LIMITED;
      case 'ServiceUnavailableException':
      case 'ModelNotReadyException':
      case 'InternalServerException':
        return GeminiErrorKind.UNAVAILABLE;
    }

    // Surface the HTTP status where classifyGeminiError duck-types it.
    const status = e?.$metadata?.httpStatusCode;
    if (status && e && typeof e === 'object' && e.status === undefined) {
      e.status = status;
    }
    return classifyGeminiError(err);
  }

  private toAppException(kind: GeminiErrorKind, attempt: number): AppException {
    const messages: Record<GeminiErrorKind, { code: ErrorCode; message: string }> = {
      [GeminiErrorKind.RATE_LIMITED]: {
        code: ErrorCode.AI_RATE_LIMITED,
        message: `Bedrock rate limited after ${attempt} attempts. Please try again in a moment.`,
      },
      [GeminiErrorKind.TIMEOUT]: {
        code: ErrorCode.AI_TIMEOUT,
        message: `Bedrock request timed out after ${attempt} attempts.`,
      },
      [GeminiErrorKind.UNAVAILABLE]: {
        code: ErrorCode.AI_UNAVAILABLE,
        message: `Bedrock service temporarily unavailable after ${attempt} attempts.`,
      },
      [GeminiErrorKind.POLICY_BLOCK]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `Bedrock policy violation after ${attempt} attempts.`,
      },
      [GeminiErrorKind.PARSE]: {
        code: ErrorCode.AI_PARSE_FAILED,
        message: `Bedrock response format error after ${attempt} attempts.`,
      },
      [GeminiErrorKind.UNKNOWN]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: `Bedrock error after ${attempt} attempts.`,
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

  /**
   * Extract structured detail from any error shape for rich logging.
   * Handles: AWS SDK service exceptions, AbortError, plain Error instances.
   */
  private extractErrorDetail(err: unknown): { status: string; message: string; raw?: string } {
    if (!err) return { status: 'N/A', message: 'null/undefined error' };

    const e = err as any;
    const status = e.$metadata?.httpStatusCode ?? e.status ?? e.statusCode ?? 'N/A';
    const message = e.message ?? String(err);
    let raw: string | undefined;
    try {
      const body = e.name ? { name: e.name, requestId: e.$metadata?.requestId } : (e.cause ?? e.body);
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
