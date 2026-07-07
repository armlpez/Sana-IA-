import 'reflect-metadata';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

const THROTTLER_TTL_KEY = 'THROTTLER:TTL';
const THROTTLER_LIMIT_KEY = 'THROTTLER:LIMIT';

/** Reads the `@Throttle({ [tier]: {...} })` metadata NestJS attaches to a controller method. */
function getThrottleConfig(handler: (...args: any[]) => any, tier: string) {
  return {
    ttl: Reflect.getMetadata(THROTTLER_TTL_KEY + tier, handler),
    limit: Reflect.getMetadata(THROTTLER_LIMIT_KEY + tier, handler),
  };
}

describe('AuthController', () => {
  let authService: jest.Mocked<AuthService>;
  let usersService: jest.Mocked<UsersService>;
  let controller: AuthController;

  const req = { user: { id: 7, email: 'actual@example.com', role: 'user' } };

  beforeEach(() => {
    authService = {
      forgotPassword: jest.fn().mockResolvedValue(undefined),
      resetPassword: jest.fn().mockResolvedValue(undefined),
      verifyEmail: jest.fn().mockResolvedValue(undefined),
      resendVerification: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuthService>;

    usersService = {
      update: jest.fn(),
      requestEmailChange: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;

    controller = new AuthController(authService, usersService);
  });

  describe('updateProfile', () => {
    it('updates normally when the DTO has no email field', async () => {
      usersService.update.mockResolvedValue({ id: 7, name: 'Nuevo Nombre' } as any);

      const result = await controller.updateProfile(req, { name: 'Nuevo Nombre' } as any);

      expect(usersService.update).toHaveBeenCalledWith(7, { name: 'Nuevo Nombre' });
      expect(usersService.requestEmailChange).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 7, name: 'Nuevo Nombre' });
    });

    it('updates normally when the DTO email matches the current email (no-op change)', async () => {
      usersService.update.mockResolvedValue({ id: 7, email: 'actual@example.com' } as any);

      await controller.updateProfile(req, { email: 'actual@example.com', name: 'X' } as any);

      expect(usersService.update).toHaveBeenCalledWith(7, { email: 'actual@example.com', name: 'X' });
      expect(usersService.requestEmailChange).not.toHaveBeenCalled();
    });

    it('diverts to requestEmailChange when the DTO email differs from the current one', async () => {
      usersService.requestEmailChange.mockResolvedValue({
        message: 'Te enviamos un enlace de verificación a tu nueva dirección.',
      });

      const result = await controller.updateProfile(req, { email: 'nuevo@example.com' } as any);

      expect(usersService.requestEmailChange).toHaveBeenCalledWith(7, 'nuevo@example.com');
      expect(usersService.update).not.toHaveBeenCalled();
      expect(result.message).toMatch(/verificaci[oó]n/i);
    });

    it('updates other fields AND diverts the email in the same request', async () => {
      usersService.update.mockResolvedValue({ id: 7, name: 'Nuevo Nombre' } as any);
      usersService.requestEmailChange.mockResolvedValue({
        message: 'Te enviamos un enlace de verificación a tu nueva dirección.',
      });

      const result = await controller.updateProfile(req, {
        email: 'nuevo@example.com',
        name: 'Nuevo Nombre',
      } as any);

      expect(usersService.update).toHaveBeenCalledWith(7, { name: 'Nuevo Nombre' });
      expect(usersService.requestEmailChange).toHaveBeenCalledWith(7, 'nuevo@example.com');
      expect(result).toEqual(
        expect.objectContaining({
          id: 7,
          name: 'Nuevo Nombre',
          message: expect.stringMatching(/verificaci[oó]n/i),
        }),
      );
    });

    it('never passes the new email to usersService.update directly', async () => {
      usersService.requestEmailChange.mockResolvedValue({ message: 'pendiente de verificación' });

      await controller.updateProfile(req, { email: 'nuevo@example.com', name: 'X' } as any);

      const updateCallArg = usersService.update.mock.calls[0]?.[1] as any;
      expect(updateCallArg?.email).toBeUndefined();
    });
  });

  describe('forgotPassword', () => {
    it('calls authService.forgotPassword with the DTO email and returns the generic Spanish message', async () => {
      const result = await controller.forgotPassword({ email: 'exists@example.com' } as any);

      expect(authService.forgotPassword).toHaveBeenCalledWith('exists@example.com');
      expect(result).toEqual({ message: 'Si el correo existe, enviaremos instrucciones.' });
    });

    it('returns a BYTE-IDENTICAL body whether or not the underlying service resolves for an existing account', async () => {
      // Anti-enumeration: the service call always resolves void regardless of
      // existence (PR4 behavior); the controller must never branch on it.
      authService.forgotPassword.mockResolvedValueOnce(undefined);
      const forExisting = await controller.forgotPassword({ email: 'exists@example.com' } as any);

      authService.forgotPassword.mockResolvedValueOnce(undefined);
      const forNonExisting = await controller.forgotPassword({ email: 'ghost@example.com' } as any);

      expect(forExisting).toEqual(forNonExisting);
      expect(JSON.stringify(forExisting)).toBe(JSON.stringify(forNonExisting));
    });
  });

  describe('resetPassword', () => {
    it('calls authService.resetPassword with token + newPassword and returns the success message', async () => {
      const result = await controller.resetPassword({
        token: 'raw-token',
        newPassword: 'newSecurePass1',
      } as any);

      expect(authService.resetPassword).toHaveBeenCalledWith('raw-token', 'newSecurePass1');
      expect(result).toEqual({ message: 'Tu contraseña ha sido restablecida correctamente.' });
    });
  });

  describe('verifyEmail', () => {
    it('calls authService.verifyEmail with the token and returns the success message', async () => {
      const result = await controller.verifyEmail({ token: 'raw-token' } as any);

      expect(authService.verifyEmail).toHaveBeenCalledWith('raw-token');
      expect(result).toEqual({ message: 'Tu cuenta ha sido verificada correctamente.' });
    });
  });

  describe('resendVerification', () => {
    it('calls authService.resendVerification with the DTO email and returns the generic Spanish message', async () => {
      const result = await controller.resendVerification({ email: 'exists@example.com' } as any);

      expect(authService.resendVerification).toHaveBeenCalledWith('exists@example.com');
      expect(result).toEqual({
        message: 'Si el correo existe y requiere verificación, enviaremos un nuevo enlace.',
      });
    });

    it('returns a BYTE-IDENTICAL body across an unverified-existing, already-verified, and non-existing email', async () => {
      authService.resendVerification.mockResolvedValueOnce(undefined);
      const unverified = await controller.resendVerification({ email: 'unverified@example.com' } as any);

      authService.resendVerification.mockResolvedValueOnce(undefined);
      const alreadyVerified = await controller.resendVerification({ email: 'verified@example.com' } as any);

      authService.resendVerification.mockResolvedValueOnce(undefined);
      const nonExisting = await controller.resendVerification({ email: 'ghost@example.com' } as any);

      expect(JSON.stringify(unverified)).toBe(JSON.stringify(alreadyVerified));
      expect(JSON.stringify(alreadyVerified)).toBe(JSON.stringify(nonExisting));
    });
  });

  describe('GET /auth/verify (HTML landing page)', () => {
    it('returns the rendered verify-email page with the query token embedded', () => {
      const html = controller.getVerifyEmailPage('query-token-123');

      expect(html).toContain('query-token-123');
      expect(html).toContain("fetch('/v1/auth/verify-email'");
    });
  });

  describe('GET /auth/reset (HTML landing page)', () => {
    it('returns the rendered reset-password page with the query token embedded', () => {
      const html = controller.getResetPasswordPage('query-token-456');

      expect(html).toContain('query-token-456');
      expect(html).toContain("fetch('/v1/auth/reset-password'");
    });
  });

  describe('auth-sensitive throttle metadata', () => {
    const tier = 'auth-sensitive';
    const expectedConfig = { ttl: 900_000, limit: 5 };

    it.each([
      ['forgotPassword'],
      ['resetPassword'],
      ['verifyEmail'],
      ['resendVerification'],
      ['getVerifyEmailPage'],
      ['getResetPasswordPage'],
    ])('applies the auth-sensitive tier (ttl 900_000, limit 5) to %s', (methodName) => {
      const handler = (AuthController.prototype as any)[methodName];
      expect(getThrottleConfig(handler, tier)).toEqual(expectedConfig);
    });
  });
});
