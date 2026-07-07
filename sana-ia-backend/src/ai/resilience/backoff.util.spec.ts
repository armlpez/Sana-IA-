import { computeBackoff, sleep } from './backoff.util';

describe('computeBackoff', () => {
    let randomSpy: jest.SpyInstance<number, []>;

    afterEach(() => {
        randomSpy?.mockRestore();
    });

    it('returns 0 when Math.random() returns 0', () => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

        const result = computeBackoff(1, 500, 4000);

        expect(result).toBe(0);
    });

    it('approaches the ceiling when Math.random() returns close to 1', () => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.999999999);

        // attempt=1, base=500, cap=4000 → ceiling = min(4000, 500*2^1) = 1000
        const result = computeBackoff(1, 500, 4000);

        expect(result).toBeLessThan(1000);
        expect(result).toBeGreaterThanOrEqual(999);
    });

    it('caps the ceiling at `cap` once base*2^attempt exceeds it', () => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.999999999);

        // attempt=10, base=500 → 500*2^10 = 512000, way above cap=4000
        const result = computeBackoff(10, 500, 4000);

        expect(result).toBeLessThan(4000);
        expect(result).toBeGreaterThanOrEqual(3999);
    });

    it('never exceeds the cap regardless of attempt count', () => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(1);

        const result = computeBackoff(20, 500, 4000);

        expect(result).toBeLessThanOrEqual(4000);
    });

    it('scales exponentially with attempt when below the cap', () => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

        const attempt0 = computeBackoff(0, 500, 4000); // ceiling = 500
        const attempt1 = computeBackoff(1, 500, 4000); // ceiling = 1000
        const attempt2 = computeBackoff(2, 500, 4000); // ceiling = 2000

        expect(attempt0).toBe(250);
        expect(attempt1).toBe(500);
        expect(attempt2).toBe(1000);
    });
});

describe('sleep', () => {
    it('resolves after the given number of milliseconds', async () => {
        jest.useFakeTimers();

        const promise = sleep(100);
        let resolved = false;
        promise.then(() => {
            resolved = true;
        });

        jest.advanceTimersByTime(99);
        await Promise.resolve();
        expect(resolved).toBe(false);

        jest.advanceTimersByTime(1);
        await promise;
        expect(resolved).toBe(true);

        jest.useRealTimers();
    });
});
