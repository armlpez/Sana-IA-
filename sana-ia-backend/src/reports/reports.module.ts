import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Consultation } from '../consultations/entities/consultation.entity';
import { Diagnosis } from '../consultations/entities/diagnosis.entity';
import { OcrResult } from '../ocr/entities/ocr-result.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
    imports: [TypeOrmModule.forFeature([Consultation, Diagnosis, OcrResult])],
    controllers: [ReportsController],
    providers: [ReportsService],
})
export class ReportsModule {}
