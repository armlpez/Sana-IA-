import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request = require('supertest');
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { GlobalExceptionFilter } from '../common/filters/exception.filter';

/**
 * Phase 8.1 — Anti-enumeration equality (adversarial).
 *
 * These are HTTP-level tests (real Nest app + supertest), NOT plain
 * controller-method unit tests, because the thing under test — the actual
 * HTTP status code — is assigned by Nest's routing pipeline based on
 * `@HttpCode` metadata, which a direct `controller.method()` call never
 * exercises (it always default-returns whatever the method returns, with no
 * status). Wiring a real (but DB/Redis-free) Nest app is the only way to
 * observe the true wire-level response.
 *
 * No ThrottlerGuard, DB, or Redis is involved — only AuthController wired
 * with mocked AuthService/UsersService, mirroring main.ts's versioning +
 * ValidationPipe + GlobalExceptionFilter setup so the response shape matches
 * production exactly.
 */
describe('AuthController — anti-enumeration (HTTP-level, adversarial)', () => {
  let app: INestApplication;
  let authService: {
    forgotPassword: jest.Mock;
    resendVerification: jest.Mock;
    resetPassword: jest.Mock;
    verifyEmail: jest.Mock;
  };

  beforeEach(async () => {
    authService = {
      forgotPassword: jest.fn().mockResolvedValue(undefined),
      resendVerification: jest.fn().mockResolvedValue(undefined),
      resetPassword: jest.fn().mockResolvedValue(undefined),
      verifyEmail: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: UsersService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /v1/auth/forgot-password', () => {
    it('returns byte-identical HTTP 200 status + body for an existing account vs a nonexistent email', async () => {
      const existing = await request(app.getHttpServer())
        .post('/v1/auth/forgot-password')
        .send({ email: 'exists@example.com' });

      const nonexistent = await request(app.getHttpServer())
        .post('/v1/auth/forgot-password')
        .send({ email: 'ghost@example.com' });

      // Real assertion of interest: the endpoint must answer 200 (per spec:
      // "SHALL ALWAYS return an identical generic 200"), NOT Nest's default
      // 201-for-POST.
      expect(existing.status).toBe(200);
      expect(nonexistent.status).toBe(200);

      expect(existing.status).toBe(nonexistent.status);
      expect(existing.body).toEqual(nonexistent.body);
      // Deep, byte-level equality on the FULL response object (status + body),
      // not just a loose `.toEqual` on the body alone.
      expect(JSON.stringify({ status: existing.status, body: existing.body })).toBe(
        JSON.stringify({ status: nonexistent.status, body: nonexistent.body }),
      );
    });

    it('never leaks which branch the service took via the AuthService call arguments observed from outside', async () => {
      await request(app.getHttpServer()).post('/v1/auth/forgot-password').send({ email: 'exists@example.com' });
      await request(app.getHttpServer()).post('/v1/auth/forgot-password').send({ email: 'ghost@example.com' });

      // The controller always calls the service with the raw email and
      // awaits it — it never branches on existence itself (that branching is
      // AuthService's job, proven in auth.service.spec.ts / adversarial
      // spec). This assertion pins the controller's ignorance permanently.
      expect(authService.forgotPassword).toHaveBeenNthCalledWith(1, 'exists@example.com');
      expect(authService.forgotPassword).toHaveBeenNthCalledWith(2, 'ghost@example.com');
    });
  });

  describe('POST /v1/auth/resend-verification', () => {
    it('returns byte-identical HTTP 200 status + body across an unverified-existing, an already-verified, and a nonexistent email', async () => {
      const unverified = await request(app.getHttpServer())
        .post('/v1/auth/resend-verification')
        .send({ email: 'unverified@example.com' });

      const alreadyVerified = await request(app.getHttpServer())
        .post('/v1/auth/resend-verification')
        .send({ email: 'verified@example.com' });

      const nonexistent = await request(app.getHttpServer())
        .post('/v1/auth/resend-verification')
        .send({ email: 'ghost@example.com' });

      expect(unverified.status).toBe(200);
      expect(alreadyVerified.status).toBe(200);
      expect(nonexistent.status).toBe(200);

      const serialize = (r: request.Response) => JSON.stringify({ status: r.status, body: r.body });
      expect(serialize(unverified)).toBe(serialize(alreadyVerified));
      expect(serialize(alreadyVerified)).toBe(serialize(nonexistent));
    });
  });

  describe('POST /v1/auth/reset-password and /verify-email — design-mandated 200 (consistency)', () => {
    it('reset-password answers 200, not the Nest POST default of 201', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/reset-password')
        .send({ token: 'raw-token', newPassword: 'NuevaPassword123' });

      expect(res.status).toBe(200);
    });

    it('verify-email answers 200, not the Nest POST default of 201', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/verify-email')
        .send({ token: 'raw-token' });

      expect(res.status).toBe(200);
    });
  });
});
