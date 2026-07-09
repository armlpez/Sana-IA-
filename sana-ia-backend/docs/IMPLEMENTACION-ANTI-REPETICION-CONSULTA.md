# Implementación: Control de Progreso y Anti-Repetición en Consulta SANA

> **Propósito de este documento:** es la LÍNEA BASE de la implementación. Fija todas
> las decisiones tomadas durante el análisis (y las que se descartaron, con su razón)
> para no desviarnos durante el desarrollo. Si algo no está acá, no es parte del alcance.

**Estado:** ✅ IMPLEMENTADO Y VALIDADO POR HTTP — build verde, 28 suites / 247 tests passing (15 en el describe de anti-repetición). Migración corrida en `sana-db-dev`. Loop original reproducido y confirmado resuelto vía pruebas HTTP reales contra el endpoint `/v1/ai/chat` (§8.3-8.4). Dos gaps encontrados en esa validación ya corregidos (D17, D18).
**Fecha de cierre del análisis:** 2026-07-08
**Fecha de implementación:** 2026-07-08
**Fecha de validación HTTP y fixes de gaps:** 2026-07-08
**Componente afectado:** `sana-ia-backend` — flujo de chat médico (`ChatService`)

---

## 1. Problema

La IA (SANA) entra en loop: repite la misma pregunta (típicamente sobre automedicación
en las últimas 48h) una y otra vez, sin avanzar la conversación ni emitir el reporte
final. Confirmado con registros reales de la base de datos.

## 2. Causa raíz (verificada en código)

| # | Causa | Evidencia |
|---|-------|-----------|
| 1 | El modelo es **stateless entre turnos**: solo ve un `summary` que él mismo generó, no el historial real de mensajes | `chat.service.ts:283-292` (`buildPromptWithContext` re-inyecta `consultation.summary`, nunca lee `chat_message`) |
| 2 | La instrucción de automedicación es **"obligatoria" sin condición** de "solo si no pregunté antes" | `chat-system-prompt.ts:11` |
| 3 | La regla "máximo 4 interacciones" es **inverificable por el LLM** — no puede contar en qué turno está | `chat-system-prompt.ts:22` |

**Arquitectura actual relevante:**
- El prompt se arma como un **string plano único** (no un array de mensajes con roles):
  `SANA_CHAT_SYSTEM_PROMPT` + `summary` truncado + síntomas/tratamiento/duración + biomarcadores OCR + mensaje actual. Ver `chat.service.ts:280-328`.
- El `summary` se trunca conservando la **cola** (`.slice(-PROMPT_SUMMARY_MAX_CHARS)`, default 2000 chars). Ver `chat.service.ts:288-290` y `:20`.
- El reporte (`diagnosis`) se persiste cuando **el LLM lo emite**, NO por un gate de status en el backend. Ver `chat.service.ts:156-163`.

## 3. Objetivo

Dar al modelo **memoria determinística** de qué temas ya cubrió, para que:
1. **No repita** preguntas ya hechas (arreglar el bug confirmado).
2. **Cierre** (`status: completed`) cuando tenga los datos clínicos mínimos.
3. **Sin castigar** los errores del paciente ni disparar el costo.

---

## 4. Registro de decisiones (log)

Este registro incluye lo que se ACEPTÓ y lo que se RECHAZÓ, con su razón. No re-introducir
ideas rechazadas sin volver a discutirlas.

| # | Decisión | Resolución | Razón |
|---|----------|:----------:|-------|
| D1 | Enfoque de solución | **C-full, Enfoque B**: el código acumula, el LLM solo etiqueta el turno actual | La memoria entre turnos la debe mantener el CÓDIGO (determinístico), no el LLM (que ya demostró no poder) |
| D2 | ¿Dónde vive la lista de temas? | **Campo dedicado**, NO embebido en `summary` | Separación de concerns; el `summary` ya tiene inconsistencia de tipos (`chat.service.ts:338` lo declara objeto, el prompt pide string) |
| D3 | Aumentar `PROMPT_SUMMARY_MAX_CHARS` (2000→5000) | ❌ **RECHAZADO** | El problema es el CONTENIDO del resumen, no su tamaño; con cap de 4 turnos el resumen casi nunca toca 2000 chars. Suma costo sin beneficio |
| D4 | Pasar mensajes crudos multi-turno (refactor `LlmProviderPort` + 4 adapters) | ❌ **FUERA DE ALCANCE** | Cambio transversal de alto riesgo de regresión; deuda técnica futura, no para este fix |
| D5 | ¿Forzar cierre a las 4 interacciones (hard-gate)? | ❌ **RECHAZADO** | El cierre es un JUICIO CLÍNICO (¿tengo los mínimos?), no mecánico. Forzarlo produce reportes de baja calidad. Verificado: el backend no gatea el reporte por status |
| D6 | Enumerar los temas ordinalmente (1, 2, 3) | ❌ **RECHAZADO** | El ORDEN de los temas no aporta a ninguna decisión; suma fragilidad (renumerar cada turno). Lo que importa es la PERTENENCIA al conjunto |
| D7 | Contador único "Interacción N de 4" | ❌ **RECHAZADO** | Mezclaba dos cosas distintas (progreso clínico vs. costo) y castigaba los errores del paciente |
| D8 | Separar en dos contadores: progreso (`askedTopics`) y costo (`turnCount`) | ⚠️ **PARCIAL** — se acepta `askedTopics`, se descarta `turnCount` (ver D9) | El progreso mide temas (inmune a errores); el costo medía turnos crudos |
| D9 | `turnCount` como freno de costo duro (~8 turnos) | ❌ **RECHAZADO por decisión del usuario** | Era el último corte MECÁNICO del diseño; contradecía el principio "el cierre es clínico, nunca por número". Consecuencia aceptada: no hay techo de costo duro garantizado por código |
| D10 | Número de turno visible al LLM | ❌ **RECHAZADO** | Al modelo le sirve saber QUÉ temas faltan, no en qué turno va |
| D11 | El cierre lo decide el progreso (temas), no el turno | ✅ **ACEPTADO** | Fiel al principio de cierre clínico |
| D12 | El prompt es la FUENTE DE VERDAD clínica (lo diseñó el dueño de la idea) | ✅ **ACEPTADO** | No se agregan ni rediseñan instrucciones clínicas. Los 3 cambios al prompt son puramente MECÁNICOS (anti-repetición + campo `topicAsked`). Las 5 FASES, reglas de seguridad y formato del reporte quedan intactos |
| D13 | Enum de 5 temas, todos referenciados por el prompt actual | ✅ **ACEPTADO** | Verificado contra el prompt: síntomas/duración/automedicación (FASE 1-2 + `extractedData`), antecedentes (FASE 0), laboratorios (FASE 2). El enum es el conjunto de temas POSIBLES bajo la latitud de "preguntas quirúrgicas" — NO una lista de preguntas obligatorias nuevas |
| D14 | `LABORATORIOS` se marca cubierto también por OCR | ✅ **ACEPTADO** | El paciente puede subir labs (OCR → biomarcadores → DATA HARD). Si `consultation.ocrResults` tiene biomarcadores completados, el CÓDIGO marca `laboratorios` como cubierto — la IA nunca pide labs ya cargados. Detección 100% determinística |
| D15 | Regla "limita tu investigación al enum" | ❌ **RECHAZADO** | Restringiría la latitud clínica de "preguntas quirúrgicas" que el dueño de la idea diseñó deliberadamente. Contradice D12 |
| D16 | Acento de las modificaciones al prompt | ✅ **ACEPTADO** | Todo texto NUEVO o MODIFICADO va en español NEUTRO (sin voseo). El texto existente que no se toca queda como está |
| D17 | `askedTopics` se une con `extractedSymptoms`/`extractedDuration`/`extractedTreatment` al calcular "cubierto" | ✅ **ACEPTADO** (post-validación HTTP) | Gap encontrado en vivo: si el paciente ofrece un dato espontáneamente (sin que la IA lo pregunte ESE turno), `topicAsked` nunca se reporta para ese tema y `askedTopics` no lo registra, aunque el dato SÍ esté extraído. Fix: derivar "cubierto" también de lo que ya sabemos (columnas extraídas), no solo de lo que se preguntó. Mismo patrón que D14 (labs vía OCR), generalizado a los otros 3 temas con respaldo estructurado |
| D18 | Línea explícita "Laboratorios: ya solicitados, no aportados — no volver a pedir" en el bloque de progreso | ✅ **ACEPTADO** (post-validación HTTP) | Gap encontrado en vivo: labs se re-preguntó aunque ya figuraba en `askedTopics` — la regla anti-repetición genérica no bastó para ese tema específico. Se distingue el estado "preguntado sin respuesta" del estado "cubierto" y se refuerza inline la regla de FASE 2 ("si no tiene, avanzá igual"). Si el LLM lo sigue ignorando tras este refuerzo, el ajuste que sigue es de redacción clínica en FASE 2 (fuera de este alcance, ver D12) |

---

## 5. Diseño final

### 5.1 Piezas de la solución

| Componente | Rol |
|------------|-----|
| **`askedTopics`** (columna jsonb en `Consultation`) | Progreso clínico + anti-repetición. Lista de temas ya cubiertos. La acumula el código. Gobierna el cierre. Inmune a errores del paciente |
| **`topicAsked`** (campo nuevo en la salida JSON del LLM) | El tema que la IA cubrió en ESTE turno (una clave del enum, o `null`). Lo único que le pedimos al modelo |
| **Enum `CONVERSATION_TOPICS`** | Conjunto cerrado de temas válidos. Da un techo natural y comparación por clave (no NLP) |
| **Bloque `[Progreso de la consulta]`** | Se inyecta en el prompt desde el turno 1 con la lista de temas cubiertos. SIN número de turno |
| **Cambios en el system prompt** | Condicional en la pregunta de automedicación + sección anti-repetición + cierre por mínimos |

### 5.2 Cómo funciona el enum (aclaración)

Un enum = lista cerrada de valores permitidos. En vez de que el LLM escriba texto libre
(impredecible: "pregunté sobre medicamentos" ≠ "indagué automedicación" como strings),
le damos un menú fijo. El modelo reporta la **CLAVE**, no la frase:

```json
{ "topicAsked": "AUTOMEDICACION" }
```

El código compara claves exactas (`"AUTOMEDICACION" === "AUTOMEDICACION"`), sin importar
cómo redactó la pregunta al paciente. Le pedimos que **categorice** (fácil), no que
**recuerde su propia redacción** (frágil).

### 5.3 Cómo decide el LLM poner `completed` (aclaración)

**Este mecanismo YA EXISTE hoy — no lo creamos, solo le damos mejor información.**

- Hoy: el LLM escribe `"status": "completed"` en su JSON cuando, siguiendo las FASES del
  prompt (`chat-system-prompt.ts:13-17`), juzga que tiene los mínimos. El backend solo LEE
  ese campo (`chat.service.ts:370`) y lo persiste. **No hay `if` en el código que fuerce el cierre.**
- Con la propuesta: el bloque `[Progreso de la consulta]` le da un dato DURO (la lista de
  temas cubiertos) para que ese juicio sea confiable, en vez de depender de su relectura
  difusa del `summary` narrativo.

| | Hoy | Con la propuesta |
|---|---|---|
| ¿Quién decide `completed`? | El LLM | **El LLM** (no cambia) |
| ¿Basado en qué? | Relectura difusa del `summary` | Lista explícita `askedTopics` (dato duro) |
| ¿Código fuerza el cierre? | No | **No** (decisión D5/D9) |

---

## 6. Cambios por archivo

### 6.1 `src/consultations/entities/consultation.entity.ts`

Agregar UNA columna (sigue el patrón de estado-acumulado ya usado con `summary` y `emergencyDetected`):

```typescript
/** Temas clínicos ya indagados (claves del enum CONVERSATION_TOPICS).
 *  El código lo acumula por turno. Gobierna el cierre y evita repetir preguntas.
 *  Inmune a turnos "desperdiciados" (errores del paciente): un turno sin tema
 *  nuevo no lo modifica. */
@Column({ type: 'jsonb', default: () => "'[]'" })
askedTopics: string[];
```

### 6.2 `src/ai/prompts/conversation-topics.ts` (NUEVO)

```typescript
/** Conjunto cerrado de temas indagables en una consulta SANA.
 *  El LLM reporta la CLAVE en `topicAsked`; el código acumula el VALOR en askedTopics.
 *
 *  Todos los temas están GROUNDED en el prompt actual (D13):
 *  - SINTOMAS/DURACION/AUTOMEDICACION → FASE 1-2 + los 3 campos de extractedData (mínimos de cierre)
 *  - ANTECEDENTES → FASE 0 (datos base que pueden faltar)
 *  - LABORATORIOS → FASE 2 (evidencia; también cubierto vía OCR, ver D14)
 *
 *  Es el conjunto de temas POSIBLES bajo "preguntas quirúrgicas" — NO preguntas obligatorias. */
export const CONVERSATION_TOPICS = {
  SINTOMAS: 'síntomas',
  DURACION: 'duración',
  AUTOMEDICACION: 'automedicación',
  ANTECEDENTES: 'antecedentes/patologías crónicas',
  LABORATORIOS: 'laboratorios/estudios',
} as const;

export type ConversationTopicKey = keyof typeof CONVERSATION_TOPICS;
```

### 6.3 `src/ai/prompts/chat-system-prompt.ts`

> ⚠️ Regla D16: todo texto nuevo/modificado va en español NEUTRO. El texto que no se toca queda en su acento original.
> ⚠️ Regla D12: los 3 cambios son MECÁNICOS. Prohibido tocar la lógica clínica (FASES, reglas de seguridad, formato del reporte).

1. **Línea 11 → condicional (texto final, neutro).** La primera oración pasa a ser:
   > *"Indaga UNA sola vez, de forma sutil, si el paciente tomó algún fármaco de venta
   > libre o paliativo en las últimas 48h (analgésicos, protectores gástricos,
   > antiespasmódicos) — esto puede enmascarar o atenuar los síntomas actuales. Si
   > "automedicación" ya figura en "Temas ya cubiertos" del bloque [Progreso de la
   > consulta], NO vuelvas a preguntarlo: asume la respuesta como dada y avanza."*

   El resto de la línea 11 ("Ejecutá internamente los 5 Por qué...") queda INTACTO.

2. **Nueva sección "PROGRESO Y ANTI-REPETICIÓN" (texto final, neutro)** — se inserta entre
   REGLAS DE SEGURIDAD y Formato de salida:
   > - *"En cada turno recibirás un bloque [Progreso de la consulta] con los temas ya
   >   cubiertos en esta conversación y la última pregunta realizada."*
   > - *"Nunca repitas un tema que figure en 'Temas ya cubiertos'. Si necesitas más
   >   detalle sobre un tema ya cubierto, formula una pregunta NUEVA que profundice —
   >   nunca la misma pregunta."*
   > - *"Si 'laboratorios/estudios' figura como cubierto, el paciente ya aportó
   >   resultados: no los solicites de nuevo; trabaja con los biomarcadores del bloque
   >   DATA HARD."*
   > - *"En cada respuesta, reporta en el campo `topicAsked` la clave del tema que
   >   abordaste en ESTE mensaje ("SINTOMAS", "DURACION", "AUTOMEDICACION",
   >   "ANTECEDENTES" o "LABORATORIOS"), o `null` si tu mensaje no indaga ningún tema
   >   clínico (saludo, aclaración, reporte final)."*

   NOTA: NO se agrega regla de "limitarse al enum" (D15 rechazada) ni instrucción nueva
   de preguntar antecedentes (D12 — el prompt ya da latitud con "preguntas quirúrgicas").

3. **Formato de salida (ambos modos, `chat-system-prompt.ts:28-53`)** → agregar el campo:
   ```jsonc
   "topicAsked": "SINTOMAS" | "DURACION" | "AUTOMEDICACION" | "ANTECEDENTES" | "LABORATORIOS" | null,
   ```

### 6.4 `src/ai/chat.service.ts`

**a) `parseResponse` (`:335`)** — leer el nuevo campo:
```typescript
// en el tipo de retorno: topicAsked: string | null;
// en el return:
topicAsked: typeof data.topicAsked === 'string' ? data.topicAsked : null,
```

**b) `buildConsultationUpdate` (`:381`)** — acumular solo temas NUEVOS:
```typescript
// topicAsked llega como parámetro (o dentro de `parsed`)
if (topicAsked && CONVERSATION_TOPICS[topicAsked as ConversationTopicKey]) {
  const label = CONVERSATION_TOPICS[topicAsked as ConversationTopicKey];
  if (!consultation.askedTopics?.includes(label)) {
    updates.askedTopics = [...(consultation.askedTopics ?? []), label];
  }
}
```
> Nota: un turno con `topicAsked = null` (error/saludo del paciente) NO modifica
> `askedTopics` → no consume progreso clínico.

**c) `buildPromptWithContext` (`:280`)** — inyectar el bloque de progreso ANTES del
mensaje del paciente y FUERA del guard `if (consultation.summary)` para que aparezca
desde el turno 1. Incluye la detección de labs por OCR (D14) y, tras la validación HTTP,
la unión con datos extraídos (D17) y la señal de "labs pendientes" (D18):
```typescript
const labsViaOcr = consultation.ocrResults?.some(
  r => r.status === 'completed' && r.extractedData?.biomarkers?.length > 0,
) ?? false;

// D17: "cubierto" = lo que se preguntó (askedTopics) UNIDO a lo que ya sabemos
// (columnas extraídas). Cierra el gap de datos espontáneos: si el paciente
// contesta algo sin que la IA lo pregunte ESE turno, topicAsked nunca se
// reporta para ese tema — pero el dato SÍ queda extraído, así que lo usamos
// como señal de cobertura igual.
const coveredTopics = new Set(consultation.askedTopics ?? []);
if (consultation.extractedSymptoms) coveredTopics.add(CONVERSATION_TOPICS.SINTOMAS);
if (consultation.extractedDuration) coveredTopics.add(CONVERSATION_TOPICS.DURACION);
if (consultation.extractedTreatment) coveredTopics.add(CONVERSATION_TOPICS.AUTOMEDICACION);
if (labsViaOcr) coveredTopics.add(CONVERSATION_TOPICS.LABORATORIOS);

const covered = coveredTopics.size ? [...coveredTopics].join(', ') : 'ninguno aún';
const lastAsked = consultation.askedTopics?.at(-1) ?? '—';

// D18: labs "preguntados pero no aportados" es un estado distinto de "cubierto".
// Sin esto, el LLM re-preguntaba labs aunque ya figuraran en askedTopics.
const labsAskedNotProvided =
  (consultation.askedTopics ?? []).includes(CONVERSATION_TOPICS.LABORATORIOS) && !labsViaOcr;

prompt += `[Progreso de la consulta]\n`
        + `Temas ya cubiertos: ${covered}\n`
        + `Última pregunta realizada: ${lastAsked}\n`;

if (labsAskedNotProvided) {
  prompt += `Laboratorios: ya solicitados, el paciente no los aportó — NO volver a pedirlos, avanzá con hipótesis preliminar.\n`;
}
prompt += '\n';
```
> Nota D14/D17: tanto la marca por OCR como la unión con datos extraídos se
> calculan al ARMAR el prompt (no se persisten en `askedTopics`) — el estado
> siempre refleja la realidad actual de las columnas, sin escrituras extra.

Lo que ve el LLM en un turno normal:
```
[Progreso de la consulta]
Temas ya cubiertos: síntomas, duración
Última pregunta realizada: duración
```
Si el paciente ofreció duración/tratamiento espontáneamente (D17), sin que la IA
lo haya "preguntado" ese turno, igual aparece como cubierto:
```
[Progreso de la consulta]
Temas ya cubiertos: duración, automedicación
Última pregunta realizada: —
```
Si se pidieron labs pero el paciente no los aportó (D18):
```
[Progreso de la consulta]
Temas ya cubiertos: automedicación, laboratorios/estudios
Última pregunta realizada: laboratorios/estudios
Laboratorios: ya solicitados, el paciente no los aportó — NO volver a pedirlos, avanzá con hipótesis preliminar.
```

### 6.5 Migración TypeORM (NUEVA)

Agregar la columna `askedTopics` (jsonb, default `'[]'`) a la tabla `consultation`.
Consultas existentes arrancan con `[]` — aceptable (no rompe nada).
> Ubicar la carpeta de migraciones del proyecto antes de generar (probable `src/database/migrations` o similar).

### 6.6 `src/ai/chat.service.spec.ts`

Actualizar aserciones (ver §8).

---

## 7. Comportamiento esperado (flujos)

**Flujo normal:**
```
T1: síntomas       → askedTopics=[síntomas]
T2: duración       → askedTopics=[síntomas, duración]
T3: automedicación → askedTopics=[síntomas, duración, automedicación] → mínimos OK → cierra
```

**Con error del paciente:**
```
T1: síntomas         → tema nuevo ✅   askedTopics=[síntomas]
T2: "me equivoqué"   → topicAsked=null  askedTopics=[síntomas]  ← NO castiga el cierre
T3: duración         → tema nuevo ✅   askedTopics=[síntomas, duración]
T4: automedicación   → tema nuevo ✅   askedTopics=[síntomas, duración, automedicación] → cierra
```

**Anti-repetición (el bug confirmado):**
```
T3: la IA "quiere" preguntar automedicación otra vez
    → ve 'automedicación' en Temas ya cubiertos → NO repite → avanza o cierra
```

---

## 8. Estrategia de testing

1. **Unit (`chat.service.spec.ts`, 15 tests en el describe de anti-repetición):**
   - `buildPromptWithContext` inyecta `[Progreso de la consulta]` con los temas correctos, desde el turno 1.
   - `buildConsultationUpdate` agrega un tema nuevo a `askedTopics` y NO lo duplica si ya existe.
   - Un turno con `topicAsked = null` NO modifica `askedTopics`.
   - `parseResponse` lee `topicAsked` (string válido y `null`).
   - Labs cubiertos por OCR aunque nunca se hayan preguntado (D14).
   - Datos espontáneos (duración/tratamiento) cuentan como cubiertos sin pasar por `askedTopics` (D17).
   - Labs "preguntados sin aportar" dispara la línea de refuerzo; con OCR presente, no la dispara (D18).
2. **No-regresión:** los 4 specs de adapters (`gemini`, `bedrock`, `groq`, `cerebras`) quedan **sin tocar** — no cambiamos la firma de `LlmProviderPort`. Suite completa: 28 suites / 247 tests, 0 fallos.
3. **Validación HTTP real (ejecutada, 2026-07-08):** ver §8.3 y §8.4.

### 8.3 Metodología de validación HTTP

Se levantó el backend local (`npm run start`, contra `sana-db-dev`, con Bedrock Mantle
como proveedor primario — igual que producción) y se ejecutaron conversaciones reales
contra `POST /v1/ai/chat` con un usuario autenticado (JWT real), simulando 3 estilos de
conversación:

1. **Reproducción del loop original** — paciente evasivo/vago al responder sobre
   automedicación (el patrón exacto visto en los registros de producción que motivó
   este trabajo).
2. **Flujo normal completo** — síntomas → duración → tratamiento → antecedentes, hasta
   `status: analyzing`/`completed`.
3. **Error del paciente a mitad de conversación** — un turno tipo "perdón, me equivoqué,
   ignora eso" para confirmar que no consume progreso clínico.

Cada turno se inspeccionó en dos niveles: la respuesta HTTP (`message`, `status`) y el
estado persistido en `sana-db-dev` (`consultation.askedTopics`, `extractedSymptoms`,
`extractedDuration`, `extractedTreatment`) vía query directa.

### 8.4 Resultados

**Antes de D17/D18** (primera corrida): el bug original (repetir la MISMA pregunta de
automedicación en turnos consecutivos) **no se reprodujo** — confirmado resuelto. Pero
la validación reveló dos gaps nuevos, no cubiertos por el diseño original:

- Datos ofrecidos espontáneamente por el paciente (ej. duración mencionada sin que la
  IA la pidiera ese turno) quedaban extraídos en la DB pero **no** marcados en
  `askedTopics` → riesgo de que la IA los "re-pregunte" más adelante.
- `laboratorios/estudios`, aun figurando en `askedTopics`, se volvió a solicitar en un
  turno posterior — la regla anti-repetición genérica no fue suficiente para ese tema.

**Después de D17/D18** (fixes aplicados, suite unit 15/15 verde): pendiente de re-correr
la misma validación HTTP end-to-end para confirmar en vivo que ambos gaps se cerraron
(ver tarea en curso, esta sesión).

---

## 9. Decisiones abiertas

**Ninguna.** Todas las decisiones del análisis quedaron cerradas (ver §4):
- La regla "limitarse al enum" fue RECHAZADA (D15) — restringía la latitud clínica diseñada.
- El enum quedó validado contra el prompt real (D13) — 5 temas, todos referenciados.
- Los laboratorios subidos por OCR se marcan cubiertos por CÓDIGO (D14).
- Las modificaciones al prompt van en español neutro (D16).

---

## 10. Costo (criterio prioritario)

| | Impacto |
|---|---|
| **Runtime / producción** | +~60 caracteres por turno (bloque de progreso). Sin queries extra (la consulta ya se carga 1 vez; el `update` ya se dispara). Una columna jsonb liviana |
| **Efecto neto** | Probablemente **BAJA** el costo: corta el loop de repetición, menos turnos desperdiciados |
| **Sin techo de costo duro** | Consecuencia aceptada de D9. La terminación depende de anti-repetición + techo natural del enum + nudge de cierre |
| **Ingeniería** | ~1 día |

## 11. Fuera de alcance (deuda futura)

- Refactor de `LlmProviderPort` y los 4 adapters (Opción B / D4).
- Paso de mensajes crudos multi-turno con roles reales.
- Cambios al sistema de resiliencia/fallback.
- Freno de costo por turnos crudos (`turnCount` / D9).
