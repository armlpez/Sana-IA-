import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../enums/error-codes.enum';
import { DataSanitizer } from './sanitizer';

export interface ErrorResponse {
  statusCode: number;
  message: string;
  errorCode: ErrorCode;
  timestamp: string;
  requestId: string;
  errors?: string[]; // For validation errors
}

export interface ErrorLog {
  requestId: string;
  timestamp: string;
  path: string;
  method: string;
  statusCode: number;
  userId?: string;
  errorCode: ErrorCode;
  message: string;
  input?: any;
  stack?: string;
  originalError?: any;
}

export class ErrorResponseBuilder {
  /**
   * Build public error response (safe for user)
   */
  static buildPublicResponse(
    statusCode: number,
    message: string,
    errorCode: ErrorCode,
    requestId: string,
    validationFields?: string[],
  ): ErrorResponse {
    const response: ErrorResponse = {
      statusCode,
      message,
      errorCode,
      timestamp: new Date().toISOString(),
      requestId,
    };

    // For validation errors, include field names (not values)
    if (validationFields && validationFields.length > 0) {
      response.errors = validationFields;
    }

    return response;
  }

  /**
   * Build detailed error log (for server-side logging only)
   */
  static buildErrorLog(
    requestId: string,
    path: string,
    method: string,
    statusCode: number,
    errorCode: ErrorCode,
    message: string,
    userId?: string,
    input?: any,
    originalError?: Error,
  ): ErrorLog {
    return {
      requestId,
      timestamp: new Date().toISOString(),
      path,
      method,
      statusCode,
      userId,
      errorCode,
      message,
      input: input ? DataSanitizer.sanitizeForLog(input) : undefined,
      stack: originalError?.stack,
      originalError: originalError
        ? {
            name: originalError.name,
            message: originalError.message,
            stack: originalError.stack,
          }
        : undefined,
    };
  }

  /**
   * Get public message for HTTP status code
   */
  static getPublicMessage(statusCode: number): string {
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

    return messages[statusCode] || 'An error occurred. Please try again.';
  }
}
