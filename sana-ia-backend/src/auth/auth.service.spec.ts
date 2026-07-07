import { Repository } from 'typeorm';
import { HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { TokenService } from '../tokens/token.service';
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

describe('AuthService', () => {
  let usersService: jest.Mocked<UsersService>;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;
  let refreshTokenRepository: jest.Mocked<Repository<RefreshToken>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let tokenService: jest.Mocked<TokenService>;
  let emailProducer: jest.Mocked<EmailProducer>;
  let service: AuthService;

  const configValues: Record<string, string | undefined> = {
    JWT_REFRESH_SECRET: 'refresh-secret',
    JWT_REFRESH_EXPIRATION: '7d',
    FRONTEND_URL: 'http://localhost:3000',
    EMAIL_VERIFICATION_ENFORCED: 'true',
  };

  beforeEach(() => {
    usersService = {
      findByEmail: jest.fn(),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;

    jwtService = {
      sign: jest.fn().mockReturnValue('signed-jwt'),
      verify: jest.fn(),
      decode: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;

    configService = {
      get: jest.fn((key: string) => configValues[key]),
    } as unknown as jest.Mocked<ConfigService>;

    refreshTokenRepository = {
      save: jest.fn(),
      find: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<Repository<RefreshToken>>;

    userRepository = {
      findOneBy: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<User>>;

    tokenService = {
      issue: jest.fn().mockResolvedValue('raw-token-value'),
      consume: jest.fn(),
    } as unknown as jest.Mocked<TokenService>;

    emailProducer = {
      enqueue: jest.fn().mockResolvedValue('job-id-1'),
    } as unknown as jest.Mocked<EmailProducer>;

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

  describe('validateUser — email verification gate', () => {
    it('returns null when the user does not exist (no leak)', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      const result = await service.validateUser('nadie@example.com', 'whatever');

      expect(result).toBeNull();
    });

    it('returns null on wrong password for a VERIFIED user (unchanged behavior)', async () => {
      const user = makeUser({
        isEmailVerified: true,
        password: await bcrypt.hash('correct-password', 10),
      });
      usersService.findByEmail.mockResolvedValue(user);

      const result = await service.validateUser(user.email, 'wrong-password');

      expect(result).toBeNull();
    });

    it('returns null on wrong password for an UNVERIFIED user — IDENTICAL to the verified case (no status leak)', async () => {
      const user = makeUser({
        isEmailVerified: false,
        password: await bcrypt.hash('correct-password', 10),
      });
      usersService.findByEmail.mockResolvedValue(user);

      await expect(service.validateUser(user.email, 'wrong-password')).resolves.toBeNull();
    });

    it('logs in a VERIFIED user unchanged on correct password', async () => {
      const user = makeUser({
        isEmailVerified: true,
        password: await bcrypt.hash('correct-password', 10),
      });
      usersService.findByEmail.mockResolvedValue(user);

      const result = await service.validateUser(user.email, 'correct-password');

      expect(result).toEqual(expect.objectContaining({ id: user.id, email: user.email }));
      expect((result as any).password).toBeUndefined();
    });

    it('throws AUTH_EMAIL_NOT_VERIFIED (403, Spanish publicMessage) for an UNVERIFIED user ONLY after a correct password', async () => {
      const user = makeUser({
        isEmailVerified: false,
        password: await bcrypt.hash('correct-password', 10),
      });
      usersService.findByEmail.mockResolvedValue(user);

      await expect(service.validateUser(user.email, 'correct-password')).rejects.toMatchObject({
        errorCode: ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
      });

      try {
        await service.validateUser(user.email, 'correct-password');
        fail('expected AppException to be thrown');
      } catch (e: any) {
        expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect(e.publicMessage).toBe(
          'Tu cuenta aún no ha sido verificada. Revisa tu correo o solicita un nuevo enlace de verificación.',
        );
      }
    });

    it('skips ONLY the gate when EMAIL_VERIFICATION_ENFORCED=false — unverified user logs in', async () => {
      configService.get = jest.fn((key: string) =>
        key === 'EMAIL_VERIFICATION_ENFORCED' ? 'false' : configValues[key],
      ) as any;
      const user = makeUser({
        isEmailVerified: false,
        password: await bcrypt.hash('correct-password', 10),
      });
      usersService.findByEmail.mockResolvedValue(user);

      const result = await service.validateUser(user.email, 'correct-password');

      expect(result).toEqual(expect.objectContaining({ id: user.id }));
    });

    it('defaults to enforced when EMAIL_VERIFICATION_ENFORCED is unset', async () => {
      configService.get = jest.fn((key: string) =>
        key === 'EMAIL_VERIFICATION_ENFORCED' ? undefined : configValues[key],
      ) as any;
      const user = makeUser({
        isEmailVerified: false,
        password: await bcrypt.hash('correct-password', 10),
      });
      usersService.findByEmail.mockResolvedValue(user);

      await expect(service.validateUser(user.email, 'correct-password')).rejects.toMatchObject({
        errorCode: ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
      });
    });
  });

  describe('validateLogin — gate propagation', () => {
    it('propagates AUTH_EMAIL_NOT_VERIFIED as a 403 AppException from validateLogin', async () => {
      const user = makeUser({
        isEmailVerified: false,
        password: await bcrypt.hash('correct-password', 10),
      });
      usersService.findByEmail.mockResolvedValue(user);

      await expect(service.validateLogin(user.email, 'correct-password')).rejects.toMatchObject({
        errorCode: ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
      });
    });

    it('still throws the generic invalid-credentials error on wrong password (unaffected by the gate)', async () => {
      const user = makeUser({
        isEmailVerified: false,
        password: await bcrypt.hash('correct-password', 10),
      });
      usersService.findByEmail.mockResolvedValue(user);

      await expect(service.validateLogin(user.email, 'wrong-password')).rejects.toThrow(
        'Credenciales inválidas',
      );
    });
  });

  describe('revokeAllForUser', () => {
    it('issues a single bulk UPDATE for all active refresh tokens of the user (not a loop)', async () => {
      refreshTokenRepository.update.mockResolvedValue({ affected: 3 } as any);

      await service.revokeAllForUser(42);

      expect(refreshTokenRepository.update).toHaveBeenCalledTimes(1);
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ isRevoked: false }),
        { isRevoked: true },
      );
      expect(refreshTokenRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('forgotPassword', () => {
    it('issues a PASSWORD_RESET token and enqueues the reset email when the user exists', async () => {
      const user = makeUser();
      usersService.findByEmail.mockResolvedValue(user);

      await service.forgotPassword(user.email);

      expect(tokenService.issue).toHaveBeenCalledWith(user.id, TokenType.PASSWORD_RESET);
      expect(emailProducer.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: user.email, html: expect.stringContaining('raw-token-value') }),
      );
    });

    it('resolves successfully without issuing a token when the email does not exist (anti-enumeration)', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(service.forgotPassword('nadie@example.com')).resolves.toBeUndefined();
      expect(tokenService.issue).not.toHaveBeenCalled();
      expect(emailProducer.enqueue).not.toHaveBeenCalled();
    });

    it('never throws, even when the user lookup itself fails', async () => {
      usersService.findByEmail.mockRejectedValue(new Error('db down'));

      await expect(service.forgotPassword('cualquiera@example.com')).resolves.toBeUndefined();
    });

    it('does NOT throw when the email enqueue fails (log-and-continue, mirrors PR3)', async () => {
      const user = makeUser();
      usersService.findByEmail.mockResolvedValue(user);
      emailProducer.enqueue.mockRejectedValue(new Error('queue down'));
      const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation();

      await expect(service.forgotPassword(user.email)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('consumes the PASSWORD_RESET token, rotates the bcrypt hash, and revokes all sessions', async () => {
      const user = makeUser({ id: 5, isEmailVerified: true });
      tokenService.consume.mockResolvedValue({ userId: 5, targetEmail: null });
      userRepository.findOneBy.mockResolvedValue(user);
      userRepository.save.mockImplementation(async (data: any) => data);
      refreshTokenRepository.update.mockResolvedValue({ affected: 2 } as any);

      await service.resetPassword('raw-reset-token', 'NuevaPassword123');

      expect(tokenService.consume).toHaveBeenCalledWith('raw-reset-token', TokenType.PASSWORD_RESET);
      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.password).not.toBe('hashed-password');
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ isRevoked: false }),
        { isRevoked: true },
      );
    });

    it('sets isEmailVerified=true when the user was previously unverified (reset proves ownership)', async () => {
      const user = makeUser({
        id: 5,
        isEmailVerified: false,
        emailVerifiedAt: null as unknown as Date,
      });
      tokenService.consume.mockResolvedValue({ userId: 5, targetEmail: null });
      userRepository.findOneBy.mockResolvedValue(user);
      userRepository.save.mockImplementation(async (data: any) => data);

      await service.resetPassword('raw-reset-token', 'NuevaPassword123');

      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.isEmailVerified).toBe(true);
      expect(savedArg.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('does NOT touch emailVerifiedAt when the user was already verified', async () => {
      const verifiedAt = new Date('2025-01-01');
      const user = makeUser({ id: 5, isEmailVerified: true, emailVerifiedAt: verifiedAt });
      tokenService.consume.mockResolvedValue({ userId: 5, targetEmail: null });
      userRepository.findOneBy.mockResolvedValue(user);
      userRepository.save.mockImplementation(async (data: any) => data);

      await service.resetPassword('raw-reset-token', 'NuevaPassword123');

      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.emailVerifiedAt).toBe(verifiedAt);
    });

    it('propagates ERR_AUTH_008 (invalid/consumed) unchanged from TokenService, without touching the user', async () => {
      tokenService.consume.mockRejectedValue(
        new AppException({
          errorCode: ErrorCode.AUTH_RESET_TOKEN_INVALID,
          message: 'invalid',
          statusCode: HttpStatus.BAD_REQUEST,
          publicMessage: 'El enlace no es válido. Por favor solicita uno nuevo.',
        }),
      );

      await expect(service.resetPassword('bad-token', 'NuevaPassword123')).rejects.toMatchObject({
        errorCode: ErrorCode.AUTH_RESET_TOKEN_INVALID,
      });
      expect(userRepository.save).not.toHaveBeenCalled();
      expect(refreshTokenRepository.update).not.toHaveBeenCalled();
    });

    it('propagates ERR_AUTH_009 (expired) unchanged from TokenService', async () => {
      tokenService.consume.mockRejectedValue(
        new AppException({
          errorCode: ErrorCode.AUTH_RESET_TOKEN_EXPIRED,
          message: 'expired',
          statusCode: HttpStatus.BAD_REQUEST,
          publicMessage: 'El enlace ha expirado. Por favor solicita uno nuevo.',
        }),
      );

      await expect(service.resetPassword('bad-token', 'NuevaPassword123')).rejects.toMatchObject({
        errorCode: ErrorCode.AUTH_RESET_TOKEN_EXPIRED,
      });
    });
  });

  describe('verifyEmail', () => {
    it('sets isEmailVerified=true and emailVerifiedAt on a valid initial-verification token (no swap)', async () => {
      const user = makeUser({
        id: 3,
        email: 'user@example.com',
        isEmailVerified: false,
        pendingEmail: null as unknown as string,
      });
      tokenService.consume.mockResolvedValue({ userId: 3, targetEmail: 'user@example.com' });
      userRepository.findOneBy.mockResolvedValue(user);
      userRepository.save.mockImplementation(async (data: any) => data);

      await service.verifyEmail('raw-verify-token');

      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.isEmailVerified).toBe(true);
      expect(savedArg.emailVerifiedAt).toBeInstanceOf(Date);
      expect(savedArg.email).toBe('user@example.com');
    });

    it('swaps email <- pendingEmail and clears pendingEmail on a pending-change token', async () => {
      const user = makeUser({
        id: 3,
        email: 'viejo@example.com',
        pendingEmail: 'nuevo@example.com',
        isEmailVerified: true,
      });
      tokenService.consume.mockResolvedValue({ userId: 3, targetEmail: 'nuevo@example.com' });
      userRepository.findOneBy.mockImplementation(async (where: any) => {
        if (where.id === 3) return user;
        return null; // uniqueness re-check: nobody else owns 'nuevo@example.com'
      });
      userRepository.save.mockImplementation(async (data: any) => data);

      await service.verifyEmail('raw-verify-token');

      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.email).toBe('nuevo@example.com');
      expect(savedArg.pendingEmail).toBeNull();
    });

    it('throws USER_CONFLICT (409) and clears pendingEmail when the target email was claimed meanwhile', async () => {
      const user = makeUser({
        id: 3,
        email: 'viejo@example.com',
        pendingEmail: 'nuevo@example.com',
        isEmailVerified: true,
      });
      const conflictingUser = makeUser({ id: 99, email: 'nuevo@example.com' });
      tokenService.consume.mockResolvedValue({ userId: 3, targetEmail: 'nuevo@example.com' });
      userRepository.findOneBy.mockImplementation(async (where: any) => {
        if (where.id === 3) return user;
        if (where.email === 'nuevo@example.com') return conflictingUser;
        return null;
      });
      userRepository.save.mockImplementation(async (data: any) => data);

      await expect(service.verifyEmail('raw-verify-token')).rejects.toMatchObject({
        errorCode: ErrorCode.USER_CONFLICT,
      });

      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.pendingEmail).toBeNull();
      expect(savedArg.email).toBe('viejo@example.com'); // NOT swapped
    });

    it('does NOT swap when targetEmail is stale (no longer matches the current pendingEmail)', async () => {
      const user = makeUser({
        id: 3,
        email: 'viejo@example.com',
        pendingEmail: 'mas-nuevo@example.com', // user changed again after this token was issued
        isEmailVerified: true,
      });
      tokenService.consume.mockResolvedValue({ userId: 3, targetEmail: 'nuevo@example.com' });
      userRepository.findOneBy.mockResolvedValue(user);
      userRepository.save.mockImplementation(async (data: any) => data);

      await service.verifyEmail('raw-verify-token');

      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.email).toBe('viejo@example.com');
      expect(savedArg.pendingEmail).toBe('mas-nuevo@example.com');
    });

    it('propagates ERR_AUTH_010 (invalid/consumed) unchanged from TokenService', async () => {
      tokenService.consume.mockRejectedValue(
        new AppException({
          errorCode: ErrorCode.AUTH_VERIFICATION_TOKEN_INVALID,
          message: 'invalid',
          statusCode: HttpStatus.BAD_REQUEST,
          publicMessage: 'El enlace no es válido. Por favor solicita uno nuevo.',
        }),
      );

      await expect(service.verifyEmail('bad-token')).rejects.toMatchObject({
        errorCode: ErrorCode.AUTH_VERIFICATION_TOKEN_INVALID,
      });
    });

    it('propagates ERR_AUTH_011 (expired) unchanged from TokenService', async () => {
      tokenService.consume.mockRejectedValue(
        new AppException({
          errorCode: ErrorCode.AUTH_VERIFICATION_TOKEN_EXPIRED,
          message: 'expired',
          statusCode: HttpStatus.BAD_REQUEST,
          publicMessage: 'El enlace ha expirado. Por favor solicita uno nuevo.',
        }),
      );

      await expect(service.verifyEmail('bad-token')).rejects.toMatchObject({
        errorCode: ErrorCode.AUTH_VERIFICATION_TOKEN_EXPIRED,
      });
    });
  });

  describe('resendVerification', () => {
    it('issues a new EMAIL_VERIFICATION token and enqueues an email for an existing UNVERIFIED user', async () => {
      const user = makeUser({ isEmailVerified: false });
      usersService.findByEmail.mockResolvedValue(user);

      await service.resendVerification(user.email);

      expect(tokenService.issue).toHaveBeenCalledWith(user.id, TokenType.EMAIL_VERIFICATION, user.email);
      expect(emailProducer.enqueue).toHaveBeenCalledWith(expect.objectContaining({ to: user.email }));
    });

    it('does nothing for an existing but ALREADY-VERIFIED user (anti-enumeration)', async () => {
      const user = makeUser({ isEmailVerified: true });
      usersService.findByEmail.mockResolvedValue(user);

      await expect(service.resendVerification(user.email)).resolves.toBeUndefined();
      expect(tokenService.issue).not.toHaveBeenCalled();
      expect(emailProducer.enqueue).not.toHaveBeenCalled();
    });

    it('does nothing for a NON-EXISTENT email, resolving successfully (anti-enumeration)', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(service.resendVerification('nadie@example.com')).resolves.toBeUndefined();
      expect(tokenService.issue).not.toHaveBeenCalled();
      expect(emailProducer.enqueue).not.toHaveBeenCalled();
    });

    it('never throws even when the lookup fails', async () => {
      usersService.findByEmail.mockRejectedValue(new Error('db down'));

      await expect(service.resendVerification('cualquiera@example.com')).resolves.toBeUndefined();
    });
  });
});
