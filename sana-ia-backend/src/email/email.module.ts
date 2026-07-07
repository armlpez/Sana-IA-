import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EMAIL_PORT, EmailPort } from './email.port';
import { EMAIL_QUEUE_NAME } from './email.job';
import { LogEmailAdapter } from './adapters/log-email.adapter';
import { SmtpEmailAdapter } from './adapters/smtp-email.adapter';
import { EmailProducer } from './email.producer';
import { EmailWorker } from './email.worker';

/**
 * Wires EMAIL_PORT to a concrete adapter based on EMAIL_TYPE, and registers
 * the `email` BullMQ queue (producer + worker).
 *
 * EMAIL_TYPE=log (default) logs the rendered email — no SMTP needed, dev-safe.
 * EMAIL_TYPE=smtp sends real email via nodemailer using SMTP_* env vars.
 *
 * Leaf module — intentionally has zero dependencies on Auth/Users/Tokens.
 * Consumers inject `EMAIL_PORT` or `EmailProducer` directly.
 */
export function createEmailAdapter(configService: ConfigService): EmailPort {
  const emailType = configService.get<string>('EMAIL_TYPE') ?? 'log';
  switch (emailType) {
    case 'smtp':
      return new SmtpEmailAdapter(configService);
    case 'log':
      return new LogEmailAdapter();
    default:
      throw new Error(`Unknown EMAIL_TYPE: ${emailType}`);
  }
}

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({
      name: EMAIL_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000, // 2s -> 4s -> 8s
        },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 }, // Keep failed jobs 24h for debugging
      },
    }),
  ],
  providers: [
    {
      provide: EMAIL_PORT,
      useFactory: createEmailAdapter,
      inject: [ConfigService],
    },
    EmailProducer,
    EmailWorker,
  ],
  exports: [EMAIL_PORT, EmailProducer],
})
export class EmailModule {}
