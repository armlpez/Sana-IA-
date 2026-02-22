import {
  IsEmail,
  IsString,
  MinLength,
  IsDateString,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  MaxLength,
  IsOptional
} from 'class-validator';

export class CreateUserDto {

  @IsEmail({}, { message: 'El formato del correo es inválido' })
  @IsNotEmpty({ message: 'El correo es requerido' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @MaxLength(50, { message: 'El nombre debe tener menos de 50 caracteres' })
  name: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password: string;

  @IsOptional()
  birthDate: Date;

  @IsBoolean()
  disclaimerAccepted: boolean;

}