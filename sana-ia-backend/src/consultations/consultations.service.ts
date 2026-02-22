import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Consultation } from './entities/consultation.entity';

@Injectable()
export class ConsultationsService {
    constructor(
        @InjectRepository(Consultation)
        private readonly consultationRepo: Repository<Consultation>,
    ) { }

    async findOne(id: number, userId: number): Promise<Consultation | null> {
        return this.consultationRepo.findOne({
            where: { id, userId },
        });
    }

    async findByUser(userId: number): Promise<Consultation[]> {
        return this.consultationRepo.find({
            where: { userId },
            order: { updatedAt: 'DESC' },
            select: ['id', 'title', 'summary', 'status', 'createdAt', 'updatedAt'],
        });
    }

    async findOneWithMessages(id: number, userId: number): Promise<Consultation | null> {
        return this.consultationRepo.findOne({
            where: { id, userId },
            relations: ['messages'],
            order: { messages: { createdAt: 'ASC' } },
        });
    }

    async create(data: Partial<Consultation>): Promise<Consultation> {
        const consultation = this.consultationRepo.create(data);
        return this.consultationRepo.save(consultation);
    }

    async update(id: number, data: Partial<Consultation>): Promise<void> {
        await this.consultationRepo.update(id, data);
    }
}
