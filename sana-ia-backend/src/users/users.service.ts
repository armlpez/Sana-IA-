import { BadRequestException, ConflictException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from 'src/roles/entities/role.entity';
import * as bcrypt from 'bcrypt';
import { RoleEnum } from 'src/enums/role.enums';

@Injectable()
export class UsersService {

  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Role)
    private roleRepository: Repository<Role>,
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
        role: role
      })

      return await this.userRepository.save(userInstance);

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
