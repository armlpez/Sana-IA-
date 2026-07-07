import { resolveModelName, resolveTimeout } from './model-resolution.util';
import { MODEL_TIER_FAST, MODEL_TIER_MID, MODEL_TIER_PRO } from '../config/model-tiers.config';

describe('resolveModelName', () => {
    const models = { fast: 'model-fast', mid: 'model-mid', slow: 'model-slow' };

    it('resolves the fast model for MODEL_TIER_FAST', () => {
        expect(resolveModelName(MODEL_TIER_FAST, models)).toBe('model-fast');
    });

    it('resolves the mid model for MODEL_TIER_MID', () => {
        expect(resolveModelName(MODEL_TIER_MID, models)).toBe('model-mid');
    });

    it('resolves the slow model for MODEL_TIER_PRO', () => {
        expect(resolveModelName(MODEL_TIER_PRO, models)).toBe('model-slow');
    });

    it('falls back to fast when mid is not provided', () => {
        expect(resolveModelName(MODEL_TIER_MID, { fast: 'model-fast', slow: 'model-slow' })).toBe('model-fast');
    });
});

describe('resolveTimeout', () => {
    const timeouts = { fastMs: 8000, slowMs: 25000 };

    it('resolves the fast timeout for MODEL_TIER_FAST', () => {
        expect(resolveTimeout(MODEL_TIER_FAST, timeouts)).toBe(8000);
    });

    it('resolves the fast timeout for MODEL_TIER_MID', () => {
        expect(resolveTimeout(MODEL_TIER_MID, timeouts)).toBe(8000);
    });

    it('resolves the slow timeout for MODEL_TIER_PRO', () => {
        expect(resolveTimeout(MODEL_TIER_PRO, timeouts)).toBe(25000);
    });
});
