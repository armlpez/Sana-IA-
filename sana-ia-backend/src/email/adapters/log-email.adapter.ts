import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailPort } from '../email.port';

/**
 * Dev-default adapter — logs the rendered email instead of sending it.
 * No SMTP credentials required; used automatically when EMAIL_TYPE is
 * unset or explicitly set to `log`.
 */
@Injectable()
export class LogEmailAdapter implements EmailPort {
  private readonly logger = new Logger(LogEmailAdapter.name);

  send(message: EmailMessage): Promise<void> {
    this.logger.log(
      `Email (log adapter) — to: ${message.to}, subject: ${message.subject}\n${message.text}`,
    );
    return Promise.resolve();
  }
}
