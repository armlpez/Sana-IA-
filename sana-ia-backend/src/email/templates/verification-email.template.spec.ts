import { verificationEmailTemplate } from './verification-email.template';

describe('verificationEmailTemplate', () => {
  it('builds a verify link under the backend base URL with the raw token', () => {
    const content = verificationEmailTemplate(
      'http://localhost:3000',
      'raw-token-123',
    );

    const expectedLink =
      'http://localhost:3000/v1/auth/verify?token=raw-token-123';
    expect(content.html).toContain(expectedLink);
    expect(content.text).toContain(expectedLink);
  });

  it('returns Spanish copy with no recipient field', () => {
    const content = verificationEmailTemplate(
      'http://localhost:3000',
      'raw-token-123',
    );

    expect(content.subject).toMatch(/Verifica/);
    expect(content.text).toMatch(/24 horas/);
    expect(content).not.toHaveProperty('to');
  });
});
