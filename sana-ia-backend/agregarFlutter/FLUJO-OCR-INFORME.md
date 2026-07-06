# Flujo completo: OCR de laboratorio → Informe PDF

**Versión:** 1.0
**Fecha:** 2026-07-06

Este documento aclara **cuándo** se usa cada uno de los dos flujos documentados por separado (`OCR-ENDPOINTS-FLUTTER.md` y `REPORTES-ENDPOINTS-FLUTTER.md`) y cómo se relacionan entre sí dentro de una misma consulta.

---

## Línea de tiempo de una consulta

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CONSULTA (conversationId)                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  [collecting] ───► [analyzing] ───► [completed]                     │
│       │                  │                │                        │
│       │  OCR se usa AQUÍ (0 a N veces)     │  Informe se usa AQUÍ  │
│       │  mientras la conversación sigue    │  (una vez que hay      │
│       │  abierta                           │  diagnóstico final)   │
│       ▼                                    ▼                        │
│  POST /v1/ocr/analyze              GET /v1/consultations/:id/report │
│  (async, con polling)              (síncrono, sin polling)          │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## 1. OCR — durante la consulta

**Cuándo se dispara:** en cualquier momento mientras la consulta está abierta (`collecting` o `analyzing`), cada vez que el paciente sube una foto o PDF de un resultado de laboratorio.

- Es **asíncrono**: el front sube la imagen, recibe un `jobId` inmediato (`202 Accepted`), y hace polling a `GET /v1/ocr/jobs/:id` hasta `completed` o `failed`.
- Es asíncrono porque Gemini Vision (u otro proveedor del fallback) tarda 15-120 segundos; una conexión HTTP abierta ese tiempo en mobile causaría timeouts.
- **Puede repetirse varias veces** dentro de la misma consulta — el paciente puede subir varios laboratorios distintos (ej. química sanguínea + hemograma) siempre que use el mismo `consultationId` en cada subida.
- Cada resultado OCR completado queda **asociado a la consulta** en la base de datos (tabla de resultados de laboratorio ligada por `consultationId`).
- La imagen original se borra del almacenamiento (local o S3) inmediatamente después de procesarse, éxito o fallo — no se conserva la imagen, solo los biomarcadores extraídos en la base de datos.

## 2. Informe PDF — al final de la consulta

**Cuándo se dispara:** solo cuando la consulta llegó a `completed` (ya existe un diagnóstico / análisis de causa raíz generado por el chat).

- Es **síncrono**: una sola llamada `GET /v1/consultations/:id/report` devuelve directamente los bytes del PDF, sin `jobId` ni polling.
- Se genera **en memoria, en el momento de cada request** — no se persiste en ningún lado (ni disco, ni S3). Si se pide dos veces, se regenera dos veces a partir de los datos actuales en la base.
- Si la consulta no está `completed`, el backend responde `400`.

## 3. Cómo se conectan

El informe **no vuelve a llamar a Gemini ni a S3** — solo lee de PostgreSQL:

```
OCR (durante)  ──► guarda biomarcadores en DB, ligados a consultationId
                          │
                          ▼
Informe (al final) ──► lee consulta + diagnóstico + TODOS los biomarcadores
                        con ese mismo consultationId, y arma la tabla del PDF
```

- Si el paciente **subió** uno o más laboratorios vía OCR durante la consulta → el PDF trae la tabla de biomarcadores completa.
- Si el paciente **nunca subió** ningún laboratorio → el PDF igual se genera, pero la sección de biomarcadores dice *"No hay resultados de laboratorio adjuntos"*.
- No hay forma de agregar un laboratorio *después* de que la consulta ya esté `completed` — el OCR solo tiene sentido mientras la conversación sigue abierta. Si se necesita agregar un lab tardío, habría que reabrir la consulta (fuera del alcance de este documento).

## 4. Resumen para el front

| | OCR | Informe |
|---|---|---|
| **Cuándo** | Durante la consulta (`collecting`/`analyzing`) | Al final (`completed`) |
| **Patrón** | Asíncrono (202 + polling) | Síncrono (200 directo) |
| **Repetible** | Sí, varias veces por consulta | Sí, se puede volver a pedir (regenera, no cachea) |
| **Persistencia de datos fuente** | Imagen se borra tras procesar; biomarcadores quedan en DB | PDF no se persiste nunca |
| **Depende de** | `consultationId` de una consulta abierta | Que esa consulta ya tenga diagnóstico |
