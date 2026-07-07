/**
 * EmailPort — contract every email backend must fulfill.
 *
 * Consumers depend only on this interface, never on a concrete adapter.
 * Adding a new backend (SendGrid, SES, etc.) means writing one adapter and
 * registering it in EmailModule — no changes to callers.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailPort {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_PORT = Symbol('EMAIL_PORT');
