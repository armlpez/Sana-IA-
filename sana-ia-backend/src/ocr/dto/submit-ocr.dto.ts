import { IsNumber, IsOptional, IsString } from 'class-validator';

export class SubmitOcrDto {
    @IsOptional()
    @IsNumber()
    consultationId?: number;

    @IsOptional()
    @IsString()
    originalFilename?: string;
}
