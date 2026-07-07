import 'reflect-metadata';
import { UsersController } from './users.controller';

const THROTTLER_TTL_KEY = 'THROTTLER:TTL';
const THROTTLER_LIMIT_KEY = 'THROTTLER:LIMIT';

describe('UsersController', () => {
  describe('registration throttle metadata', () => {
    it('applies the registration tier (ttl 3_600_000, limit 10) to POST /v1/users (create)', () => {
      const handler = UsersController.prototype.create;

      expect(Reflect.getMetadata(THROTTLER_TTL_KEY + 'registration', handler)).toBe(3_600_000);
      expect(Reflect.getMetadata(THROTTLER_LIMIT_KEY + 'registration', handler)).toBe(10);
    });

    it('does NOT apply the registration tier to other routes (findAll)', () => {
      const handler = UsersController.prototype.findAll;

      expect(Reflect.getMetadata(THROTTLER_TTL_KEY + 'registration', handler)).toBeUndefined();
      expect(Reflect.getMetadata(THROTTLER_LIMIT_KEY + 'registration', handler)).toBeUndefined();
    });
  });
});
