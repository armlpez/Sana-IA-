import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmGenerationResult, LlmProviderPort, LLM_PROVIDER_PORT } from '../ports/llm-provider.port';
import { ModelTier } from '../config/model-tiers.config';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';
import { isMultimodalPrompt } from '../utils/multimodal.util';

/**
 * Diagnostics attached to the error thrown by generateWithFallback when the
 * provider chain fails. Lets callers persist WHICH model failed (and the full
 * chain that was attempted) into chat_message metadata — no log grep needed.
 *
 * Contains provider NAMES only (gemini/groq/cerebras) — never patient content.
 */
export interface LlmFailureDiagnostics {
  /** Providers actually attempted, in chain order (e.g. ['gemini','groq','cerebras']). */
  attemptedProviders: string[];
  /** The provider whose failure finally broke the chain (the last one tried). */
  failedProvider: string;
}

/** Non-enumerable-ish property key carrying LlmFailureDiagnostics on a thrown error. */
const LLM_DIAGNOSTICS_KEY = 'llmDiagnostics';

/**
 * Reads the LlmFailureDiagnostics that ResilientLlmService attached to a thrown
 * error, if present. Returns undefined for errors that did not originate from
 * the provider chain (e.g. a JSON parse failure after a successful LLM call).
 */
export function getLlmFailureDiagnostics(err: unknown): LlmFailureDiagnostics | undefined {
  if (err && typeof err === 'object' && LLM_DIAGNOSTICS_KEY in err) {
    const diag = (err as Record<string, unknown>)[LLM_DIAGNOSTICS_KEY];
    if (diag && typeof diag === 'object' && 'failedProvider' in diag) {
      return diag as LlmFailureDiagnostics;
    }
  }
  return undefined;
}

/**
 * ResilientLlmService — orchestrates multi-provider LLM fallback across an ordered chain.
 *
 * Strategy:
 * 1. Try the primary provider (usually Gemini)
 * 2. On RATE_LIMITED / UNAVAILABLE, try the next provider in the fallback chain
 *    (e.g. Groq, then cerebras)
 * 3. On a non-transient error (PARSE, TIMEOUT, UNKNOWN), stop immediately —
 *    switching providers won't fix a malformed prompt or a hung request.
 * 4. If every provider in the chain is exhausted, throw so the caller falls
 *    back to SafeFallbackBuilder's clinically-safe message.
 *
 * Chain is config-driven (LLM_FALLBACK_CHAIN=groq,cerebras) so adding a 4th
 * provider is a one-line env change plus a new adapter — no code changes here.
 */
@Injectable()
export class ResilientLlmService {
  private readonly logger = new Logger(ResilientLlmService.name);

  private readonly primaryProvider: LlmProviderPort;
  private readonly fallbackChain: LlmProviderPort[];
  private readonly fallbackOnErrors = new Set([
    GeminiErrorKind.RATE_LIMITED,
    GeminiErrorKind.UNAVAILABLE,
    GeminiErrorKind.UNKNOWN,
    GeminiErrorKind.TIMEOUT,
    GeminiErrorKind.PARSE,
  ]);

  constructor(
    @Inject(LLM_PROVIDER_PORT)
    providers: Map<string, LlmProviderPort>,
    private readonly configService: ConfigService,
  ) {
    const primaryName = this.configService.get<string>('LLM_PRIMARY_PROVIDER') ?? 'gemini';

    // LLM_FALLBACK_CHAIN is the source of truth (comma-separated, ordered).
    // LLM_FALLBACK_PROVIDER is kept for backward compatibility with single-fallback configs.
    const chainRaw =
      this.configService.get<string>('LLM_FALLBACK_CHAIN') ??
      this.configService.get<string>('LLM_FALLBACK_PROVIDER') ??
      'groq';

    const chainNames = chainRaw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);

    this.primaryProvider = providers.get(primaryName) ?? providers.get('gemini')!;

    this.fallbackChain = chainNames
      .filter((name) => name !== primaryName)
      .map((name) => providers.get(name))
      .filter((provider): provider is LlmProviderPort => Boolean(provider));

    this.logger.log(
      `ResilientLlmService initialized: primary=${this.primaryProvider.getName()}, ` +
        `fallbackChain=[${this.fallbackChain.map((p) => p.getName()).join(' -> ') || 'none (SafeFallback only)'}]`,
    );
  }

  /**
   * Generates text walking the provider chain in order.
   * Stops at the first success, the first non-transient error, or after the
   * chain is exhausted — in which case the caller uses SafeFallbackBuilder.
   */
  async generateWithFallback(
    tier: ModelTier,
    prompt: string | any[],
  ): Promise<LlmGenerationResult & { provider: string }> {
    let chain = [this.primaryProvider, ...this.fallbackChain];

    // Multimodal prompts (OCR images) can only be served by vision-capable
    // providers — skip text-only ones (e.g. Cerebras) instead of letting them
    // silently drop the image and hallucinate biomarkers.
    if (isMultimodalPrompt(prompt)) {
      const skipped = chain.filter((p) => !p.supportsVision()).map((p) => p.getName());
      chain = chain.filter((p) => p.supportsVision());

      if (skipped.length > 0) {
        this.logger.log(`Multimodal prompt — skipping text-only providers: [${skipped.join(', ')}]`);
      }
      if (chain.length === 0) {
        throw new AppException({
          errorCode: ErrorCode.AI_UNAVAILABLE,
          message: 'No vision-capable LLM provider is configured for multimodal prompts.',
          statusCode: 500,
          publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
        });
      }
    }

    let lastErr: unknown;
    // Providers we actually try, in order — attached to the thrown error so the
    // caller can persist which model(s) failed into chat_message metadata.
    const attempted: string[] = [];

    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      const isLast = i === chain.length - 1;
      attempted.push(provider.getName());

      if (i === 0) {
        this.logger.log(`Trying primary LLM: ${provider.getName()}`);
      } else {
        this.logger.warn(`Trying fallback provider [${i}/${chain.length - 1}]: ${provider.getName()}`);
      }

      try {
        const result = await provider.generateWithResilience(tier, prompt);
        return { ...result, provider: provider.getName() };
      } catch (err: unknown) {
        lastErr = err;
        const kind = this.extractErrorKind(err);

        if (isLast) {
          const errMsg = this.extractMessage(err);
          this.logger.error(
            `Provider ${provider.getName()} failed (${kind}) — chain exhausted, no more providers. ` +
              `Attempted: [${attempted.join(' -> ')}]. Last error: ${errMsg}`,
          );
          throw this.attachDiagnostics(err, attempted, provider.getName());
        }

        if (!this.fallbackOnErrors.has(kind)) {
          const errMsg = this.extractMessage(err);
          this.logger.warn(
            `Provider ${provider.getName()} failed (${kind}) — non-transient error, not trying further providers. Error: ${errMsg}`,
          );
          throw this.attachDiagnostics(err, attempted, provider.getName());
        }

        const errMsg = this.extractMessage(err);
        this.logger.warn(`Provider ${provider.getName()} failed (${kind}), advancing to next in chain. Error: ${errMsg}`);
      }
    }

    // Unreachable (loop always returns or throws), but keeps TypeScript satisfied.
    throw lastErr;
  }

  /**
   * Attaches provider diagnostics (which chain was tried, which model failed)
   * to the error object before it propagates. The caller (ChatService) reads
   * these via getLlmFailureDiagnostics() and persists them to metadata.
   *
   * We mutate the existing error rather than wrapping it so the original
   * AppException.errorCode survives for downstream error-kind classification.
   */
  private attachDiagnostics(
    err: unknown,
    attempted: string[],
    failedProvider: string,
  ): unknown {
    if (err && typeof err === 'object') {
      const diagnostics: LlmFailureDiagnostics = {
        attemptedProviders: [...attempted],
        failedProvider,
      };
      try {
        (err as Record<string, unknown>)[LLM_DIAGNOSTICS_KEY] = diagnostics;
      } catch {
        // Frozen/sealed error — diagnostics stay in the logs above; don't mask the error.
      }
    }
    return err;
  }

  /**
   * Extract GeminiErrorKind from AppException for routing logic.
   */
  private extractErrorKind(err: unknown): GeminiErrorKind {
    if (err instanceof AppException) {
      const code = err.errorCode;
      if (code === 'ERR_AI_003') return GeminiErrorKind.RATE_LIMITED;
      if (code === 'ERR_AI_004') return GeminiErrorKind.UNAVAILABLE;
      if (code === 'ERR_AI_002') return GeminiErrorKind.TIMEOUT;
      if (code === 'ERR_AI_005') return GeminiErrorKind.PARSE;
    }
    return GeminiErrorKind.UNKNOWN;
  }

  /**
   * Extract a human-readable message from any error shape.
   */
  private extractMessage(err: unknown): string {
    if (!err) return 'null/undefined';
    if (err instanceof AppException) return err.message;
    if (err instanceof Error) return err.message;
    const e = err as any;
    return e.message ?? String(err).substring(0, 200);
  }
}


