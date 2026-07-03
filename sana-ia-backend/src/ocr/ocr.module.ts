import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OcrResult } from './entities/ocr-result.entity';
import { OcrController } from './ocr.controller';
import { OcrProducer } from './ocr.producer';
import { OcrWorker } from './ocr.worker';
import { AiModule } from '../ai/ai.module';
import { StorageModule } from '../storage/storage.module';
import { OCR_QUEUE_NAME } from './ocr.job';

@Module({
    imports: [
        TypeOrmModule.forFeature([OcrResult]),
        BullModule.registerQueue({
            name: OCR_QUEUE_NAME,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000, // 2s → 4s → 8s
                },
                removeOnComplete: { age: 3600, count: 100 },
                removeOnFail: { age: 86400 }, // Keep failed jobs 24h for debugging
            },
        }),
        // Import AiModule to use GeminiClientService in the worker
        AiModule,
        StorageModule,
    ],
    controllers: [OcrController],
    providers: [OcrProducer, OcrWorker],
    exports: [TypeOrmModule],
})
export class OcrModule {}
