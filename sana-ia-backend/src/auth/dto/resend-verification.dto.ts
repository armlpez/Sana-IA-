import { IsEmail, IsNotEmpty } from 'class-validator';

export class ResendVerificationDto {
    @IsEmail({}, { message: 'El formato del correo es inválido' })
    @IsNotEmpty({ message: 'El correo es requerido' })
    email: string;
}
