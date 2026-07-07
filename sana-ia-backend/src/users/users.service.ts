import { BadRequestException, ConflictException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../roles/entities/role.entity';
import * as bcrypt from 'bcrypt';
import { RoleEnum } from '../enums/role.enums';
import { ConfigService } from '@nestjs/config';
import { TokenService } from '../tokens/token.service';
import { TokenType } from '../tokens/enums/token-type.enum';
import { EmailProducer } from '../email/email.producer';
import { verificationEmailTemplate } from '../email/templates/verification-email.template';

@Injectable()
export class UsersService {

  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Role)
    private roleRepository: Repository<Role>,
    private readonly tokenService: TokenService,
    private readonly emailProducer: EmailProducer,
    private readonly configService: ConfigService,
  ) { }

  async create(createUserDto: CreateUserDto) {

    try {

      const user = await this.userRepository.findOneBy({ email: createUserDto.email });

      if (user) {
        this.logger.warn(`Email ${createUserDto.email} already in use`);
        throw new ConflictException('Email already in use');
      }

      const role = await this.roleRepository.findOneBy({ name: RoleEnum.USER });

      if (!role) {
        this.logger.warn(`Role with name ${RoleEnum.USER} not found`);
        throw new NotFoundException('Role not found');
      }

      const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

      const userInstance = this.userRepository.create({
        ...createUserDto,
        password: hashedPassword,
        role: role,
        isEmailVerified: false,
      })

      const savedUser = await this.userRepository.save(userInstance);

      // Verification email issuance/enqueue must NOT roll back registration:
      // the user can always request a new link via resend-verification later.
      await this.issueAndSendVerificationEmail(savedUser.id, savedUser.email);

      return savedUser;

    } catch (error) {
      // Domain errors (e.g. duplicate email -> ConflictException 409, missing role
      // -> NotFoundException 404) must reach the GlobalExceptionFilter untouched so
      // it maps them to the correct status/errorCode. Only wrap UNEXPECTED errors as 500.
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Error creating user', error.stack);
      throw new InternalServerErrorException('Error creating user');
    }
  }

  /**
   * Issues an EMAIL_VERIFICATION token for `targetEmail` and enqueues the
   * verification email. Failures here must NEVER roll back the caller's
   * transaction (registration / email-change): log and continue — the user
   * can always request a new link via resend-verification later.
   */
  private async issueAndSendVerificationEmail(userId: number, targetEmail: string): Promise<void> {
    try {
      const rawToken = await this.tokenService.issue(userId, TokenType.EMAIL_VERIFICATION, targetEmail);
      const frontendUrl = this.configService.get<string>('FRONTEND_URL');
      const emailContent = verificationEmailTemplate(frontendUrl as string, rawToken);

      await this.emailProducer.enqueue({
        to: targetEmail,
        ...emailContent,
      });
    } catch (error) {
      this.logger.error(
        `Failed to issue/enqueue verification email for user ${userId} (${targetEmail})`,
        error.stack,
      );
    }
  }

  /**
   * Starts an email change: validates the new address isn't already taken,
   * stores it in `pendingEmail` WITHOUT touching `email` (no logout, no
   * isEmailVerified change on the current account), and issues a
   * verification email to the NEW address. The change only takes effect
   * once the user clicks the verification link (handled by auth's
   * verify-email flow, which swaps email <- pendingEmail).
   */
  async requestEmailChange(userId: number, newEmail: string): Promise<{ message: string }> {
    try {
      const user = await this.userRepository.findOneBy({ id: userId });

      if (!user) {
        this.logger.warn(`User with id ${userId} not found`);
        throw new NotFoundException('User not found');
      }

      if (newEmail !== user.email) {
        const existingUser = await this.userRepository.findOneBy({ email: newEmail });

        if (existingUser && existingUser.id !== userId) {
          this.logger.warn(`Email ${newEmail} already in use`);
          throw new ConflictException('Email already in use');
        }
      }

      user.pendingEmail = newEmail;
      await this.userRepository.save(user);

      await this.issueAndSendVerificationEmail(userId, newEmail);

      return {
        message:
          'Tu solicitud de cambio de correo fue registrada. Te enviamos un enlace de verificación a tu nueva dirección; tu correo actual seguirá activo hasta que confirmes el cambio.',
      };

    } catch (error) {

      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Error requesting email change for user ${userId}`, error.stack);
      throw new InternalServerErrorException('Error requesting email change');
    }
  }

  async findAll() {

    try {

      return await this.userRepository.find();
    } catch (error) {

      this.logger.error('Error fetching users', error.stack);
      throw new InternalServerErrorException('Error fetching users');
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    try {
      return await this.userRepository.findOne({
        where: { email },
        relations: ['role'],
      });
    } catch (error) {
      this.logger.error(`Error finding user by email ${email}`, error.stack);
      throw new InternalServerErrorException('Error finding user');
    }
  }

  async findOne(id: number) {

    try {

      const user = await this.userRepository.findOne({
        where: { id },
        relations: ['role'],
      });

      if (!user) {
        this.logger.warn(`User with id ${id} not found`);
        throw new NotFoundException(`User not found`);
      }

      return user;

    } catch (error) {

      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Error fetching user with id ${id}`, error.stack);
      throw new InternalServerErrorException('Error fetching user');
    }
  }

  async update(id: number, updateUserDto: UpdateUserDto) {

    try {

      const user = await this.userRepository.findOneBy({ id });

      if (!user) {
        this.logger.warn(`User with id ${id} not found`);
        throw new NotFoundException('User not found');
      }

      if (updateUserDto.email) {
        const { email } = updateUserDto;

        if (email !== user.email) {
          const existingUser = await this.userRepository.findOneBy({ email });

          if (existingUser && existingUser.id !== id) {
            this.logger.warn(`Email ${email} already in use`);
            throw new BadRequestException('Email already in use');
          }
        }
      }

      const { ...userData } = updateUserDto;

      const updatedUser = await this.userRepository.save({
        ...user,
        ...userData,
      });

      return updatedUser;

    } catch (error) {

      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Error updating user with id ${id}`, error.stack);
      throw new InternalServerErrorException('Error updating user');
    }
  }

  async remove(id: number) {

    try {

      const user = await this.userRepository.findOneBy({ id });

      if (!user) {
        this.logger.warn(`User with id ${id} not found`);
        throw new NotFoundException(`User with id not found`);
      }

      user.isActive = false;

      await this.userRepository.save(user);
      this.logger.log(`User with id ${id} has been deactivated`);

      return { success: true };

    } catch (error) {

      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Error removing user with id ${id}`, error.stack);
      throw new InternalServerErrorException('Error removing user');
    }
  }
}
