import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OCR_QUEUE_NAME, OcrJobPayload } from './ocr.job';

/**
 * Producer side — enqueues OCR jobs into BullMQ.
 *
 * The controller calls this after persisting the OcrResult row in Postgres.
 * The job payload contains ONLY reference IDs (PHI-safe).
 */
@Injectable()
export class OcrProducer {
    private readonly logger = new Logger(OcrProducer.name);

    constructor(
        @InjectQueue(OCR_QUEUE_NAME) private readonly ocrQueue: Queue,
    ) {}

    async enqueue(payload: OcrJobPayload): Promise<string> {
        const job = await this.ocrQueue.add('process-lab-image', payload, {
            // Deterministic job ID for idempotency — prevents duplicate processing
            // if the client retries the upload before the first job finishes.
            jobId: `ocr-${payload.ocrResultId}`,
        });

        this.logger.log(
            `OCR job enqueued — jobId: ${job.id}, ocrResultId: ${payload.ocrResultId}`,
        );

        return job.id!;
    }
}
