import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
    @IsString()
    @IsNotEmpty({ message: 'El token es requerido' })
    token: string;

    @IsString()
    @MinLength(8, { message: 'La nueva contraseña debe tener al menos 8 caracteres' })
    newPassword: string;
}
