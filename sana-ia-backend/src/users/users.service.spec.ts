import { ConflictException, Repository } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { Role } from '../roles/entities/role.entity';
import { TokenService } from '../tokens/token.service';
import { EmailProducer } from '../email/email.producer';
import { ConfigService } from '@nestjs/config';
import { TokenType } from '../tokens/enums/token-type.enum';
import { RoleEnum } from '../enums/role.enums';

/** Builds a User row as it would come back from the repository. */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    email: 'nuevo@example.com',
    name: 'Nuevo Usuario',
    password: 'hashed-password',
    birthDate: new Date('2000-01-01'),
    isActive: true,
    disclaimerAccepted: true,
    disclaimerAcceptedAt: new Date(),
    isEmailVerified: false,
    emailVerifiedAt: null as unknown as Date,
    pendingEmail: null as unknown as string,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: { id: 2, name: RoleEnum.USER } as Role,
    refreshTokens: [],
    ...overrides,
  } as User;
}

describe('UsersService', () => {
  let userRepository: jest.Mocked<Repository<User>>;
  let roleRepository: jest.Mocked<Repository<Role>>;
  let tokenService: jest.Mocked<TokenService>;
  let emailProducer: jest.Mocked<EmailProducer>;
  let configService: jest.Mocked<ConfigService>;
  let service: UsersService;

  const createUserDto = {
    email: 'nuevo@example.com',
    name: 'Nuevo Usuario',
    password: 'password123',
    birthDate: new Date('2000-01-01'),
    disclaimerAccepted: true,
  };

  beforeEach(() => {
    userRepository = {
      findOneBy: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn(),
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<User>>;

    roleRepository = {
      findOneBy: jest.fn().mockResolvedValue({ id: 2, name: RoleEnum.USER }),
    } as unknown as jest.Mocked<Repository<Role>>;

    tokenService = {
      issue: jest.fn().mockResolvedValue('raw-token-value'),
      consume: jest.fn(),
    } as unknown as jest.Mocked<TokenService>;

    emailProducer = {
      enqueue: jest.fn().mockResolvedValue('job-id-1'),
    } as unknown as jest.Mocked<EmailProducer>;

    configService = {
      get: jest.fn().mockReturnValue('http://localhost:3000'),
    } as unknown as jest.Mocked<ConfigService>;

    service = new UsersService(
      userRepository,
      roleRepository,
      tokenService,
      emailProducer,
      configService,
    );
  });

  describe('create', () => {
    beforeEach(() => {
      userRepository.findOneBy.mockResolvedValue(null);
      userRepository.save.mockImplementation(async (data: any) => makeUser(data));
    });

    it('creates the user with isEmailVerified=false', async () => {
      const result = await service.create(createUserDto as any);

      expect(result.isEmailVerified).toBe(false);
      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.isEmailVerified).toBe(false);
    });

    it('issues an EMAIL_VERIFICATION token via TokenService targeting the new user', async () => {
      const result = await service.create(createUserDto as any);

      expect(tokenService.issue).toHaveBeenCalledWith(
        result.id,
        TokenType.EMAIL_VERIFICATION,
        result.email,
      );
    });

    it('renders the verification template and enqueues it via EmailProducer', async () => {
      const result = await service.create(createUserDto as any);

      expect(configService.get).toHaveBeenCalledWith('FRONTEND_URL');
      expect(emailProducer.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          to: result.email,
          subject: expect.any(String),
          html: expect.stringContaining('raw-token-value'),
          text: expect.stringContaining('raw-token-value'),
        }),
      );
    });

    it('does NOT roll back user creation when the email enqueue fails (logs and continues)', async () => {
      emailProducer.enqueue.mockRejectedValue(new Error('queue down'));
      const errorSpy = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation();

      const result = await service.create(createUserDto as any);

      expect(result).toBeDefined();
      expect(result.email).toBe(createUserDto.email);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('does NOT roll back user creation when the token issuance fails (logs and continues)', async () => {
      tokenService.issue.mockRejectedValue(new Error('db down'));
      const errorSpy = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation();

      const result = await service.create(createUserDto as any);

      expect(result).toBeDefined();
      expect(emailProducer.enqueue).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('still rejects duplicate emails before touching tokens/email', async () => {
      userRepository.findOneBy.mockResolvedValue(makeUser());

      await expect(service.create(createUserDto as any)).rejects.toThrow();
      expect(tokenService.issue).not.toHaveBeenCalled();
      expect(emailProducer.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('requestEmailChange', () => {
    const currentUser = makeUser({
      id: 7,
      email: 'actual@example.com',
      pendingEmail: null as unknown as string,
      isEmailVerified: true,
      emailVerifiedAt: new Date('2025-01-01'),
    });

    beforeEach(() => {
      userRepository.findOneBy.mockImplementation(async (where: any) => {
        if (where.id === 7) return currentUser;
        return null;
      });
      userRepository.save.mockImplementation(async (data: any) => data);
    });

    it('rejects when the new email already belongs to another user (conflict)', async () => {
      userRepository.findOneBy.mockImplementation(async (where: any) => {
        if (where.id === 7) return currentUser;
        if (where.email === 'tomado@example.com') return makeUser({ id: 99, email: 'tomado@example.com' });
        return null;
      });

      await expect(
        service.requestEmailChange(7, 'tomado@example.com'),
      ).rejects.toThrow(ConflictException);
      expect(tokenService.issue).not.toHaveBeenCalled();
      expect(emailProducer.enqueue).not.toHaveBeenCalled();
    });

    it('sets pendingEmail WITHOUT touching email', async () => {
      await service.requestEmailChange(7, 'nuevo-correo@example.com');

      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.pendingEmail).toBe('nuevo-correo@example.com');
      expect(savedArg.email).toBe('actual@example.com');
    });

    it('does NOT set isEmailVerified=false on the current (already verified) account', async () => {
      await service.requestEmailChange(7, 'nuevo-correo@example.com');

      const savedArg = userRepository.save.mock.calls[0][0] as any;
      expect(savedArg.isEmailVerified).toBe(true);
    });

    it('issues an EMAIL_VERIFICATION token with targetEmail=newEmail', async () => {
      await service.requestEmailChange(7, 'nuevo-correo@example.com');

      expect(tokenService.issue).toHaveBeenCalledWith(
        7,
        TokenType.EMAIL_VERIFICATION,
        'nuevo-correo@example.com',
      );
    });

    it('renders and enqueues the verification email to the NEW address', async () => {
      await service.requestEmailChange(7, 'nuevo-correo@example.com');

      expect(emailProducer.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'nuevo-correo@example.com',
          html: expect.stringContaining('raw-token-value'),
          text: expect.stringContaining('raw-token-value'),
        }),
      );
    });

    it('returns a Spanish message indicating the change is pending verification', async () => {
      const result = await service.requestEmailChange(7, 'nuevo-correo@example.com');

      expect(result.message).toMatch(/verifica|verificaci[oó]n/i);
    });

    it('does not roll back the pendingEmail change when the email enqueue fails', async () => {
      emailProducer.enqueue.mockRejectedValue(new Error('queue down'));
      const errorSpy = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation();

      const result = await service.requestEmailChange(7, 'nuevo-correo@example.com');

      expect(result).toBeDefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
