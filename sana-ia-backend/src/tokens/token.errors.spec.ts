import {
  invalidTokenException,
  expiredTokenException,
  consumedTokenException,
} from './token.errors';
import { TokenType } from './enums/token-type.enum';

/**
 * Verifies the EXACT (verbatim) Spanish publicMessage strings from the
 * proposal's ErrorCode table (ERR_AUTH_008..011). Complements
 * token.service.spec.ts's substring assertions with byte-exact checks so a
 * future edit cannot silently drift from the approved copy.
 */
describe('token.errors publicMessage (verbatim strings, ERR_AUTH_008..011)', () => {
  it('AUTH_RESET_TOKEN_INVALID (008): invalid password-reset token', () => {
    expect(invalidTokenException(TokenType.PASSWORD_RESET).publicMessage).toBe(
      'El enlace de restablecimiento no es válido o ya fue utilizado.',
    );
  });

  it('AUTH_RESET_TOKEN_EXPIRED (009): expired password-reset token', () => {
    expect(expiredTokenException(TokenType.PASSWORD_RESET).publicMessage).toBe(
      'El enlace de restablecimiento ha expirado. Solicita uno nuevo.',
    );
  });

  it('AUTH_VERIFICATION_TOKEN_INVALID (010): invalid email-verification token', () => {
    expect(invalidTokenException(TokenType.EMAIL_VERIFICATION).publicMessage).toBe(
      'El enlace de verificación no es válido o ya fue utilizado.',
    );
  });

  it('AUTH_VERIFICATION_TOKEN_EXPIRED (011): expired email-verification token', () => {
    expect(expiredTokenException(TokenType.EMAIL_VERIFICATION).publicMessage).toBe(
      'El enlace de verificación ha expirado. Solicita uno nuevo.',
    );
  });

  it('a consumed (already-used) token reuses the INVALID message for its type', () => {
    expect(consumedTokenException(TokenType.PASSWORD_RESET).publicMessage).toBe(
      'El enlace de restablecimiento no es válido o ya fue utilizado.',
    );
    expect(consumedTokenException(TokenType.EMAIL_VERIFICATION).publicMessage).toBe(
      'El enlace de verificación no es válido o ya fue utilizado.',
    );
  });
});
