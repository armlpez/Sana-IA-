import * as crypto from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { TokenService } from './token.service';
import { UserToken } from './entities/user-token.entity';
import { TokenType } from './enums/token-type.enum';

/** Builds a UserToken row as it would come back from the repository. */
function makeToken(overrides: Partial<UserToken> = {}): UserToken {
  return {
    id: 'token-id-1',
    userId: 5,
    tokenHash: 'stored-hash',
    type: TokenType.EMAIL_VERIFICATION,
    targetEmail: 'user@example.com',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('TokenService', () => {
  let tokenRepo: jest.Mocked<Repository<UserToken>>;
  let manager: { find: jest.Mock; create: jest.Mock; save: jest.Mock };
  let dataSource: jest.Mocked<DataSource>;
  let service: TokenService;

  beforeEach(() => {
    tokenRepo = {
      findOne: jest.fn(),
      delete: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<UserToken>>;

    manager = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_entity, data) => data),
      save: jest.fn().mockResolvedValue(undefined),
    };

    dataSource = {
      transaction: jest.fn((cb: any) => cb(manager)),
    } as unknown as jest.Mocked<DataSource>;

    service = new TokenService(tokenRepo, dataSource);
  });

  describe('issue', () => {
    it('stores a SHA-256 hex hash (64 chars) that is different from the raw token', async () => {
      const rawToken = await service.issue(5, TokenType.EMAIL_VERIFICATION);

      expect(rawToken).toHaveLength(64);

      const createCall = manager.create.mock.calls[0];
      const createdData = createCall[1];

      expect(createdData.tokenHash).toHaveLength(64);
      expect(createdData.tokenHash).not.toBe(rawToken);
      expect(createdData.tokenHash).toBe(
        crypto.createHash('sha256').update(rawToken).digest('hex'),
      );
    });

    it('consumes all prior un-consumed tokens of the same type for that user', async () => {
      const prior = makeToken({ id: 'prior-1', consumedAt: null });
      manager.find.mockResolvedValueOnce([prior]);

      await service.issue(5, TokenType.PASSWORD_RESET);

      expect(manager.find).toHaveBeenCalledWith(
        UserToken,
        expect.objectContaining({
          where: expect.objectContaining({ userId: 5, type: TokenType.PASSWORD_RESET }),
        }),
      );
      // First save() call marks the prior tokens consumed.
      expect(manager.save).toHaveBeenNthCalledWith(
        1,
        UserToken,
        [expect.objectContaining({ id: 'prior-1', consumedAt: expect.any(Date) })],
      );
    });

    it('runs the consume-prior + create-new steps inside a transaction', async () => {
      await service.issue(5, TokenType.EMAIL_VERIFICATION);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('sets a 30-minute TTL for PASSWORD_RESET tokens', async () => {
      const before = Date.now();
      await service.issue(5, TokenType.PASSWORD_RESET);
      const createdData = manager.create.mock.calls[0][1];
      const ttlMs = createdData.expiresAt.getTime() - before;

      expect(ttlMs).toBeGreaterThan(29 * 60 * 1000);
      expect(ttlMs).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
    });

    it('sets a 24-hour TTL for EMAIL_VERIFICATION tokens', async () => {
      const before = Date.now();
      await service.issue(5, TokenType.EMAIL_VERIFICATION);
      const createdData = manager.create.mock.calls[0][1];
      const ttlMs = createdData.expiresAt.getTime() - before;

      expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    });
  });

  describe('consume', () => {
    it('returns {userId, targetEmail} and marks the token consumed on the happy path', async () => {
      const token = makeToken();
      tokenRepo.findOne.mockResolvedValue(token);
      (tokenRepo.save as jest.Mock).mockResolvedValue(token);

      const result = await service.consume('raw-token', TokenType.EMAIL_VERIFICATION);

      expect(result).toEqual({ userId: 5, targetEmail: 'user@example.com' });
      expect(tokenRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ consumedAt: expect.any(Date) }),
      );
    });

    it('rejects an already-consumed token', async () => {
      const token = makeToken({ consumedAt: new Date() });
      tokenRepo.findOne.mockResolvedValue(token);

      expect.assertions(2);
      try {
        await service.consume('raw-token', TokenType.EMAIL_VERIFICATION);
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
        expect(err.publicMessage).toContain('ya fue utilizado');
      }
    });

    it('rejects an expired token with a DISTINCT publicMessage from a consumed token, and lazy-deletes the row', async () => {
      const token = makeToken({ expiresAt: new Date(Date.now() - 1000) });
      tokenRepo.findOne.mockResolvedValue(token);

      expect.assertions(4);
      try {
        await service.consume('raw-token', TokenType.EMAIL_VERIFICATION);
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
        expect(err.publicMessage).toContain('ha expirado');
        expect(err.publicMessage).not.toContain('ya fue utilizado');
      }

      expect(tokenRepo.delete).toHaveBeenCalledWith({ id: token.id });
    });

    it('rejects a token whose hash is not found', async () => {
      tokenRepo.findOne.mockResolvedValue(null);

      expect.assertions(2);
      try {
        await service.consume('unknown-raw-token', TokenType.PASSWORD_RESET);
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
        expect(err.publicMessage).toContain('no es válido');
      }
    });

    it('performs a single indexed lookup by tokenHash (not by raw token)', async () => {
      const token = makeToken();
      tokenRepo.findOne.mockResolvedValue(token);
      (tokenRepo.save as jest.Mock).mockResolvedValue(token);

      await service.consume('raw-token', TokenType.EMAIL_VERIFICATION);

      expect(tokenRepo.findOne).toHaveBeenCalledTimes(1);
      const arg = tokenRepo.findOne.mock.calls[0][0] as any;
      expect(arg.where.tokenHash).toBe(
        crypto.createHash('sha256').update('raw-token').digest('hex'),
      );
    });
  });
});
