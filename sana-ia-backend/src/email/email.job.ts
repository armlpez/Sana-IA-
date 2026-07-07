import { EmailMessage } from './email.port';

/**
 * Typed payload for email jobs in BullMQ.
 *
 * It is the fully-rendered EmailMessage — templates are rendered by the
 * caller (producer's caller) BEFORE enqueueing, so the worker only has to
 * hand the payload to EMAIL_PORT.send() with no template logic of its own.
 */
export type EmailJobPayload = EmailMessage;

/** BullMQ queue name constant */
export const EMAIL_QUEUE_NAME = 'email';
