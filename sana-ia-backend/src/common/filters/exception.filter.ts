import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AppException } from '../exceptions/app-exception';
import { ErrorResponseBuilder } from '../utils/error-response.builder';
import { DataSanitizer } from '../utils/sanitizer';
import { ErrorCode } from '../enums/error-codes.enum';

/**
 * Global Exception Filter
 * Catches all exceptions and returns privacy-aware responses
 * - User: Generic message + errorCode + requestId
 * - Logs: Full details (sanitized PII) for debugging
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const requestId = this.getOrCreateRequestId(request);
    const { path, method } = request;

    let statusCode: number;
    let errorCode: ErrorCode;
    let message: string;
    let publicMessage: string;
    let validationErrors: string[] = [];
    let input: any = null;

    // Handle AppException (our custom exception)
    if (exception instanceof AppException) {
      statusCode = exception.getStatus();
      errorCode = exception.errorCode;
      message = exception.message;
      publicMessage = exception.publicMessage;
      input = exception.context;
    }
    // Handle validation errors (from ValidationPipe)
    else if (exception instanceof BadRequestException) {
      statusCode = HttpStatus.BAD_REQUEST;
      errorCode = ErrorCode.VALIDATION_ERROR;
      const exceptionResponse = exception.getResponse() as any;
      message =
        exceptionResponse.message ||
        'Validation failed';
      publicMessage = message;

      // Extract field names from validation errors
      if (Array.isArray(exceptionResponse.message)) {
        validationErrors = DataSanitizer.extractValidationFields(
          exceptionResponse.message,
        );
      }

      input = this.extractRequestBody(request);
    }
    // Handle standard NestJS HttpExceptions
    else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      errorCode = this.mapHttpStatusToErrorCode(statusCode);
      message = exception.message;
      publicMessage = ErrorResponseBuilder.getPublicMessage(statusCode);
      input = this.extractRequestBody(request);
    }
    // Handle unknown errors
    else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      errorCode = ErrorCode.INTERNAL_ERROR;
      message =
        exception instanceof Error
          ? exception.message
          : 'Unknown error occurred';
      publicMessage = ErrorResponseBuilder.getPublicMessage(statusCode);
      input = this.extractRequestBody(request);
    }

    // Build responses
    const publicResponse = ErrorResponseBuilder.buildPublicResponse(
      statusCode,
      publicMessage,
      errorCode,
      requestId,
      validationErrors,
    );

    const errorLog = ErrorResponseBuilder.buildErrorLog(
      requestId,
      path,
      method,
      statusCode,
      errorCode,
      message,
      this.extractUserId(request),
      input,
      exception instanceof Error ? exception : undefined,
    );

    // Log error with full context (server-side only)
    this.logError(statusCode, errorLog);

    // Send public response to client
    response.status(statusCode).json(publicResponse);
  }

  /**
   * Get or create request ID for tracing
   */
  private getOrCreateRequestId(request: Request): string {
    const existingId = request.headers['x-request-id'];
    if (typeof existingId === 'string') {
      return existingId;
    }
    const newId = uuidv4();
    request.headers['x-request-id'] = newId;
    return newId;
  }

  /**
   * Extract request body (only for logging)
   */
  private extractRequestBody(request: Request): any {
    if (
      request.method === 'GET' ||
      request.method === 'DELETE' ||
      !request.body
    ) {
      return undefined;
    }
    return request.body;
  }

  /**
   * Extract user ID from request (from JWT payload)
   */
  private extractUserId(request: Request): string | undefined {
    const user = (request as any).user;
    return user?.id || user?.sub;
  }

  /**
   * Map HTTP status to error code
   */
  private mapHttpStatusToErrorCode(status: number): ErrorCode {
    const mapping: Record<number, ErrorCode> = {
      [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
      [HttpStatus.UNAUTHORIZED]: ErrorCode.AUTH_UNAUTHORIZED,
      [HttpStatus.FORBIDDEN]: ErrorCode.AUTH_FORBIDDEN,
      [HttpStatus.NOT_FOUND]: ErrorCode.USER_NOT_FOUND,
      [HttpStatus.CONFLICT]: ErrorCode.USER_CONFLICT,
      [HttpStatus.INTERNAL_SERVER_ERROR]: ErrorCode.INTERNAL_ERROR,
      [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
    };

    return mapping[status] || ErrorCode.INTERNAL_ERROR;
  }

  /**
   * Log error based on severity
   */
  private logError(statusCode: number, errorLog: any) {
    // Log format: [REQUEST_ID] [METHOD PATH] [ERROR_CODE] MESSAGE
    const logPrefix = `[${errorLog.requestId}] [${errorLog.method} ${errorLog.path}] [${errorLog.errorCode}]`;

    if (statusCode >= 500) {
      // Server errors: log as error with full context
      this.logger.error(
        `${logPrefix} ${errorLog.message}`,
        errorLog.stack,
      );
    } else if (statusCode >= 400) {
      // Client errors: log as warning (expected errors)
      this.logger.warn(
        `${logPrefix} ${errorLog.message}`,
      );
    }
  }
}
