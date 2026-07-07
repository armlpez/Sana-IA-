import { verifyEmailPage } from './verify-email.page';
import { resetPasswordPage } from './reset-password.page';

describe('auth pages (self-contained HTML helpers)', () => {
  describe('verifyEmailPage', () => {
    it('embeds the raw token and posts to the relative /v1/auth/verify-email endpoint', () => {
      const html = verifyEmailPage('abc123deadbeef');

      expect(html).toContain('abc123deadbeef');
      expect(html).toContain("fetch('/v1/auth/verify-email'");
      expect(html).toContain('Tu cuenta ha sido verificada. Ya puedes iniciar sesión en la app.');
    });

    it('is a Spanish document with only the brand Google Fonts stylesheet as an external asset (no scripts)', () => {
      const html = verifyEmailPage('other-token-value');

      expect(html).toMatch(/<html lang="es">/);
      expect(html).toContain('https://fonts.googleapis.com/css2?family=Inter');
      expect(html).not.toMatch(/<script[^>]+src=/);
    });

    it('renders the QuvixSoft brand logo with a graceful alt-text fallback', () => {
      const html = verifyEmailPage('other-token-value');

      expect(html).toContain('https://quvixsoft.com/assets/LOGO_PNG-SIN%20FONDO.png');
      expect(html).toContain('alt="QuvixSoft"');
    });

    it('defensively escapes a token containing script-breakout characters', () => {
      const dangerousToken = '</script><script>alert(1)</script>';
      const html = verifyEmailPage(dangerousToken);

      expect(html).not.toContain('</script><script>alert(1)</script>');
      expect(html).toContain('\\u003c/script\\u003e');
    });
  });

  describe('resetPasswordPage', () => {
    it('embeds the raw token and posts to the relative /v1/auth/reset-password endpoint', () => {
      const html = resetPasswordPage('reset-token-xyz');

      expect(html).toContain('reset-token-xyz');
      expect(html).toContain("fetch('/v1/auth/reset-password'");
      expect(html).toContain('Contraseña actualizada. Inicia sesión en la app con tu nueva contraseña.');
    });

    it('renders a password form with an 8-char minimum and a confirm-match check', () => {
      const html = resetPasswordPage('reset-token-xyz');

      expect(html).toMatch(/minlength=["']8["']/);
      expect(html).toContain('type="password"');
      expect(html).toMatch(/confirm/i);
    });

    it('uses the QuvixSoft brand tokens (gradient CTA, brand logo, Inter font)', () => {
      const html = resetPasswordPage('reset-token-xyz');

      expect(html).toContain('https://fonts.googleapis.com/css2?family=Inter');
      expect(html).toContain('https://quvixsoft.com/assets/LOGO_PNG-SIN%20FONDO.png');
      expect(html).toContain('#00D4FF');
      expect(html).toContain('#0056B3');
    });

    it('defensively escapes a token containing script-breakout characters', () => {
      const dangerousToken = '</script><script>alert(1)</script>';
      const html = resetPasswordPage(dangerousToken);

      expect(html).not.toContain('</script><script>alert(1)</script>');
      expect(html).toContain('\\u003c/script\\u003e');
    });
  });
});
