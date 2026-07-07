import { IsEmail, IsNotEmpty } from 'class-validator';

export class ForgotPasswordDto {
    @IsEmail({}, { message: 'El formato del correo es inválido' })
    @IsNotEmpty({ message: 'El correo es requerido' })
    email: string;
}
