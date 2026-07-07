import { Logger } from '@nestjs/common';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { computeBackoff, sleep } from './backoff.util';
import { buildAiProviderException } from './exception.util';

/**
 * The set of GeminiErrorKinds that are transient and eligible for retry.
 * Timeout, parse failures, policy blocks, and unknown errors are NOT retried
 * — verified against the retry loops of all 4 current adapters, which all
 * build this exact same Set inline.
 */
const RETRYABLE_KINDS = new Set<GeminiErrorKind>([
    GeminiErrorKind.RATE_LIMITED,
    GeminiErrorKind.UNAVAILABLE,
]);

export interface RunWithRetryConfig<T> {
    attemptFn: (attempt: number) => Promise<T>;
    classifyError: (err: unknown) => GeminiErrorKind;
    retryMax: number;
    retryBaseMs: number;
    retryCapMs: number;
    providerName: string;
    logger: Logger;
}

/**
 * Shared while-loop skeleton extracted from `generateWithResilience` across
 * all 4 current adapters. Only retries when the classified error kind is
 * RATE_LIMITED or UNAVAILABLE. On a non-retryable kind, or once attempts are
 * exhausted, throws via `buildAiProviderException`.
 */
export async function runWithRetry<T>(cfg: RunWithRetryConfig<T>): Promise<T> {
    const { attemptFn, classifyError, retryMax, retryBaseMs, retryCapMs, providerName, logger } = cfg;

    let lastKind: GeminiErrorKind = GeminiErrorKind.UNKNOWN;
    let attempt = 0;

    while (attempt <= retryMax) {
        if (attempt > 0) {
            const backoff = computeBackoff(attempt, retryBaseMs, retryCapMs);
            logger.warn(
                `Retrying ${providerName} call (attempt ${attempt}/${retryMax}) after ${backoff}ms — kind: ${lastKind}`,
            );
            await sleep(backoff);
        }

        try {
            return await attemptFn(attempt);
        } catch (err: unknown) {
            const kind = classifyError(err);
            lastKind = kind;

            if (!RETRYABLE_KINDS.has(kind) || attempt >= retryMax) {
                throw buildAiProviderException({ providerName, kind, attempt });
            }

            attempt++;
        }
    }

    // Should be unreachable, but satisfies TypeScript
    throw buildAiProviderException({ providerName, kind: lastKind, attempt });
}
