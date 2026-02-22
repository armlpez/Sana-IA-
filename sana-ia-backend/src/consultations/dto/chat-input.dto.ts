import { IsNotEmpty, IsOptional, IsString, IsNumber, MaxLength } from 'class-validator';

export class ChatInputDto {
    @IsString()
    @IsNotEmpty({ message: 'El mensaje es requerido' })
    @MaxLength(2000, { message: 'El mensaje no puede exceder 2000 caracteres' })
    message: string;

    @IsOptional()
    @IsNumber()
    conversationId?: number;
}
