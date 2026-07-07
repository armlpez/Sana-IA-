import { EmailContent } from './verification-email.template';

/**
 * Builds the password-reset email.
 *
 * The link points at an HTML page served by THIS backend (the frontend is
 * a mobile app with no web routes of its own) — see `FRONTEND_URL` in
 * `.env.example`.
 */
export function passwordResetEmailTemplate(
  frontendUrl: string,
  rawToken: string,
): EmailContent {
  const link = `${frontendUrl}/v1/auth/reset?token=${rawToken}`;

  return {
    subject: 'Restablecé tu contraseña en Sana IA',
    html: `
      <p>Hola,</p>
      <p>Recibimos una solicitud para restablecer tu contraseña. Hacé clic en el siguiente enlace para continuar:</p>
      <p><a href="${link}">${link}</a></p>
      <p>Este enlace expira en 30 minutos. Si no solicitaste este cambio, podés ignorar este correo.</p>
    `.trim(),
    text: [
      'Hola,',
      '',
      'Recibimos una solicitud para restablecer tu contraseña. Visitá el siguiente enlace para continuar:',
      link,
      '',
      'Este enlace expira en 30 minutos. Si no solicitaste este cambio, podés ignorar este correo.',
    ].join('\n'),
  };
}
