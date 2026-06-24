import { UserThrottlerGuard } from './user-throttler.guard';

/**
 * UserThrottlerGuard unit tests.
 *
 * We test getTracker() directly since it's the only custom logic.
 * ThrottlerGuard's internal logic is tested by @nestjs/throttler itself.
 */
describe('UserThrottlerGuard', () => {
    let guard: UserThrottlerGuard;

    beforeEach(() => {
        // ThrottlerGuard requires constructor args, but getTracker is a simple method.
        // We instantiate with a minimal mock to avoid full DI wiring.
        guard = Object.create(UserThrottlerGuard.prototype);
    });

    describe('getTracker', () => {
        it('should return user ID when authenticated', async () => {
            const req = { user: { id: 42 }, ip: '10.0.0.1' };
            const tracker = await (guard as any).getTracker(req);
            expect(tracker).toBe('42');
        });

        it('should return IP when user is not present', async () => {
            const req = { ip: '192.168.1.100' };
            const tracker = await (guard as any).getTracker(req);
            expect(tracker).toBe('192.168.1.100');
        });

        it('should return IP when user.id is undefined', async () => {
            const req = { user: {}, ip: '10.0.0.5' };
            const tracker = await (guard as any).getTracker(req);
            expect(tracker).toBe('10.0.0.5');
        });

        it('should convert numeric user ID to string', async () => {
            const req = { user: { id: 1 }, ip: '127.0.0.1' };
            const tracker = await (guard as any).getTracker(req);
            expect(typeof tracker).toBe('string');
            expect(tracker).toBe('1');
        });
    });
});
