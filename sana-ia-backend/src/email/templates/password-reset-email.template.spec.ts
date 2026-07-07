import { passwordResetEmailTemplate } from './password-reset-email.template';

describe('passwordResetEmailTemplate', () => {
  it('builds a reset link under the backend base URL with the raw token', () => {
    const content = passwordResetEmailTemplate(
      'http://localhost:3000',
      'raw-token-456',
    );

    const expectedLink =
      'http://localhost:3000/v1/auth/reset?token=raw-token-456';
    expect(content.html).toContain(expectedLink);
    expect(content.text).toContain(expectedLink);
  });

  it('returns Spanish copy mentioning the 30-minute TTL', () => {
    const content = passwordResetEmailTemplate(
      'http://localhost:3000',
      'raw-token-456',
    );

    expect(content.subject).toMatch(/contraseña/);
    expect(content.text).toMatch(/30 minutos/);
    expect(content).not.toHaveProperty('to');
  });
});
