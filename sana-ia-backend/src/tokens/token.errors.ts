import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/app-exception';
import { ErrorCode } from '../common/enums/error-codes.enum';
import { TokenType } from './enums/token-type.enum';

/**
 * Token-specific exception factory.
 *
 * Error codes are selected by `type` per the proposal's ErrorCode table:
 * PASSWORD_RESET -> ERR_AUTH_008 (invalid) / ERR_AUTH_009 (expired);
 * EMAIL_VERIFICATION -> ERR_AUTH_010 (invalid) / ERR_AUTH_011 (expired).
 * A consumed (already-used) token reuses the "invalid" code for its type —
 * the proposal has no distinct "consumed" code, only invalid/expired.
 */
const INVALID_CODE_BY_TYPE: Record<TokenType, ErrorCode> = {
  [TokenType.PASSWORD_RESET]: ErrorCode.AUTH_RESET_TOKEN_INVALID,
  [TokenType.EMAIL_VERIFICATION]: ErrorCode.AUTH_VERIFICATION_TOKEN_INVALID,
};

const EXPIRED_CODE_BY_TYPE: Record<TokenType, ErrorCode> = {
  [TokenType.PASSWORD_RESET]: ErrorCode.AUTH_RESET_TOKEN_EXPIRED,
  [TokenType.EMAIL_VERIFICATION]: ErrorCode.AUTH_VERIFICATION_TOKEN_EXPIRED,
};

export function invalidTokenException(type: TokenType): AppException {
  return new AppException({
    errorCode: INVALID_CODE_BY_TYPE[type],
    message: 'Token lookup failed: hash not found or type mismatch',
    statusCode: HttpStatus.BAD_REQUEST,
    publicMessage: 'El enlace no es válido. Por favor solicita uno nuevo.',
  });
}

export function expiredTokenException(type: TokenType): AppException {
  return new AppException({
    errorCode: EXPIRED_CODE_BY_TYPE[type],
    message: 'Token lookup failed: token expired',
    statusCode: HttpStatus.BAD_REQUEST,
    publicMessage: 'El enlace ha expirado. Por favor solicita uno nuevo.',
  });
}

export function consumedTokenException(type: TokenType): AppException {
  return new AppException({
    errorCode: INVALID_CODE_BY_TYPE[type],
    message: 'Token lookup failed: token already consumed',
    statusCode: HttpStatus.BAD_REQUEST,
    publicMessage: 'Este enlace ya fue utilizado. Por favor solicita uno nuevo.',
  });
}
