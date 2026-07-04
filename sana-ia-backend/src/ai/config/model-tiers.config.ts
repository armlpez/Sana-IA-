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
    // Model names per tier (using gemini-2.5-flash)
    modelCollecting: process.env.GEMINI_MODEL_COLLECTING ?? 'gemini-2.5-flash',
    modelAnalyzing: process.env.GEMINI_MODEL_ANALYZING ?? 'gemini-2.5-flash',
    modelCompleted: process.env.GEMINI_MODEL_COMPLETED ?? 'gemini-2.5-flash',

    // Groq model names per tier (fallback #1)
    groqModelCollecting: process.env.GROQ_MODEL_COLLECTING ?? 'llama-3.3-70b-versatile',
    groqModelAnalyzing: process.env.GROQ_MODEL_ANALYZING ?? 'llama-3.3-70b-versatile',
    groqModelCompleted: process.env.GROQ_MODEL_COMPLETED ?? 'llama-3.3-70b-versatile',

    // DeepSeek model names per tier (fallback #2 — v4 line; -chat/-reasoner deprecate 2026-07-24)
    deepseekModelCollecting: process.env.DEEPSEEK_MODEL_COLLECTING ?? 'deepseek-v4-flash',
    deepseekModelAnalyzing: process.env.DEEPSEEK_MODEL_ANALYZING ?? 'deepseek-v4-flash',
    deepseekModelCompleted: process.env.DEEPSEEK_MODEL_COMPLETED ?? 'deepseek-v4-pro',

    // Timeout per tier group (ms)
    // OCR (Gemini Vision, 8-15s typical) uses MODEL_TIER_PRO → timeoutSlowMs.
    // Chat/collecting uses timeoutFastMs → kept at 8s for responsive UX.
    timeoutFastMs: parseInt(process.env.GEMINI_TIMEOUT_FAST_MS ?? '8000', 10),
    timeoutSlowMs: parseInt(process.env.GEMINI_TIMEOUT_SLOW_MS ?? '30000', 10),

    // Retry policy (applied only to transient errors: 429, 503)
    // Primary provider (Gemini) retries deeply; fallback providers fail-fast
    // because the fallback chain itself is the macro-level retry mechanism.
    retryMax: parseInt(process.env.GEMINI_RETRY_MAX ?? '2', 10),
    groqRetryMax: parseInt(process.env.GROQ_RETRY_MAX ?? '0', 10),
    deepseekRetryMax: parseInt(process.env.DEEPSEEK_RETRY_MAX ?? '0', 10),
    retryBaseMs: parseInt(process.env.GEMINI_RETRY_BASE_MS ?? '500', 10),
    retryCapMs: parseInt(process.env.GEMINI_RETRY_CAP_MS ?? '4000', 10),

    // Per-user chat rate limit (requests per minute)
    chatRateLimitPerMin: parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN ?? '12', 10),
}));
