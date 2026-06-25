import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Consultation } from './entities/consultation.entity';
import { Diagnosis } from './entities/diagnosis.entity';
import { ConsultationsService } from './consultations.service';

@Module({
    imports: [TypeOrmModule.forFeature([Consultation, Diagnosis])],
    providers: [ConsultationsService],
    exports: [TypeOrmModule, ConsultationsService],
})
export class ConsultationsModule { }
