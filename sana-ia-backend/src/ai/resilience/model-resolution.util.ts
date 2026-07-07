import { ModelTier, MODEL_TIER_FAST, MODEL_TIER_MID, MODEL_TIER_PRO } from '../config/model-tiers.config';

export interface ModelsByTier {
    fast: string;
    mid?: string;
    slow: string;
}

export interface TimeoutsByTier {
    fastMs: number;
    slowMs: number;
}

/**
 * Resolves the model name for a given tier, normalizing the per-adapter
 * `resolveModelName` private methods (some ternary, some switch) into a
 * single implementation. Produces identical output to all 4 current
 * adapters for every `ModelTier` value.
 */
export function resolveModelName(tier: ModelTier, models: ModelsByTier): string {
    if (tier === MODEL_TIER_FAST) return models.fast;
    if (tier === MODEL_TIER_MID) return models.mid ?? models.fast;
    return models.slow;
}

/**
 * Resolves the timeout budget for a given tier. Only MODEL_TIER_PRO gets the
 * slow timeout budget — FAST and MID share the fast budget, matching all 4
 * current adapters.
 */
export function resolveTimeout(tier: ModelTier, timeouts: TimeoutsByTier): number {
    if (tier === MODEL_TIER_PRO) return timeouts.slowMs;
    return timeouts.fastMs;
}
