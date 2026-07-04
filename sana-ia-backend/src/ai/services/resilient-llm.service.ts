import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProviderPort, LLM_PROVIDER_PORT } from '../ports/llm-provider.port';
import { ModelTier } from '../config/model-tiers.config';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { AppException } from '../../common/exceptions/app-exception';

/**
 * ResilientLlmService — orchestrates multi-provider LLM fallback across an ordered chain.
 *
 * Strategy:
 * 1. Try the primary provider (usually Gemini)
 * 2. On RATE_LIMITED / UNAVAILABLE, try the next provider in the fallback chain
 *    (e.g. Groq, then DeepSeek)
 * 3. On a non-transient error (PARSE, TIMEOUT, UNKNOWN), stop immediately —
 *    switching providers won't fix a malformed prompt or a hung request.
 * 4. If every provider in the chain is exhausted, throw so the caller falls
 *    back to SafeFallbackBuilder's clinically-safe message.
 *
 * Chain is config-driven (LLM_FALLBACK_CHAIN=groq,deepseek) so adding a 4th
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
  async generateWithFallback(tier: ModelTier, prompt: string | any[]): Promise<string> {
    const chain = [this.primaryProvider, ...this.fallbackChain];

    let lastErr: unknown;

    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      const isLast = i === chain.length - 1;

      if (i === 0) {
        this.logger.log(`Trying primary LLM: ${provider.getName()}`);
      } else {
        this.logger.warn(`Trying fallback provider [${i}/${chain.length - 1}]: ${provider.getName()}`);
      }

      try {
        return await provider.generateWithResilience(tier, prompt);
      } catch (err: unknown) {
        lastErr = err;
        const kind = this.extractErrorKind(err);

        if (isLast) {
          const errMsg = this.extractMessage(err);
          this.logger.error(
            `Provider ${provider.getName()} failed (${kind}) — chain exhausted, no more providers. Last error: ${errMsg}`,
          );
          throw err;
        }

        if (!this.fallbackOnErrors.has(kind)) {
          const errMsg = this.extractMessage(err);
          this.logger.warn(
            `Provider ${provider.getName()} failed (${kind}) — non-transient error, not trying further providers. Error: ${errMsg}`,
          );
          throw err;
        }

        const errMsg = this.extractMessage(err);
        this.logger.warn(`Provider ${provider.getName()} failed (${kind}), advancing to next in chain. Error: ${errMsg}`);
      }
    }

    // Unreachable (loop always returns or throws), but keeps TypeScript satisfied.
    throw lastErr;
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
