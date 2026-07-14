import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import request = require('supertest');
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { ResilientLlmService } from './services/resilient-llm.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { Consultation } from '../consultations/entities/consultation.entity';
import { Diagnosis } from '../consultations/entities/diagnosis.entity';
import { ChatMessage } from '../chat-messages/entities/chat-message.entity';
import { OcrResult } from '../ocr/entities/ocr-result.entity';
import { STORAGE_PORT } from '../storage/storage.port';
import { GlobalExceptionFilter } from '../common/filters/exception.filter';

/**
 * DELETE /v1/ai/conversations — adversarial security spec (HTTP-level).
 *
 * Same rationale as auth.controller.anti-enum.spec.ts: guards, pipes and HTTP
 * status codes only exist in the real Nest pipeline, so these are supertest
 * tests against a wired app, not controller-method unit tests.
 *
 * What is REAL here: JwtStrategy (tokens are actually signed and verified),
 * ValidationPipe with production options, GlobalExceptionFilter, AiController,
 * and ChatService.deleteConversations itself.
 *
 * What is FAKE: the repositories and the transaction manager — but the fakes
 * HONOR the `where` criteria they receive (including TypeORM's In operator)
 * against an in-memory store. That is the point: if someone ever drops the
 * `userId` filter from the ownership lookup, the fake will happily return the
 * victim's rows and the IDOR assertions below will fail. A blind jest.fn()
 * mock could never catch that regression.
 */

const TEST_SECRET = 'delete-conversations-security-test-secret';

const USER_A = 100;
const USER_B = 200;

/** Applies a TypeORM-style where object ({ col: value | In([...]) }) to a row. */
function rowMatches(row: Record<string, any>, where: Record<string, any>): boolean {
    return Object.entries(where).every(([key, criterion]) =>
        criterion instanceof FindOperator
            ? (criterion.value as any[]).includes(row[key])
            : row[key] === criterion,
    );
}

describe('DELETE /v1/ai/conversations — security (adversarial, HTTP-level)', () => {
    let app: INestApplication;
    let jwt: JwtService;

    // In-memory tables, reseeded per test.
    let consultations: Array<{ id: number; userId: number }>;
    let chatMessages: Array<{ id: number; consultationId: number }>;
    let diagnoses: Array<{ id: number; consultationId: number }>;
    let ocrResults: Array<{ id: string; consultationId: number; imagePath: string }>;
    let storage: { remove: jest.Mock };

    const storeFor = (entity: any): any[] => {
        switch (entity) {
            case Consultation: return consultations;
            case ChatMessage: return chatMessages;
            case Diagnosis: return diagnoses;
            case OcrResult: return ocrResults;
            default: throw new Error(`Unexpected entity in tx delete: ${entity?.name}`);
        }
    };

    const tokenFor = (userId: number) =>
        jwt.sign({ sub: userId, email: `u${userId}@test.com`, role: 'user' });

    const del = (token?: string) => {
        const req = request(app.getHttpServer()).delete('/v1/ai/conversations');
        return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };

    beforeEach(async () => {
        // Seed: user A owns 1 and 2, user B owns 3 — each with children.
        consultations = [
            { id: 1, userId: USER_A },
            { id: 2, userId: USER_A },
            { id: 3, userId: USER_B },
        ];
        chatMessages = [
            { id: 10, consultationId: 1 },
            { id: 11, consultationId: 2 },
            { id: 12, consultationId: 3 },
        ];
        diagnoses = [
            { id: 20, consultationId: 1 },
            { id: 21, consultationId: 3 },
        ];
        ocrResults = [
            { id: 'ocr-1', consultationId: 1, imagePath: 'labs/a.jpg' },
            { id: 'ocr-3', consultationId: 3, imagePath: 'labs/b.jpg' },
        ];
        storage = { remove: jest.fn().mockResolvedValue(undefined) };

        jwt = new JwtService({ secret: TEST_SECRET, signOptions: { expiresIn: '5m' } });

        // Criteria-honoring fakes (see file header for why this matters).
        const consultationRepo = {
            find: jest.fn(async ({ where }: any) =>
                consultations.filter((row) => rowMatches(row, where)).map((r) => ({ id: r.id })),
            ),
        };
        const ocrResultRepo = {
            find: jest.fn(async ({ where }: any) =>
                ocrResults.filter((row) => rowMatches(row, where)),
            ),
        };
        const txManager = {
            delete: jest.fn(async (entity: any, criteria: any) => {
                const store = storeFor(entity);
                for (let i = store.length - 1; i >= 0; i--) {
                    if (rowMatches(store[i], criteria)) store.splice(i, 1);
                }
                return { affected: 1 };
            }),
        };
        const dataSource = { transaction: jest.fn(async (cb: any) => cb(txManager)) };

        const moduleRef: TestingModule = await Test.createTestingModule({
            imports: [PassportModule],
            controllers: [AiController],
            providers: [
                ChatService,
                JwtStrategy,
                { provide: ConfigService, useValue: { get: () => TEST_SECRET } },
                { provide: AiService, useValue: {} },
                { provide: ResilientLlmService, useValue: {} },
                { provide: getRepositoryToken(Consultation), useValue: consultationRepo },
                { provide: getRepositoryToken(ChatMessage), useValue: {} },
                { provide: getRepositoryToken(Diagnosis), useValue: {} },
                { provide: getRepositoryToken(OcrResult), useValue: ocrResultRepo },
                { provide: getDataSourceToken(), useValue: dataSource },
                { provide: STORAGE_PORT, useValue: storage },
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

    // ------------------------------------------------------------------
    // Authentication — the endpoint must be unreachable without a valid JWT
    // ------------------------------------------------------------------
    describe('authentication', () => {
        it('rejects requests without a token (401) and deletes nothing', async () => {
            const res = await del().send({ ids: [1] });

            expect(res.status).toBe(401);
            expect(consultations).toHaveLength(3);
        });

        it('rejects a token signed with the wrong secret (401)', async () => {
            const forged = new JwtService({ secret: 'attacker-secret' }).sign({
                sub: USER_A, email: 'u100@test.com', role: 'user',
            });

            const res = await del(forged).send({ ids: [1] });

            expect(res.status).toBe(401);
            expect(consultations).toHaveLength(3);
        });

        it('rejects an expired token (401)', async () => {
            const expired = new JwtService({ secret: TEST_SECRET }).sign(
                { sub: USER_A, email: 'u100@test.com', role: 'user' },
                { expiresIn: '-10s' },
            );

            const res = await del(expired).send({ ids: [1] });

            expect(res.status).toBe(401);
            expect(consultations).toHaveLength(3);
        });
    });

    // ------------------------------------------------------------------
    // Ownership / IDOR — a user can only ever delete their own conversations
    // ------------------------------------------------------------------
    describe('ownership (IDOR)', () => {
        it('deletes own conversations and their children, scoped exactly', async () => {
            const res = await del(tokenFor(USER_A)).send({ ids: [1] });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ deletedIds: [1], notFoundIds: [] });

            // Consultation 1 and ONLY its children are gone.
            expect(consultations.map((c) => c.id).sort()).toEqual([2, 3]);
            expect(chatMessages.map((m) => m.consultationId).sort()).toEqual([2, 3]);
            expect(diagnoses.map((d) => d.consultationId)).toEqual([3]);
            expect(ocrResults.map((o) => o.consultationId)).toEqual([3]);
            // Storage cleanup only for the deleted consultation's lab image.
            expect(storage.remove).toHaveBeenCalledTimes(1);
            expect(storage.remove).toHaveBeenCalledWith('labs/a.jpg');
        });

        it("cannot delete another user's conversation: reported as notFound, victim untouched", async () => {
            const res = await del(tokenFor(USER_A)).send({ ids: [3] });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ deletedIds: [], notFoundIds: [3] });

            // Victim's conversation AND all its children survive intact.
            expect(consultations).toContainEqual({ id: 3, userId: USER_B });
            expect(chatMessages).toContainEqual({ id: 12, consultationId: 3 });
            expect(diagnoses).toContainEqual({ id: 21, consultationId: 3 });
            expect(ocrResults.find((o) => o.id === 'ocr-3')).toBeDefined();
            expect(storage.remove).not.toHaveBeenCalled();
        });

        it('mixed batch: deletes only the owned ids, never the foreign ones', async () => {
            const res = await del(tokenFor(USER_A)).send({ ids: [1, 3, 999] });

            expect(res.status).toBe(200);
            expect(res.body.deletedIds).toEqual([1]);
            expect(res.body.notFoundIds.sort()).toEqual([3, 999]);
            expect(consultations).toContainEqual({ id: 3, userId: USER_B });
        });

        it("anti-enumeration: a foreign id and a nonexistent id produce structurally identical responses", async () => {
            const foreign = await del(tokenFor(USER_A)).send({ ids: [3] });
            const nonexistent = await del(tokenFor(USER_A)).send({ ids: [999] });

            expect(foreign.status).toBe(200);
            expect(nonexistent.status).toBe(200);
            // Same shape, same buckets — the only difference is the echoed id,
            // so the response can't be used to probe which ids exist.
            const normalize = (body: any, id: number) =>
                JSON.stringify(body).split(String(id)).join('X');
            expect(normalize(foreign.body, 3)).toBe(normalize(nonexistent.body, 999));
        });

        it('user B still sees their conversation after an attack burst from A', async () => {
            for (const ids of [[3], [3, 3], [1, 2, 3]]) {
                await del(tokenFor(USER_A)).send({ ids });
            }

            expect(consultations).toContainEqual({ id: 3, userId: USER_B });
            expect(chatMessages).toContainEqual({ id: 12, consultationId: 3 });
        });
    });

    // ------------------------------------------------------------------
    // Input hardening — malformed/hostile payloads must die in validation
    // (400), before any service code or query runs
    // ------------------------------------------------------------------
    describe('input validation', () => {
        const expect400Untouched = async (body: any) => {
            const res = await del(tokenFor(USER_A)).send(body);
            expect(res.status).toBe(400);
            expect(consultations).toHaveLength(3);
            return res;
        };

        it('rejects a missing/empty body', async () => {
            await expect400Untouched({});
        });

        it('rejects an empty ids array', async () => {
            await expect400Untouched({ ids: [] });
        });

        it('rejects non-array ids (string smuggling)', async () => {
            await expect400Untouched({ ids: '1,2,3' });
        });

        it('rejects more than 50 ids even when they are all owned/valid', async () => {
            const ids = Array.from({ length: 51 }, (_, i) => i + 1);
            await expect400Untouched({ ids });
        });

        it('rejects SQL-injection strings inside the array', async () => {
            await expect400Untouched({ ids: ['1; DROP TABLE consultation;--'] });
        });

        it('rejects non-integer numbers', async () => {
            await expect400Untouched({ ids: [1.5] });
        });

        it('rejects null entries', async () => {
            await expect400Untouched({ ids: [1, null] });
        });

        it('rejects zero and negative ids (never valid serial ids)', async () => {
            await expect400Untouched({ ids: [0] });
            await expect400Untouched({ ids: [-5] });
        });

        it('rejects ids beyond the Postgres int4 range (would otherwise 500 inside the DB)', async () => {
            await expect400Untouched({ ids: [2_147_483_648] });
            await expect400Untouched({ ids: [99_999_999_999] });
        });

        it('rejects unknown extra properties (forbidNonWhitelisted)', async () => {
            await expect400Untouched({ ids: [1], all: true });
        });

        it('nested objects in the array cannot smuggle query operators', async () => {
            // NoSQL-style operator smuggling — must die in validation, never
            // reach the In() criteria.
            await expect400Untouched({ ids: [{ $gt: 0 }] });
        });

        it('string-typed ids never bypass ownership scoping, whatever the pipe decides', async () => {
            // Depending on class-transformer's implicit-conversion behavior for
            // arrays this is either a 400 or a coerced number — both are safe.
            // The invariant that must hold: user B's conversation survives.
            const res = await del(tokenFor(USER_A)).send({ ids: ['3'] });

            expect(res.status).toBeLessThan(500);
            expect(consultations).toContainEqual({ id: 3, userId: USER_B });
        });
    });
});
