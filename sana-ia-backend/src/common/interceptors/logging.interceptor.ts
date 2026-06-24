import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';

/**
 * Logging Interceptor
 * Adds request ID to all requests for tracing across logs
 * Logs request/response with timing information
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: any): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // Get or create request ID (header may be string | string[] | undefined)
    const existingId = request.headers['x-request-id'];
    const requestId =
      (Array.isArray(existingId) ? existingId[0] : existingId) || uuidv4();
    request.headers['x-request-id'] = requestId;

    // Attach to response headers for client to track
    response.setHeader('x-request-id', requestId);

    const { method, url, ip } = request;
    const startTime = Date.now();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;
        const statusCode = response.statusCode;

        // Log successful requests
        this.logger.log(
          `[${requestId}] ${method} ${url} - ${statusCode} (${duration}ms)`,
        );
      }),
    );
  }
}
