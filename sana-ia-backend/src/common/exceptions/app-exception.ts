import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../enums/error-codes.enum';

export interface AppExceptionContext {
  errorCode: ErrorCode;
  message: string;
  statusCode: HttpStatus;
  publicMessage?: string; // User-facing message (if different from message)
  context?: Record<string, any>; // Additional context for logging
  cause?: Error; // Original error for stack trace
}

/**
 * Application-wide exception with privacy-aware error handling
 * Separates public (user-facing) from internal (logging) messages
 */
export class AppException extends HttpException {
  readonly errorCode: ErrorCode;
  readonly publicMessage: string;
  readonly context: Record<string, any>;
  readonly originalError?: Error;

  constructor(config: AppExceptionContext) {
    const { errorCode, message, statusCode, publicMessage, context, cause } =
      config;

    super(
      {
        statusCode,
        message: publicMessage || AppException.getDefaultPublicMessage(statusCode),
        errorCode,
      },
      statusCode,
    );

    this.errorCode = errorCode;
    this.publicMessage = publicMessage || message;
    this.context = context || {};
    this.originalError = cause;

    Object.setPrototypeOf(this, AppException.prototype);
  }

  /**
   * Default generic messages per HTTP status
   * Never reveal technical details
   */
  private static getDefaultPublicMessage(status: HttpStatus): string {
    const messages: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]:
        'The request could not be processed. Please check your input.',
      [HttpStatus.UNAUTHORIZED]:
        'Authentication failed. Please log in again.',
      [HttpStatus.FORBIDDEN]:
        'You do not have permission to access this resource.',
      [HttpStatus.NOT_FOUND]:
        'The requested resource was not found.',
      [HttpStatus.CONFLICT]:
        'A resource with this information already exists.',
      [HttpStatus.INTERNAL_SERVER_ERROR]:
        'An error occurred. Our team has been notified.',
      [HttpStatus.SERVICE_UNAVAILABLE]:
        'The service is temporarily unavailable. Please try again later.',
    };

    return messages[status] || 'An error occurred. Please try again.';
  }
}
