import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { EmailMessage, EmailPort } from '../email.port';

/** Real-delivery adapter — sends email via nodemailer using SMTP_* env vars. */
@Injectable()
export class SmtpEmailAdapter implements EmailPort {
  private readonly logger = new Logger(SmtpEmailAdapter.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromAddress: string | undefined;

  constructor(configService: ConfigService) {
    const user = configService.get<string>('SMTP_USER');
    this.fromAddress = user;
    this.transporter = nodemailer.createTransport({
      host: configService.get<string>('SMTP_HOST'),
      port: configService.get<number>('SMTP_PORT'),
      auth: {
        user,
        pass: configService.get<string>('SMTP_PASS'),
      },
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    this.logger.log(
      `Email sent via SMTP — to: ${message.to}, subject: ${message.subject}`,
    );
  }
}
