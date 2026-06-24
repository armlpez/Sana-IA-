import { registerAs } from '@nestjs/config';
import { ConsultationStatus } from '../../consultations/enums/consultation-status.enum';

/**
 * Model tiers for Gemini API calls.
 * Each tier maps to a different model and timeout budget.
 * All values are env-configurable with safe defaults.
 *
 * Tier selection by consultation phase:
 *   COLLECTING  → flash-lite (fast, cheap — gathering symptoms)
 *   ANALYZING   → flash (mid — processing gathered data)
 *   COMPLETED   → pro (slow, deep — final diagnosis)
 */
export type ModelTier = 'fast' | 'mid' | 'pro';

export const MODEL_TIER_FAST: ModelTier = 'fast';
export const MODEL_TIER_MID: ModelTier = 'mid';
export const MODEL_TIER_PRO: ModelTier = 'pro';

/**
 * Returns the model tier for a given consultation status.
 * Used by ChatService to select the appropriate model per turn.
 */
export function tierForStatus(status: ConsultationStatus): ModelTier {
    switch (status) {
        case ConsultationStatus.COLLECTING:
            return MODEL_TIER_FAST;
        case ConsultationStatus.ANALYZING:
            return MODEL_TIER_MID;
        case ConsultationStatus.COMPLETED:
            return MODEL_TIER_PRO;
        default:
            return MODEL_TIER_FAST;
    }
}

/**
 * Registered config namespace: 'aiModels'
 * Access via ConfigService.get('aiModels.<key>')
 */
export default registerAs('aiModels', () => ({
    // Model names per tier
    modelCollecting: process.env.GEMINI_MODEL_COLLECTING ?? 'gemini-2.0-flash-lite',
    modelAnalyzing: process.env.GEMINI_MODEL_ANALYZING ?? 'gemini-2.0-flash',
    modelCompleted: process.env.GEMINI_MODEL_COMPLETED ?? 'gemini-1.5-pro',

    // Timeout per tier group (ms)
    timeoutFastMs: parseInt(process.env.GEMINI_TIMEOUT_FAST_MS ?? '8000', 10),
    timeoutSlowMs: parseInt(process.env.GEMINI_TIMEOUT_SLOW_MS ?? '25000', 10),

    // Retry policy (applied only to transient errors: 429, 503)
    retryMax: parseInt(process.env.GEMINI_RETRY_MAX ?? '2', 10),
    retryBaseMs: parseInt(process.env.GEMINI_RETRY_BASE_MS ?? '500', 10),
    retryCapMs: parseInt(process.env.GEMINI_RETRY_CAP_MS ?? '4000', 10),

    // Per-user chat rate limit (requests per minute)
    chatRateLimitPerMin: parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN ?? '12', 10),
}));
