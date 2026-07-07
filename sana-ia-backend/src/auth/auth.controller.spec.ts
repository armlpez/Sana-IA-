import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

describe('AuthController', () => {
  let authService: jest.Mocked<AuthService>;
  let usersService: jest.Mocked<UsersService>;
  let controller: AuthController;

  const req = { user: { id: 7, email: 'actual@example.com', role: 'user' } };

  beforeEach(() => {
    authService = {} as jest.Mocked<AuthService>;

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
});
