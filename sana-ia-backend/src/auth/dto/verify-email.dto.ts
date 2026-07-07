import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyEmailDto {
    @IsString()
    @IsNotEmpty({ message: 'El token es requerido' })
    token: string;
}
