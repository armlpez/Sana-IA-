import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Serves /assets/* (e.g. the QuvixSoft logo used by the verify-email and
  // reset-password pages) locally instead of hotlinking quvixsoft.com — that
  // external dependency broke the logo for at least one user when the
  // third-party site had a transient failure.
  app.useStaticAssets(join(__dirname, '..', 'public'));

  app.enableVersioning({
    type: VersioningType.URI,
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Remove unknown properties
      forbidNonWhitelisted: true, // Reject unknown properties
      transform: true, // Auto-transform payloads to DTO classes
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global filters (must be before interceptors)
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new LoggingInterceptor());

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');

  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();