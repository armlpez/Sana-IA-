import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EMAIL_QUEUE_NAME, EmailJobPayload } from './email.job';
import { EMAIL_PORT } from './email.port';
import type { EmailPort } from './email.port';

/**
 * Worker (consumer) that processes email jobs from the BullMQ queue.
 *
 * Delegates the actual send to whatever EMAIL_PORT adapter is wired
 * (log or smtp) — the worker itself has no knowledge of the transport.
 * On failure it rethrows so BullMQ applies the queue's retry policy
 * (attempts: 3, exponential backoff — see EmailModule); a failure log is
 * only emitted once the final attempt has been exhausted.
 */
@Processor(EMAIL_QUEUE_NAME, {
  concurrency: 5,
})
export class EmailWorker extends WorkerHost {
  private readonly logger = new Logger(EmailWorker.name);

  constructor(@Inject(EMAIL_PORT) private readonly emailPort: EmailPort) {
    super();
  }

  async process(job: Job<EmailJobPayload>): Promise<void> {
    const { to, subject } = job.data;

    try {
      await this.emailPort.send(job.data);
      this.logger.log(`Email sent — to: ${to}, subject: ${subject}`);
    } catch (err: unknown) {
      const attemptsMade = job.attemptsMade ?? 0;
      const maxAttempts = job.opts?.attempts ?? 1;
      const message = err instanceof Error ? err.message : String(err);

      if (attemptsMade >= maxAttempts) {
        this.logger.error(
          `Email job failed permanently — to: ${to}, subject: ${subject}, attempts: ${attemptsMade}, error: ${message}`,
        );
      } else {
        this.logger.warn(
          `Email job attempt failed — to: ${to}, subject: ${subject}, attempt: ${attemptsMade}, error: ${message}`,
        );
      }

      throw err;
    }
  }
}
