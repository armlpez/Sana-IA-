# 📈 Análisis de Escalabilidad y Concurrencia — SANA-IA Backend

> **Pregunta que responde este documento**: ¿El **CÓDIGO** está preparado para concurrencia (50–100+ usuarios simultáneos), de modo que cuando existan los recursos (Gemini de pago, instancias más grandes, múltiples réplicas) el código NO sea el cuello de botella?
>
> **Alcance**: Solo el código de la aplicación. Explícitamente **fuera de alcance**: tamaño del EC2 y cuota del free tier de Gemini (son límites de infraestructura/proveedor, no de código).
>
> **Fecha**: 2026-07-04 · **Commit auditado**: `main @ 1cf5395` · **Método**: auditoría estática de los caminos calientes (chat, OCR, auth, reports, throttling, DB pool).

---

## 🎯 Veredicto ejecutivo

| Eje | Resultado |
|---|---|
| **¿Seguro bajo concurrencia?** (¿corrompe datos / se cae?) | ✅ **SÍ es seguro.** Sin races de corrupción, auth stateless, degradación elegante. |
| **¿Escala limpiamente con recursos?** | ⚠️ **Parcialmente.** Hay 7 gaps concretos, ninguno estructural. |

**Conclusión**: los cimientos están bien. El código HOY está optimizado para **sobrevivir** bajo carga (nunca 500, fallback seguro), no para **escalar limpiamente**. La diferencia entre ambas cosas es la lista de 7 gaps de abajo. El patrón correcto (cola asíncrona) **ya está implementado para OCR** — la mayor parte del trabajo es extender esa misma disciplina al chat y cerrar 3–4 patrones de resiliencia conocidos.

---

## ✅ Lo que el código YA hace bien (listo para concurrencia)

Estas decisiones son correctas y no requieren cambios:

| Fortaleza | Evidencia | Por qué escala |
|---|---|---|
| **Auth stateless (JWT)** | `src/auth/auth.service.ts` | Cualquier réplica valida sin estado compartido → horizontal-friendly |
| **I/O asíncrono no bloqueante** | `src/ai/chat.service.ts:74` (`await generateWithResilience`) | El event loop no se bloquea esperando a Gemini; una instancia sostiene decenas de requests en vuelo |
| **OCR desacoplado (BullMQ + Redis)** | `src/ocr/ocr.worker.ts:29` (`@Processor(concurrency: 2)`) | Encola, procesa N en paralelo, degrada con gracia y el worker escala horizontal. **Es el patrón de referencia.** |
| **Degradación elegante** | `src/ai/chat.service.ts` `handleChatFailure` | Nunca 500; latch de emergencia monótono. Bajo fallo masivo el sistema queda ARRIBA |
| **Sin estado mutable peligroso** | `modelCache` es cache read-through; latch solo escribe `true` | No hay condiciones de carrera que corrompan datos |
| **Pool de DB tuneado y configurable** | `src/config/database.config.ts:12-16` (`max:20`, timeouts) | No abre conexiones sin límite |
| **Throttle por usuario** | `src/common/guards/user-throttler.guard.ts` (keyea por `user.id`) | Un usuario no bloquea a otros en la misma NAT/carrier |
| **Contexto de prompt acotado** | `src/ai/chat.service.ts:20` (`PROMPT_SUMMARY_MAX_CHARS`) | Los tokens no crecen sin límite en conversaciones largas |

---

## ⚠️ Gaps de escalabilidad (priorizados por impacto)

> Severidad: 🔴 Alta (limita el throughput real / consistencia con réplicas) · 🟠 Media · 🟢 Baja
> Esfuerzo: estimación relativa (S = horas, M = 1–2 días, L = 3+ días)

### GAP-01 · 🔴 El chat es SÍNCRONO mientras el OCR es ASÍNCRONO
- **Descripción**: El endpoint de chat hace `await` directo a Gemini y mantiene la conexión HTTP abierta durante toda la latencia (2–7 s típico). El OCR, en cambio, encola y responde `202` de inmediato. Existe la red de contención (cola) para OCR pero **no para el chat**.
- **Evidencia**: `src/ai/ai.controller.ts:41-46` (`await this.chatService.sendMessage`) → `src/ai/chat.service.ts:74`.
- **Impacto con recursos**: cada instancia queda limitada por conexiones abiertas + memoria por request, no por CPU. A alta concurrencia, el throughput por instancia se topa aunque haya cuota de Gemini de sobra.
- **Fix recomendado**: pool de workers acotado para el chat (patrón bulkhead) **o** respuesta por streaming (SSE / chunked) para liberar la percepción de latencia. El blueprint ya existe en `ocr.worker.ts`.
- **Esfuerzo**: **L** (cambia el contrato de respuesta del chat; coordinar con Flutter).

### GAP-02 · 🔴 Sin circuit breaker → amplificación de reintentos
- **Descripción**: Ante errores transitorios (429/503) se reintenta hasta 2 veces con backoff. Bajo un incidente de Gemini, **N requests → hasta 3N llamadas**, justo cuando el downstream está saturado. Empeora la caída en vez de protegerla.
- **Evidencia**: `src/ai/services/gemini-client.service.ts:19-22` (`RETRYABLE_KINDS`, `retryMax`), bucle de retry `:95-127`.
- **Impacto con recursos**: sigue doliendo INCLUSO con cuota paga durante cualquier caída transitoria de Gemini.
- **Fix recomendado**: circuit breaker (abre tras N fallos consecutivos, hace fast-fail a fallback durante un cooldown, luego half-open para probar). Complementa —no reemplaza— al retry.
- **Esfuerzo**: **M**.

### GAP-03 · 🟠 Sin bulkhead / límite global de concurrencia hacia Gemini
- **Descripción**: Nada acota cuántas llamadas simultáneas a Gemini hay en vuelo. Con recursos + muchos usuarios, se disparan cientos de llamadas concurrentes (Gemini también tiene límites de concurrencia).
- **Evidencia**: `src/ai/services/gemini-client.service.ts` — `generateWithResilience` no pasa por ningún semáforo/limitador compartido.
- **Impacto con recursos**: throughput impredecible y riesgo de saturar al proveedor.
- **Fix recomendado**: semáforo de concurrencia (p. ej. `p-limit` o cola interna) que acote llamadas en vuelo y encole el excedente. Idealmente compartido entre chat y OCR (misma cuota).
- **Esfuerzo**: **M**.

### GAP-04 · 🟠 Throttler en memoria → inconsistente entre réplicas
- **Descripción**: `ThrottlerModule.forRoot([...])` se registra **sin `storage`**, por lo que usa almacenamiento en memoria del proceso. Con 2+ réplicas, el límite pasa a ser **por instancia** (un usuario obtendría Nx el límite real).
- **Evidencia**: `src/app.module.ts:32-47` (sin opción `storage`).
- **Impacto con recursos**: en el momento que escales a horizontal, el rate limiting deja de ser confiable globalmente.
- **Fix recomendado**: storage Redis para el throttler (`@nest-lab/throttler-storage-redis` o equivalente). Redis **ya está desplegado** por BullMQ.
- **Esfuerzo**: **S**.

### GAP-05 · 🟡 El worker de OCR corre DENTRO del proceso de la API
- **Descripción**: El `OcrWorker` se ejecuta en el mismo proceso Node que sirve la API. El procesamiento pesado de Gemini Vision compite con las requests HTTP por el mismo event loop/CPU.
- **Evidencia**: `src/ocr/ocr.worker.ts:32` (`OcrWorker extends WorkerHost`), registrado en el `AppModule` monolítico.
- **Impacto con recursos**: picos de OCR degradan la latencia de la API en la misma instancia.
- **Fix recomendado**: separar el worker en su propio proceso/deploy (la cola de BullMQ ya lo permite; solo hay que un entrypoint que levante el worker sin el HTTP server). El cimiento está.
- **Esfuerzo**: **M**.

### GAP-06 · 🟡 La fase de escritura del chat NO es transaccional
- **Descripción**: mensaje de usuario, mensaje del asistente, `update` de la consulta y `diagnosis` son escrituras separadas (algunas en `Promise.all`). Un crash a mitad deja estado parcial (p. ej. mensaje de usuario huérfano sin respuesta, o diagnosis sin update de estado).
- **Evidencia**: `src/ai/chat.service.ts:60-65` (user msg), `:114-142` (`Promise.all` de assistant + update + diagnosis) — sin `queryRunner`/transacción.
- **Impacto con recursos**: a escala, los fallos parciales son más frecuentes → inconsistencias acumuladas.
- **Fix recomendado**: envolver la fase de escritura en una transacción (`dataSource.transaction(...)` o `QueryRunner`). Mantener el latch de emergencia monótono dentro de la transacción.
- **Esfuerzo**: **M**.

### GAP-07 · 🟢 `bcrypt` acotado por `UV_THREADPOOL_SIZE` (default 4)
- **Descripción**: `bcrypt.hash/compare` async usan el threadpool de libuv (4 hilos por defecto). Logins/registros concurrentes se serializan de a 4.
- **Evidencia**: `src/auth/auth.service.ts:47` (`bcrypt.compare`), `src/users/users.service.ts:41` (`bcrypt.hash`).
- **Impacto con recursos**: menor — login/registro no es el hot path. Solo relevante en picos de autenticación masiva.
- **Fix recomendado**: subir `UV_THREADPOOL_SIZE` por variable de entorno (p. ej. 16) en instancias con más núcleos.
- **Esfuerzo**: **S**.

> **Nota (no es gap)**: la generación de PDF (`src/reports/reports.service.ts:310`) es CPU-bound pero de baja frecuencia (descarga ocasional). Aceptable; monitorear solo si se vuelve masiva.

---

## 🧮 Matriz de priorización

| Gap | Severidad | Esfuerzo | ¿Bloquea horizontal scaling? | Prioridad |
|---|---|---|---|---|
| GAP-04 Throttler Redis | 🟠 | S | **SÍ** | **1** (rápido + habilitador) |
| GAP-02 Circuit breaker | 🔴 | M | No | **2** |
| GAP-03 Bulkhead Gemini | 🟠 | M | No | **3** |
| GAP-01 Chat asíncrono/streaming | 🔴 | L | No | **4** (mayor, coordinar Flutter) |
| GAP-05 Worker separado | 🟡 | M | Ayuda | 5 |
| GAP-06 Transacción de escritura | 🟡 | M | No | 6 |
| GAP-07 UV_THREADPOOL_SIZE | 🟢 | S | No | 7 (quick win) |

---

## 🗺️ Roadmap recomendado

**Fase A — Habilitadores baratos (antes de escalar a 2+ réplicas)**
1. **GAP-04**: throttler con storage Redis. Sin esto, el rate limiting es mentira en horizontal.
2. **GAP-07**: subir `UV_THREADPOOL_SIZE`. Un env var.

**Fase B — Resiliencia bajo carga (protege la cuota paga y las caídas transitorias)**
3. **GAP-02**: circuit breaker sobre Gemini.
4. **GAP-03**: bulkhead / semáforo de concurrencia compartido chat+OCR.

**Fase C — Throughput por instancia (cuando la carga real lo justifique)**
5. **GAP-01**: chat asíncrono o por streaming (coordinar contrato con Flutter).
6. **GAP-05**: worker OCR en proceso separado.
7. **GAP-06**: transacción en la fase de escritura del chat.

---

## 📌 Regla de oro para el equipo

> Escalar CÓMPUTO (más/instancias más grandes) sin cerrar GAP-02/03/04 es **plata tirada**: el límite se mueve a la cuota del proveedor y a la resiliencia, no al hardware. El orden correcto es: **primero el código resiliente y distribuible, después el hardware, y en paralelo la cuota paga de Gemini.**

---

## Referencias de código
- Chat (síncrono): `src/ai/chat.service.ts`, `src/ai/ai.controller.ts`
- Resiliencia Gemini (retry, sin breaker/bulkhead): `src/ai/services/gemini-client.service.ts`
- OCR (patrón async de referencia): `src/ocr/ocr.worker.ts`, `src/ocr/ocr.controller.ts`
- Throttling (in-memory): `src/app.module.ts`, `src/common/guards/user-throttler.guard.ts`
- Pool DB: `src/config/database.config.ts`
- Reportes (PDF CPU-bound): `src/reports/reports.service.ts`
- Documentos relacionados: `docs/ASYNC-BULLMQ-PLAN.md`, `docs/PR3-CONCURRENCY-AND-TESTS.md`, `docs/mejoras/STORAGE-SCALABILITY.md`
