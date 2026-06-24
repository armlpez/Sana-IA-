# Plan de Arquitectura: Trabajos Asíncronos con BullMQ y Redis

Este documento traza la ruta técnica para la implementación de colas asíncronas en el backend de Sana IA, basándose en la especificación técnica de Sinergia Ingeniería-Medicina (PR-DTI-001) y el análisis de la arquitectura actual.

## 1. Contexto y Justificación

El backend actual (NestJS + TypeORM + Gemini) opera de forma **100% síncrona** en su flujo de chat. Esto es correcto para la *Fase 1 y 3* (Anamnesis e Interrogatorio Dirigido) porque el usuario espera respuestas inmediatas (1-5 segundos).

Sin embargo, el **Flujo de Interacción del Usuario** (Fase 2 y 4) introduce requerimientos inherentemente pesados:
1. **OcrModule (Fase 2):** Procesamiento de imágenes de laboratorios (Química Sanguínea), extracción de texto, limpieza NLP y detección de biomarcadores (Data Hard). Toma de 15 a 120 segundos.
2. **ReportsModule (Fase 4):** Generación del informe técnico final en PDF para el médico tratante.

Mantener conexiones HTTP abiertas durante minutos en clientes móviles (Flutter) provocará timeouts y pérdida de datos. Aquí es donde **BullMQ** (respaldado por **Redis**) entra como la solución nativa de NestJS para delegar trabajos en segundo plano (Background Jobs).

## 2. Decisión Arquitectónica Clave

- ❌ **El Chat se queda Síncrono:** La ruta `/ai/chat` no usará colas. Retrasar un mensaje de chat con polling arruina la UX.
- ✅ **OCR y Reportes van a BullMQ:** Las tareas que tocan procesamiento de archivos e IA densa se envían a *Workers* dedicados.

## 3. Infraestructura Necesaria

Integrar BullMQ requiere agregar **Redis** a nuestro stack (actualmente compuesto solo por Node.js y PostgreSQL).

*   **Entorno Local:** `docker-compose` con una imagen Alpine de Redis.
*   **Entorno Producción:** Servicio manejado (ej. Upstash, ElastiCache) por estabilidad y seguridad.
*   **Librería Core:** `@nestjs/bullmq` (estándar oficial de NestJS).

## 4. Estrategia de Entrega al Cliente (App Flutter)

Dado que la arquitectura base usa REST (sin WebSockets), el patrón de entrega será **HTTP Polling con Exponential Backoff**.

**El Flujo:**
1. Flutter sube la imagen al endpoint `POST /labs/ocr`.
2. El Backend guarda la imagen, encola el trabajo en BullMQ, y responde inmediatamente `202 Accepted` devolviendo un `{ jobId }`.
3. Flutter consulta periódicamente `GET /labs/ocr/:jobId/status` (ej. cada 3-5 segundos).
4. El Worker procesa el OCR y guarda los biomarcadores en PostgreSQL.
5. En el siguiente polling, Flutter recibe `status: 'completed'` con los resultados.

*(Nota: En una fase posterior se podrá integrar Firebase Cloud Messaging (FCM) para notificaciones Push directas).*

## 5. Manejo de PHI (Protected Health Information)

La Privacidad y Seguridad Médica son críticas. La regla de oro para implementar BullMQ en Sana IA es:
**El payload de Redis NO DEBE contener datos médicos ni imágenes crudas.**

*   **Mal:** Enviar el base64 de la imagen de sangre o los biomarcadores extraídos a través de la cola de BullMQ.
*   **Bien:** El payload de BullMQ solo contendrá el ID del registro en Postgres (`{ ocrResultId: 'uuid', userId: 123 }`). El Worker consultará la base de datos para obtener la ruta del archivo, procesará, y guardará directamente en Postgres. Redis debe ser tratado como efímero e inseguro para PHI.

## 6. Fases de Implementación Propuestas

Esta es una hoja de ruta para el desarrollo futuro:

### Fase 1: Prerrequisitos (Preparación)
- Levantar contenedor local de Redis.
- Configurar variables de entorno (`REDIS_HOST`, `REDIS_PORT`, etc.) en `.env`.
- Integrar `BullModule.forRootAsync()` en `AppModule`.

### Fase 2: Construcción del OcrModule (La Prueba de Fuego)
- Crear `OcrModule` y registrar la cola `BullModule.registerQueue({ name: 'ocr' })`.
- Crear el Producer (API que recibe imagen y lanza el job).
- Crear el Consumer (`@Processor('ocr')`) que orqueste la subida a storage seguro y la llamada a Gemini Visión.
- Crear el endpoint de status (polling).

### Fase 3: Construcción del ReportsModule
- Replicar el patrón para registrar la cola `reports`.
- Procesar la generación del PDF con la historia médica sin bloquear el hilo principal.

## Conclusión
La integración de BullMQ no debe hacerse en el vacío. Debe estar atada a la construcción del `OcrModule` o `ReportsModule` para justificar el aumento en la complejidad de infraestructura (Redis). Mientras tanto, el ecosistema síncrono del chat ya está asegurado y es funcional.
