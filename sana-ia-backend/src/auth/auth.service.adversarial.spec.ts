import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { TokenService } from '../tokens/token.service';
import { UserToken } from '../tokens/entities/user-token.entity';
import { TokenType } from '../tokens/enums/token-type.enum';
import { EmailProducer } from '../email/email.producer';
import { AppException } from '../common/exceptions/app-exception';
import { ErrorCode } from '../common/enums/error-codes.enum';

/** Builds a User row as it would come back from the repository. */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    email: 'user@example.com',
    name: 'Usuario',
    password: 'hashed-password',
    birthDate: new Date('2000-01-01'),
    isActive: true,
    disclaimerAccepted: true,
    disclaimerAcceptedAt: new Date(),
    isEmailVerified: true,
    emailVerifiedAt: new Date('2025-01-01'),
    pendingEmail: null as unknown as string,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: { id: 2, name: 'user' } as any,
    refreshTokens: [],
    ...overrides,
  } as User;
}

/**
 * Minimal in-memory fake standing in for BOTH `Repository<UserToken>` (used
 * directly by `consume()`) and the `EntityManager` handed to
 * `dataSource.transaction()`'s callback (used by `issue()`). This lets us run
 * the REAL `TokenService` — not a mock — so the pendingEmail adversarial
 * scenarios below exercise genuine consume-prior / single-use semantics
 * across two collaborating services, not just asserted call arguments.
 */
class FakeUserTokenStore {
  rows: UserToken[] = [];
  private seq = 0;

  private matches(row: UserToken, where: Record<string, any>): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'type' in value && value.type === 'isNull') {
        return (row as any)[key] === null || (row as any)[key] === undefined;
      }
      return (row as any)[key] === value;
    });
  }

  private upsert(entity: Partial<UserToken>): UserToken {
    const idx = this.rows.findIndex((r) => r.id === entity.id);
    if (idx >= 0) {
      this.rows[idx] = { ...this.rows[idx], ...entity };
      return this.rows[idx];
    }
    const row = entity as UserToken;
    this.rows.push(row);
    return row;
  }

  // ---- Repository<UserToken> surface (used by TokenService.consume) ----
  repo = {
    findOne: async ({ where }: any): Promise<UserToken | null> => {
      return this.rows.find((r) => this.matches(r, where)) ?? null;
    },
    save: async (entity: any): Promise<any> => this.upsert(entity),
    delete: async ({ id }: any): Promise<void> => {
      this.rows = this.rows.filter((r) => r.id !== id);
    },
  } as unknown as Repository<UserToken>;

  // ---- DataSource surface (used by TokenService.issue) ----
  dataSource = {
    transaction: async (cb: (manager: any) => Promise<any>) => {
      const manager = {
        find: async (_entity: any, { where }: any) => this.rows.filter((r) => this.matches(r, where)),
        create: (_entity: any, data: any) => ({
          id: `fake-token-${++this.seq}`,
          consumedAt: null,
          createdAt: new Date(),
          ...data,
        }),
        save: async (_entity: any, dataOrArray: any) => {
          if (Array.isArray(dataOrArray)) {
            return dataOrArray.map((d) => this.upsert(d));
          }
          return this.upsert(dataOrArray);
        },
      };
      return cb(manager);
    },
  } as any;
}

/** In-memory fake for `Repository<User>` supporting the lookups AuthService needs. */
class FakeUserStore {
  constructor(public users: User[]) {}

  repo = {
    findOneBy: async (where: any): Promise<User | null> => {
      if ('id' in where) return this.users.find((u) => u.id === where.id) ?? null;
      if ('email' in where) return this.users.find((u) => u.email === where.email) ?? null;
      return null;
    },
    save: async (entity: any): Promise<any> => {
      const idx = this.users.findIndex((u) => u.id === entity.id);
      if (idx >= 0) this.users[idx] = { ...this.users[idx], ...entity };
      return entity;
    },
  } as unknown as Repository<User>;
}

describe('AuthService — adversarial (Phase 8.2 / 8.3)', () => {
  const configValues: Record<string, string | undefined> = {
    JWT_REFRESH_SECRET: 'refresh-secret',
    JWT_REFRESH_EXPIRATION: '7d',
    FRONTEND_URL: 'http://localhost:3000',
    EMAIL_VERIFICATION_ENFORCED: 'true',
  };

  function buildConfigService(overrides: Record<string, string | undefined> = {}) {
    const values = { ...configValues, ...overrides };
    return { get: jest.fn((key: string) => values[key]) } as unknown as jest.Mocked<ConfigService>;
  }

  // ==================== 8.2 — Gate ordering: no timing-relevant extra work ====================
  describe('8.2 — gate ordering produces IDENTICAL observable behavior for wrong password (verified vs unverified)', () => {
    let usersService: jest.Mocked<UsersService>;
    let jwtService: jest.Mocked<JwtService>;
    let configService: jest.Mocked<ConfigService>;
    let refreshTokenRepository: jest.Mocked<Repository<RefreshToken>>;
    let userRepository: jest.Mocked<Repository<User>>;
    let tokenService: jest.Mocked<TokenService>;
    let emailProducer: jest.Mocked<EmailProducer>;
    let service: AuthService;

    beforeEach(() => {
      usersService = { findByEmail: jest.fn(), findOne: jest.fn() } as unknown as jest.Mocked<UsersService>;
      jwtService = { sign: jest.fn(), verify: jest.fn(), decode: jest.fn() } as unknown as jest.Mocked<JwtService>;
      configService = buildConfigService();
      refreshTokenRepository = { save: jest.fn(), find: jest.fn(), update: jest.fn() } as unknown as jest.Mocked<
        Repository<RefreshToken>
      >;
      userRepository = { findOneBy: jest.fn(), save: jest.fn() } as unknown as jest.Mocked<Repository<User>>;
      tokenService = { issue: jest.fn(), consume: jest.fn() } as unknown as jest.Mocked<TokenService>;
      emailProducer = { enqueue: jest.fn() } as unknown as jest.Mocked<EmailProducer>;

      service = new AuthService(
        usersService,
        jwtService,
        configService,
        refreshTokenRepository,
        userRepository,
        tokenService,
        emailProducer,
      );
    });

    it('never reads EMAIL_VERIFICATION_ENFORCED on a wrong-password attempt against a VERIFIED account', async () => {
      const user = makeUser({ isEmailVerified: true, password: await bcrypt.hash('correct', 10) });
      usersService.findByEmail.mockResolvedValue(user);

      await service.validateUser(user.email, 'wrong-password');

      const enforcedReads = configService.get.mock.calls.filter((c) => c[0] === 'EMAIL_VERIFICATION_ENFORCED');
      expect(enforcedReads).toHaveLength(0);
    });

    it('never reads EMAIL_VERIFICATION_ENFORCED on a wrong-password attempt against an UNVERIFIED account (identical to verified case)', async () => {
      const user = makeUser({ isEmailVerified: false, password: await bcrypt.hash('correct', 10) });
      usersService.findByEmail.mockResolvedValue(user);

      await service.validateUser(user.email, 'wrong-password');

      const enforcedReads = configService.get.mock.calls.filter((c) => c[0] === 'EMAIL_VERIFICATION_ENFORCED');
      expect(enforcedReads).toHaveLength(0);
    });

    it('issues the EXACT SAME number of findByEmail/bcrypt-relevant calls on wrong password for verified vs unverified users (no extra query differentiates the branches)', async () => {
      const verified = makeUser({ id: 1, email: 'v@example.com', isEmailVerified: true, password: await bcrypt.hash('correct', 10) });
      const unverified = makeUser({ id: 2, email: 'u@example.com', isEmailVerified: false, password: await bcrypt.hash('correct', 10) });

      usersService.findByEmail.mockResolvedValueOnce(verified);
      await service.validateUser(verified.email, 'wrong-password');
      const callsForVerified = usersService.findByEmail.mock.calls.length;

      usersService.findByEmail.mockClear();
      usersService.findByEmail.mockResolvedValueOnce(unverified);
      await service.validateUser(unverified.email, 'wrong-password');
      const callsForUnverified = usersService.findByEmail.mock.calls.length;

      expect(callsForVerified).toBe(1);
      expect(callsForUnverified).toBe(1);
      expect(callsForVerified).toBe(callsForUnverified);
    });

    it('AUTH_EMAIL_NOT_VERIFIED surfaces ONLY after a correct password — wrong password never throws it, regardless of verification state', async () => {
      const unverified = makeUser({ isEmailVerified: false, password: await bcrypt.hash('correct', 10) });
      usersService.findByEmail.mockResolvedValue(unverified);

      const result = await service.validateUser(unverified.email, 'wrong-password');

      expect(result).toBeNull();
    });
  });

  // ==================== 8.3 — pendingEmail edge cases, wired with the REAL TokenService ====================
  describe('8.3 — pendingEmail edge cases (real TokenService, no mocks on the token layer)', () => {
    function buildService(userStore: FakeUserStore, tokenStore: FakeUserTokenStore) {
      const usersService = { findByEmail: jest.fn(), findOne: jest.fn() } as unknown as jest.Mocked<UsersService>;
      const jwtService = { sign: jest.fn(), verify: jest.fn(), decode: jest.fn() } as unknown as jest.Mocked<JwtService>;
      const configService = buildConfigService();
      const refreshTokenRepository = { save: jest.fn(), find: jest.fn(), update: jest.fn() } as unknown as jest.Mocked<
        Repository<RefreshToken>
      >;
      const emailProducer = { enqueue: jest.fn().mockResolvedValue('job-1') } as unknown as jest.Mocked<EmailProducer>;
      const realTokenService = new TokenService(tokenStore.repo, tokenStore.dataSource);

      return new AuthService(
        usersService,
        jwtService,
        configService,
        refreshTokenRepository,
        userStore.repo,
        realTokenService,
        emailProducer,
      );
    }

    it('(a) user changes pendingEmail TWICE → the FIRST token no longer works (consume-prior proof)', async () => {
      const tokenStore = new FakeUserTokenStore();
      const realTokenService = new TokenService(tokenStore.repo, tokenStore.dataSource);

      // Simulates two successive PATCH /auth/profile email-change requests
      // for the same user: each issues an EMAIL_VERIFICATION token targeting
      // the requested address. issue() internally consumes all prior
      // un-consumed tokens of the same type for that user.
      const firstRawToken = await realTokenService.issue(3, TokenType.EMAIL_VERIFICATION, 'primero@example.com');
      const secondRawToken = await realTokenService.issue(3, TokenType.EMAIL_VERIFICATION, 'segundo@example.com');

      expect(firstRawToken).not.toBe(secondRawToken);

      // The FIRST token must now be rejected as invalid/consumed.
      await expect(realTokenService.consume(firstRawToken, TokenType.EMAIL_VERIFICATION)).rejects.toMatchObject({
        errorCode: ErrorCode.AUTH_VERIFICATION_TOKEN_INVALID,
      });

      // The SECOND (latest) token still works.
      const consumed = await realTokenService.consume(secondRawToken, TokenType.EMAIL_VERIFICATION);
      expect(consumed).toEqual({ userId: 3, targetEmail: 'segundo@example.com' });
    });

    it('(b) pendingEmail taken by another account before verification → 409, pendingEmail cleared, token spent', async () => {
      const tokenStore = new FakeUserTokenStore();
      const user = makeUser({
        id: 3,
        email: 'viejo@example.com',
        pendingEmail: 'codiciado@example.com',
        isEmailVerified: true,
      });
      const conflictingUser = makeUser({ id: 99, email: 'codiciado@example.com' });
      const userStore = new FakeUserStore([user, conflictingUser]);
      const service = buildService(userStore, tokenStore);
      const realTokenService = new TokenService(tokenStore.repo, tokenStore.dataSource);

      const rawToken = await realTokenService.issue(3, TokenType.EMAIL_VERIFICATION, 'codiciado@example.com');

      // Single call: the token is consumed as a SIDE EFFECT of this one
      // invocation (TokenService.consume runs before the conflict check), so
      // asserting both the error shape and the 409 status must happen off
      // the SAME rejection — a second call would hit "already consumed"
      // (400) instead of re-triggering the conflict path.
      let caught: any;
      try {
        await service.verifyEmail(rawToken);
        fail('expected verifyEmail to reject with USER_CONFLICT');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AppException);
      expect(caught.errorCode).toBe(ErrorCode.USER_CONFLICT);
      expect(caught.getStatus()).toBe(409);

      const persistedUser = userStore.users.find((u) => u.id === 3)!;
      expect(persistedUser.pendingEmail).toBeNull();
      expect(persistedUser.email).toBe('viejo@example.com'); // NOT swapped

      // Token spent: a second attempt with the SAME raw token must fail as
      // invalid/consumed, not merely re-fail on the conflict path.
      await expect(realTokenService.consume(rawToken, TokenType.EMAIL_VERIFICATION)).rejects.toMatchObject({
        errorCode: ErrorCode.AUTH_VERIFICATION_TOKEN_INVALID,
      });
    });

    it('(c) swap guard: token whose targetEmail ≠ current pendingEmail performs NO swap', async () => {
      const tokenStore = new FakeUserTokenStore();
      const user = makeUser({
        id: 3,
        email: 'viejo@example.com',
        pendingEmail: 'mas-reciente@example.com', // user re-requested the change AFTER this token was issued
        isEmailVerified: true,
      });
      const userStore = new FakeUserStore([user]);
      const service = buildService(userStore, tokenStore);
      const realTokenService = new TokenService(tokenStore.repo, tokenStore.dataSource);

      // Issue a token for the STALE target directly (bypassing issue()'s
      // consume-prior, to simulate an out-of-band/stale token reaching
      // verify-email — the guard must hold even in that pathological case).
      const staleRow: UserToken = {
        id: 'stale-1',
        userId: 3,
        tokenHash: require('crypto').createHash('sha256').update('stale-raw').digest('hex'),
        type: TokenType.EMAIL_VERIFICATION,
        targetEmail: 'viejo-pendiente@example.com',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        createdAt: new Date(),
      };
      tokenStore.rows.push(staleRow);

      await service.verifyEmail('stale-raw');

      const persistedUser = userStore.users.find((u) => u.id === 3)!;
      expect(persistedUser.email).toBe('viejo@example.com'); // unchanged
      expect(persistedUser.pendingEmail).toBe('mas-reciente@example.com'); // unchanged
      expect(persistedUser.isEmailVerified).toBe(true); // account-level flags still get set
    });

    it('(d) verify with targetEmail === user.email (initial verification) sets flags WITHOUT touching email', async () => {
      const tokenStore = new FakeUserTokenStore();
      const user = makeUser({
        id: 3,
        email: 'nuevo-usuario@example.com',
        pendingEmail: null as unknown as string,
        isEmailVerified: false,
        emailVerifiedAt: null as unknown as Date,
      });
      const userStore = new FakeUserStore([user]);
      const service = buildService(userStore, tokenStore);
      const realTokenService = new TokenService(tokenStore.repo, tokenStore.dataSource);

      // Registration issues the token with targetEmail = user.email (D4).
      const rawToken = await realTokenService.issue(3, TokenType.EMAIL_VERIFICATION, 'nuevo-usuario@example.com');

      await service.verifyEmail(rawToken);

      const persistedUser = userStore.users.find((u) => u.id === 3)!;
      expect(persistedUser.isEmailVerified).toBe(true);
      expect(persistedUser.emailVerifiedAt).toBeInstanceOf(Date);
      expect(persistedUser.email).toBe('nuevo-usuario@example.com'); // untouched — same value, no swap performed
      expect(persistedUser.pendingEmail).toBeNull();
    });
  });
});
