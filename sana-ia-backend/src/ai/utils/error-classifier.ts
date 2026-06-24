import { GeminiErrorKind } from './gemini-error-kind';

/**
 * Classifies an error thrown by the Gemini SDK (or a wrapping layer such as
 * the Promise.race timeout) into a `GeminiErrorKind` value.
 *
 * Classification rules:
 *   - HTTP 429  → RATE_LIMITED  (transient — retry eligible)
 *   - HTTP 503  → UNAVAILABLE   (transient — retry eligible)
 *   - Timeout   → TIMEOUT       (non-retryable — wasted quota)
 *   - Parse     → PARSE         (non-retryable — model gave bad JSON)
 *   - Content   → POLICY_BLOCK  (non-retryable)
 *   - Other     → UNKNOWN
 */
export function classifyGeminiError(err: unknown): GeminiErrorKind {
    if (!err || typeof err !== 'object') {
        return GeminiErrorKind.UNKNOWN;
    }

    const error = err as Record<string, unknown>;

    // Timeout sentinel thrown by our own withTimeout helper
    if (error['__kind'] === GeminiErrorKind.TIMEOUT) {
        return GeminiErrorKind.TIMEOUT;
    }

    // Parse sentinel thrown by our own JSON parsing layer
    if (error['__kind'] === GeminiErrorKind.PARSE) {
        return GeminiErrorKind.PARSE;
    }

    // SDK error objects carry status / statusCode / httpStatus
    const httpStatus =
        (error['status'] as number | undefined) ??
        (error['statusCode'] as number | undefined) ??
        (error['httpStatus'] as number | undefined);

    if (httpStatus === 429) {
        return GeminiErrorKind.RATE_LIMITED;
    }

    if (httpStatus === 503) {
        return GeminiErrorKind.UNAVAILABLE;
    }

    // Content-policy block (SDK throws with status 400 and a specific message,
    // or exposes a blockReason / finishReason = SAFETY)
    const message = String(error['message'] ?? '').toLowerCase();
    if (
        message.includes('blocked') ||
        message.includes('safety') ||
        message.includes('policy') ||
        message.includes('finish_reason: safety')
    ) {
        return GeminiErrorKind.POLICY_BLOCK;
    }

    // The SDK sometimes wraps HTTP errors in a GoogleGenerativeAIError with the
    // status embedded in the message string, e.g. "[429 Too Many Requests]".
    const status429Match = /\[429\b/.test(message) || message.includes('too many requests');
    if (status429Match) {
        return GeminiErrorKind.RATE_LIMITED;
    }

    const status503Match = /\[503\b/.test(message) || message.includes('service unavailable');
    if (status503Match) {
        return GeminiErrorKind.UNAVAILABLE;
    }

    return GeminiErrorKind.UNKNOWN;
}
