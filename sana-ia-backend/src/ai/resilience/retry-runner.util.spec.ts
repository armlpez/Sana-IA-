import { Logger } from '@nestjs/common';
import { runWithRetry } from './retry-runner.util';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { AppException } from '../../common/exceptions/app-exception';

function createLogger(): Logger {
    return { warn: jest.fn(), error: jest.fn(), log: jest.fn() } as unknown as Logger;
}

describe('runWithRetry', () => {
    let randomSpy: jest.SpyInstance<number, []>;

    beforeEach(() => {
        jest.useFakeTimers();
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        randomSpy.mockRestore();
        jest.useRealTimers();
    });

    it('returns the result on the first try without retrying', async () => {
        const attemptFn = jest.fn().mockResolvedValue('ok');
        const classifyError = jest.fn();

        const result = await runWithRetry({
            attemptFn,
            classifyError,
            retryMax: 2,
            retryBaseMs: 10,
            retryCapMs: 50,
            providerName: 'TestProvider',
            logger: createLogger(),
        });

        expect(result).toBe('ok');
        expect(attemptFn).toHaveBeenCalledTimes(1);
        expect(classifyError).not.toHaveBeenCalled();
    });

    it('retries once on a retryable kind and then succeeds', async () => {
        const attemptFn = jest
            .fn()
            .mockRejectedValueOnce(new Error('rate limited'))
            .mockResolvedValueOnce('recovered');
        const classifyError = jest.fn().mockReturnValue(GeminiErrorKind.RATE_LIMITED);

        const promise = runWithRetry({
            attemptFn,
            classifyError,
            retryMax: 2,
            retryBaseMs: 10,
            retryCapMs: 50,
            providerName: 'TestProvider',
            logger: createLogger(),
        });

        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('recovered');
        expect(attemptFn).toHaveBeenCalledTimes(2);
    });

    it('exhausts retries then throws an AppException built via buildAiProviderException', async () => {
        const attemptFn = jest.fn().mockRejectedValue(new Error('still rate limited'));
        const classifyError = jest.fn().mockReturnValue(GeminiErrorKind.RATE_LIMITED);

        const promise = runWithRetry({
            attemptFn,
            classifyError,
            retryMax: 2,
            retryBaseMs: 10,
            retryCapMs: 50,
            providerName: 'TestProvider',
            logger: createLogger(),
        });

        const assertion = expect(promise).rejects.toBeInstanceOf(AppException);
        await jest.runAllTimersAsync();
        await assertion;

        // attempt 0 (initial) + attempt 1 + attempt 2 = 3 calls total (retryMax=2)
        expect(attemptFn).toHaveBeenCalledTimes(3);
    });

    it('short-circuits immediately on a non-retryable kind — no retry attempted', async () => {
        const attemptFn = jest.fn().mockRejectedValue(new Error('bad json'));
        const classifyError = jest.fn().mockReturnValue(GeminiErrorKind.PARSE);

        await expect(
            runWithRetry({
                attemptFn,
                classifyError,
                retryMax: 2,
                retryBaseMs: 10,
                retryCapMs: 50,
                providerName: 'TestProvider',
                logger: createLogger(),
            }),
        ).rejects.toBeInstanceOf(AppException);

        expect(attemptFn).toHaveBeenCalledTimes(1);
    });
});
