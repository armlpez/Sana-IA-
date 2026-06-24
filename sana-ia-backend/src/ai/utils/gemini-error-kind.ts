/**
 * Classification of errors returned by the Gemini SDK.
 *
 * Used by both SafeFallbackBuilder (PR-1) and GeminiErrorClassifier (PR-2)
 * so this shared enum lives here and is imported by both.
 *
 * Retry eligibility:
 *   - RATE_LIMITED, UNAVAILABLE → retry (transient)
 *   - TIMEOUT, POLICY_BLOCK, PARSE, UNKNOWN → fallback only (no retry)
 */
export enum GeminiErrorKind {
    RATE_LIMITED = 'RATE_LIMITED',
    UNAVAILABLE = 'UNAVAILABLE',
    TIMEOUT = 'TIMEOUT',
    POLICY_BLOCK = 'POLICY_BLOCK',
    PARSE = 'PARSE',
    UNKNOWN = 'UNKNOWN',
}
