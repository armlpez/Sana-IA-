import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/app-exception';
import { ErrorCode } from '../common/enums/error-codes.enum';

/**
 * Token-specific exception factory.
 *
 * TODO(PR2): swap `ErrorCode.VALIDATION_ERROR` below for the dedicated
 * ERR_AUTH_007..011 codes once `error-codes.enum.ts` gains them (PR2 scope —
 * that file stays out of this leaf-only PR). Spec assertions for TokenService
 * target `publicMessage` + HTTP status (400), NOT the enum value, so this
 * swap is a one-line change per function with zero test churn.
 */
export function invalidTokenException(): AppException {
  return new AppException({
    errorCode: ErrorCode.VALIDATION_ERROR, // TODO(PR2): ErrorCode.AUTH_TOKEN_INVALID
    message: 'Token lookup failed: hash not found or type mismatch',
    statusCode: HttpStatus.BAD_REQUEST,
    publicMessage: 'El enlace no es válido. Por favor solicita uno nuevo.',
  });
}

export function expiredTokenException(): AppException {
  return new AppException({
    errorCode: ErrorCode.VALIDATION_ERROR, // TODO(PR2): ErrorCode.AUTH_TOKEN_EXPIRED
    message: 'Token lookup failed: token expired',
    statusCode: HttpStatus.BAD_REQUEST,
    publicMessage: 'El enlace ha expirado. Por favor solicita uno nuevo.',
  });
}

export function consumedTokenException(): AppException {
  return new AppException({
    errorCode: ErrorCode.VALIDATION_ERROR, // TODO(PR2): ErrorCode.AUTH_TOKEN_CONSUMED
    message: 'Token lookup failed: token already consumed',
    statusCode: HttpStatus.BAD_REQUEST,
    publicMessage: 'Este enlace ya fue utilizado. Por favor solicita uno nuevo.',
  });
}
