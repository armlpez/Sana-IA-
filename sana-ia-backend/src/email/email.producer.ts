import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EMAIL_QUEUE_NAME, EmailJobPayload } from './email.job';

/**
 * Producer side — enqueues email jobs into BullMQ.
 *
 * The payload is the fully-rendered EmailMessage; templates must already
 * have been applied by the caller before calling enqueue(). Retry policy
 * (attempts: 3, exponential backoff) is configured as the queue's
 * `defaultJobOptions` in EmailModule, mirroring OcrModule's approach.
 */
@Injectable()
export class EmailProducer {
  private readonly logger = new Logger(EmailProducer.name);

  constructor(
    @InjectQueue(EMAIL_QUEUE_NAME) private readonly emailQueue: Queue,
  ) {}

  async enqueue(payload: EmailJobPayload): Promise<string> {
    const job = await this.emailQueue.add('send-email', payload);

    this.logger.log(`Email job enqueued — jobId: ${job.id}, to: ${payload.to}`);

    return job.id!;
  }
}
