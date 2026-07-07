import { EmailMessage } from '../email.port';

/** Rendered email content, without the recipient (`to` is added by the caller). */
export type EmailContent = Omit<EmailMessage, 'to'>;

/**
 * Builds the account-verification email.
 *
 * The link points at an HTML page served by THIS backend (the frontend is
 * a mobile app with no web routes of its own) — see `FRONTEND_URL` in
 * `.env.example`.
 */
export function verificationEmailTemplate(
  frontendUrl: string,
  rawToken: string,
): EmailContent {
  const link = `${frontendUrl}/v1/auth/verify?token=${rawToken}`;

  return {
    subject: 'Verificá tu cuenta en Sana IA',
    html: `
      <p>Hola,</p>
      <p>Gracias por registrarte en Sana IA. Para verificar tu cuenta, hacé clic en el siguiente enlace:</p>
      <p><a href="${link}">${link}</a></p>
      <p>Este enlace expira en 24 horas. Si no creaste esta cuenta, podés ignorar este correo.</p>
    `.trim(),
    text: [
      'Hola,',
      '',
      'Gracias por registrarte en Sana IA. Para verificar tu cuenta, visitá el siguiente enlace:',
      link,
      '',
      'Este enlace expira en 24 horas. Si no creaste esta cuenta, podés ignorar este correo.',
    ].join('\n'),
  };
}
