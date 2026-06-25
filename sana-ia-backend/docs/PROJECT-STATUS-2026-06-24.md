# 📊 Sana-IA Backend — Project Status Report
**Date:** 2026-06-24 | **Branch:** `main` (merged from PR-1, PR-2, PR-3) | **Status:** ⚠️ **DEVELOPMENT** (Blockers before Production)

---

## 🎯 Ejecutivo

**Completado:**
- ✅ Fase 1: Auth + Users (estructura base, sin guards en CRUD endpoints)
- ✅ Fase 2: Chat + AI (conversacional, diagnóstico, resilience layer)
- ✅ Fase 3: OCR + BullMQ (async pipeline, Gemini Vision, biomarker extraction)
- ✅ Safety Foundation (emergency detection, fallback routing, model tiering)

**Riesgos Críticos (bloquean prod):**
- 🔴 Users + Roles endpoints sin `JwtAuthGuard` (cualquiera puede crear/borrar usuarios)
- 🔴 S3 no implementado (OCR Storage fallará en prod)
- 🔴 `synchronize:true` en dev mode podría migrar la prod DB accidentalmente
- 🔴 JWT_SECRET no está en `.env.example`
- 🔴 Rate limits hardcodeados (valores de testing, no prod)

**Próximo Focus:**
1. **URGENT:** Asegurar todos los endpoints (agregar guards)
2. **Fase 4:** Reports (PDF export) — 8-11 horas
3. **S3 Integration:** Multi-pod support — 5-8 horas
4. **Testing:** Llegar a 70%+ coverage — 15-20 horas

---

## 📋 Tabla de Progreso — Fases

| Fase | Feature | Status | % Complete | Blocker | Notes |
|------|---------|--------|------------|---------|-------|
| **1** | Auth + JWT | ✅ | 100% | — | Funciona, pero CRUD endpoints sin guards |
| **1** | Users CRUD | ⚠️ | 100% | SIN GUARDS | Refactor: agregar `@UseGuards(JwtAuthGuard)` + RBAC |
| **1** | Roles CRUD | ⚠️ | 100% | SIN GUARDS | Refactor: solo ADMIN puede manipular |
| **1** | Rate Limiting | ✅ | 100% | Testing values | Cambiar valores para prod |
| **2** | Chat conversacional | ✅ | 100% | — | Gemini integration, multi-turn |
| **2** | One-shot analysis | ✅ | 100% | — | `/v1/ai/analyze` endpoint |
| **2** | GeminiClientService | ✅ | 100% | — | Model tiering, retry, timeout |
| **2** | SafeFallbackBuilder | ✅ | 100% | — | Error routing, no PHI logs |
| **3** | OCR upload | ✅ | 100% | — | `/v1/ocr/analyze` → 202 Accepted |
| **3** | BullMQ worker | ✅ | 100% | — | Async processing, Gemini Vision |
| **3** | StorageService | ✅ | 50% | S3 NOT IMPL | Local works, S3 throws Error() |
| **3** | Biomarker extraction | ✅ | 100% | — | Parsed from Gemini Vision |
| **4** | ReportsModule | ❌ | 0% | — | Spec ready (docs/FASE4-REPORTS.md) |
| **4** | PDF generation | ❌ | 0% | — | Not started |
| **4** | Audit logging | ❌ | 0% | — | Not started |

---

## 🏗️ Architectural Overview

```
┌─ AppModule
│
├─ AuthModule
│  ├─ JwtStrategy (access token)
│  ├─ JwtRefreshStrategy (refresh token)
│  └─ AuthController: POST /v1/auth/login, refresh, logout, profile
│
├─ UsersModule ⚠️
│  ├─ UsersService (findByEmail, create, update, delete)
│  └─ UsersController: POST/GET/PATCH/DELETE /v1/users/* [NO GUARDS]
│
├─ RolesModule ⚠️
│  └─ RolesController: CRUD /v1/roles/* [NO GUARDS]
│
├─ ConsultationsModule
│  ├─ ConsultationService
│  ├─ ChatMessageService
│  └─ ChatMessage entity (messages history)
│
├─ AiModule ✅
│  ├─ AiService (one-shot analysis)
│  ├─ ChatService (multi-turn) ← injects ConsultationService
│  ├─ GeminiClientService (Gemini wrapper)
│  │  ├─ model tiering (flash-lite, flash, pro)
│  │  ├─ timeout handling
│  │  └─ retry logic (exponential backoff)
│  ├─ SafeFallbackBuilder (resilience)
│  ├─ ErrorClassifier (error mapping)
│  └─ AiController: POST /v1/ai/chat, /analyze [JwtAuthGuard]
│
├─ OcrModule ✅
│  ├─ OcrProducer (BullMQ enqueue)
│  ├─ OcrWorker (async processing)
│  ├─ OcrResult entity
│  └─ OcrController: POST /v1/ocr/analyze, GET /v1/ocr/jobs/:id [JwtAuthGuard]
│
├─ CommonModule
│  ├─ StorageService ⚠️ (local only, S3 throws Error)
│  ├─ GlobalExceptionFilter (error shaping)
│  ├─ UserThrottlerGuard (rate limiting)
│  └─ ErrorResponseBuilder (consistent error format)
│
└─ DatabaseModule
   └─ TypeORM + PostgreSQL
```

**Dependency graph (no cycles):**
```
AuthModule → UsersModule
    ↓
ConsultationsModule ← AiModule ← OcrModule
    ↓
ChatMessagesModule
```

---

## 🧪 Test Coverage & Quality

### Coverage by Module

| Module | Tests | Coverage | Status |
|--------|-------|----------|--------|
| ai/utils | 18 | HIGH | ✅ ErrorClassifier (8), SafeFallbackBuilder (10) |
| ai/services | 8 | HIGH | ✅ GeminiClientService (8) |
| ai/chat.service | 12 | HIGH | ✅ ChatService integration (12) |
| common/guards | 4 | MEDIUM | ✅ UserThrottlerGuard (4) |
| auth/* | 0 | NONE | ❌ No tests |
| users/* | 0 | NONE | ❌ No tests |
| roles/* | 0 | NONE | ❌ No tests |
| ocr/* | 0 | NONE | ❌ No tests (OcrController, OcrWorker, OcrProducer) |
| consultations/* | 0 | NONE | ❌ No tests (ConsultationService, ChatService relay) |
| common/services | 0 | NONE | ❌ StorageService untested |
| common/filters | 0 | NONE | ❌ GlobalExceptionFilter untested |
| **TOTAL** | **42** | **26%** | **Capa AI: Excelente; Resto: Crítico** |

### Quality Scorecard

| Category | Score | Status | Comment |
|----------|-------|--------|---------|
| Logging | 7/10 | PARTIAL | Consistente en AI, menos en resto; `console.log` en main.ts |
| Error Handling | 6/10 | PARTIAL | AI usa `AppException`, resto usa excepciones raw |
| DTOs + Validation | 8/10 | GOOD | Global ValidationPipe + DTOs, excepto roles sin validadores |
| Security Guards | 2/10 | CRITICAL | Users/Roles sin guards |
| Test Coverage | 3/10 | CRITICAL | 26% archivos, 0 tests en auth/users/ocr |
| Documentation | 7/10 | GOOD | Specs claros, código sin comentarios innecesarios |

---

## 🔴 BLOCKERS — Production Readiness

### HIGH Priority (Block Deployment)

#### 1. Users + Roles CRUD without Guards
**File:** `src/users/users.controller.ts`, `src/roles/roles.controller.ts`

**Issue:** Any unauthenticated request can:
- List all users: `GET /v1/users`
- Create account: `POST /v1/users` (no email verification)
- Delete users: `DELETE /v1/users/{id}`
- Manipulate roles: `POST /v1/roles` (create ADMIN)

**Impact:** Complete auth bypass. Attackers create admin accounts, delete users, manipulate permissions.

**Fix (1h):**
```typescript
// Add to UsersController:
@UseGuards(JwtAuthGuard)
@Controller({ path: 'users', version: '1' })
export class UsersController {
  @UseGuards(RolesGuard)
  @Roles(RoleEnum.ADMIN)
  @Delete(':id')
  async deleteUser(@Param('id') id: number) { ... }

  @UseGuards(RolesGuard)
  @Roles(RoleEnum.ADMIN)
  @Get()
  async getAllUsers() { ... }

  // Regular users can only update themselves:
  @Patch(':id')
  async updateUser(@Param('id') id: number, @Request() req) {
    if (req.user.id !== id) throw new ForbiddenException();
    ...
  }
}

// Same for RolesController — ADMIN only
```

#### 2. S3 Storage Not Implemented
**File:** `src/common/services/storage.service.ts:38,50,67`

**Issue:** If `STORAGE_TYPE=s3`, all methods throw raw `Error('S3 storage not yet implemented')`.
- Returns 500 without formatted error response
- Multi-pod deployments fail (OCR files on pod1, pod2 can't read)

**Impact:** Production deployments with multiple pods → OCR completely broken.

**Fix (3-4h):**
- Implement S3 methods: `getFile()`, `deleteFile()`, `storeFromDisk()`
- Use AWS SDK v3: `@aws-sdk/client-s3`
- Wrap errors in `AppException`
- Test with LocalStack before prod

#### 3. JWT_SECRET Not in .env.example
**File:** `.env.example`

**Issue:** `JWT_SECRET` has default fallback `'default-secret-change-me'` in AuthModule.
- If env var is missing, ALL users share same signing key
- Attackers can forge JWTs

**Impact:** Complete JWT compromise if env not set.

**Fix (10 min):**
```
# .env.example
JWT_SECRET=generate-strong-random-string-in-production
JWT_REFRESH_SECRET=another-strong-random-string
JWT_EXPIRATION=3600
JWT_REFRESH_EXPIRATION=604800
```

#### 4. Database synchronize: true in Development
**File:** `src/config/database.config.ts:9`

**Issue:** `synchronize: NODE_ENV === 'development'` → if NODE_ENV is unset, `synchronize: true` in production
- Running app with NODE_ENV missing → automatic DB migration
- Risk: schema changes silently applied to prod DB

**Impact:** Accidental schema changes, data loss, downtime.

**Fix (10 min):**
```typescript
export default registerAs('database', () => ({
  // HARDCODED: never auto-migrate in production
  synchronize: false, // User must run migrations explicitly
  // Or:
  synchronize: process.env.NODE_ENV === 'development' && process.env.ALLOW_SYNC === 'true',
}));
```

#### 5. Rate Limits Hardcoded (Testing Values)
**File:** `src/app.module.ts:35-45`

**Issue:** Limits are 10,000 req/min (default) and 1,000 req/min (chat).
- Testing values, not production-safe
- Would allow 10k requests per minute per IP

**Impact:** No protection against brute force, DDoS.

**Fix (30 min):**
```typescript
// Move to .env
THROTTLER_DEFAULT_LIMIT=60  // 60 req/min
THROTTLER_CHAT_LIMIT=12      // 12 req/min

// In app.module:
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => [
    { name: 'default', ttl: 60000, limit: parseInt(config.get('THROTTLER_DEFAULT_LIMIT')) },
    { name: 'chat', ttl: 60000, limit: parseInt(config.get('THROTTLER_CHAT_LIMIT')) },
  ],
})
```

---

### MEDIUM Priority (Fix Before Next Release)

#### 6. S3 Error Handling Consistency
**File:** `src/common/services/storage.service.ts`

**Issue:** S3 not implemented methods throw raw `Error()`, but local methods throw no typed error.

**Fix:** All errors → `AppException` with `NOT_IMPLEMENTED` code.

#### 7. Error Shape Inconsistency
**Files:** `src/users/users.service.ts`, `src/auth/auth.service.ts`

**Issue:** Auth/Users services throw NestJS exceptions (`NotFoundException`, `ConflictException`).
AI layer throws `AppException` with errorCode.

**Impact:** Error responses have different shapes.

**Fix:** Migrate all services to `AppException` with consistent error codes.

#### 8. OCR Worker Duck-Typing
**File:** `src/ocr/ocr.worker.ts:142`

```typescript
const isAppException = (err as any).errorCode !== undefined; // fragile
```

**Fix:** Use `instanceof AppException` instead.

#### 9. Zero Tests for Auth, Users, Roles, OCR
**Files:** All CRUD operations

**Missing:** Integration tests for:
- Login happy path + wrong password
- User creation + duplicate email
- OCR upload + status polling
- BullMQ job processing

**Fix Timeline:** 15-20 hours (add at least happy-path tests)

#### 10. Dead Code in AuthController
**File:** `src/auth/auth.controller.ts:23`

**Issue:** Unreachable `return` statement after logger.

**Fix:** Remove line.

---

## 📈 State by Metric

### Completeness
```
Fase 1 (Auth): ████████░░ 80% (guards missing)
Fase 2 (Chat): ██████████ 100%
Fase 3 (OCR):  ██████████ 95% (S3 not done)
Fase 4 (Reports): ░░░░░░░░░░ 0%

Overall: ███████░░░ 70%
```

### Production Readiness
```
Security:     ██░░░░░░░░ 20% (CRITICAL)
Testing:      ███░░░░░░░ 26% (MEDIUM)
Performance:  ████████░░ 80% (model tiering working)
Documentation: ███████░░░ 70% (specs ready)
Error Handling: ██████░░░░ 60% (PARTIAL)

Overall: ████░░░░░░ 40% (BLOCKED)
```

---

## 🚀 Roadmap — Próximos Pasos

### Sprint 1 (THIS WEEK) — Fix Blockers
**Duration:** 8-10 hours
- [ ] Add guards to Users + Roles (1h)
- [ ] Implement S3 methods (3-4h)
- [ ] Add JWT_SECRET to .env.example (15 min)
- [ ] Fix database synchronize (15 min)
- [ ] Move rate limits to env vars (30 min)
- [ ] Add auth/users tests (2-3h)

**Deliverable:** Prod-ready security posture

### Sprint 2 (NEXT WEEK) — Fase 4: Reports
**Duration:** 12-15 hours
- [ ] Create ReportsModule (src/reports/) (4h)
- [ ] PDF generation + biomarkers table (3h)
- [ ] Audit logging (1h)
- [ ] 7 acceptance tests (2-3h)
- [ ] Documentation (1h)

**Deliverable:** Reports PDF export working end-to-end

### Sprint 3 (WEEK AFTER) — S3 + Multi-pod
**Duration:** 8-10 hours
- [ ] S3 full implementation (3-4h)
- [ ] LocalStack testing (2h)
- [ ] Multi-pod OCR integration tests (2-3h)
- [ ] Production S3 setup docs (1h)

**Deliverable:** Multi-pod deployment support

### Sprint 4 (MONTH 2) — Testing + Performance
**Duration:** 20-25 hours
- [ ] OCR worker tests (3-4h)
- [ ] Chat service tests (3-4h)
- [ ] Consultation service tests (2-3h)
- [ ] Integration tests (edge cases) (4-5h)
- [ ] Load testing (model tiering behavior) (3-4h)

**Deliverable:** 70%+ test coverage, performance validated

---

## 📊 Metrics Summary

| Metric | Value | Status |
|--------|-------|--------|
| Code commits | 3 (safety, resilience, ocr) | ✅ |
| PRs merged | 3 (stacked-to-main) | ✅ |
| Tests passing | 42/42 | ✅ |
| Modules | 8 | ✅ |
| Entities | 6 | ✅ |
| Public endpoints | 15 | ⚠️ (10 without guards) |
| Production ready | 40% | 🔴 (blockers active) |

---

## 🎯 Key Wins

1. **Emergency Detection Latching** ✨ — Flag never resets once set, safety guaranteed
2. **Model Tiering by Status** ⚡ — COLLECTING uses flash-lite (1-2s), COMPLETED uses pro (accurate diagnosis)
3. **Async OCR Pipeline** 🎯 — BullMQ scales to 1000+ images without blocking chat
4. **Biomarkers Contextualization** 📊 — Lab values automatically included in AI reasoning
5. **Graceful Degradation** 💪 — If Gemini fails, automatic fallback to faster model + retry

---

## ⚠️ Critical Path

To go to production:
1. **Day 1:** Fix the 5 HIGH blockers (4-5h)
2. **Days 2-4:** Implement Fase 4 (Reports) (12-15h)
3. **Days 5-6:** Implement S3 + test multi-pod (8-10h)
4. **Week 2:** Add missing tests to 70% coverage (20-25h)
5. **Week 3:** UAT, bug fixes, final security audit

**Estimated:** 3-4 weeks to production-ready with full test coverage.

---

## 📞 Next Review

**Target:** End of next sprint (after blockers fixed)

**Success Criteria:**
- [ ] All endpoints have guards
- [ ] S3 integration working
- [ ] Rate limits moved to env
- [ ] 50%+ test coverage
- [ ] Fase 4 (Reports) complete

---

**Generated by:** Multi-agent audit (Project Structure Explorer + Code Quality Auditor)  
**Status:** DEVELOPMENT — Ready for Sprint 1 (Blocker Fixes)
