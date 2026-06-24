# Resumen de Implementación: PR-3 (Concurrency + Tests)

Este documento resume los cambios realizados en la tercera y última fase de la resiliencia del chat de IA (PR-3), enfocada en la seguridad ante alta concurrencia, protección contra abusos y validación de la lógica crítica.

## 1. Rate Limiting (Protección contra abusos) - T-10

Implementamos un limitador de peticiones (Throttler) para evitar ataques de denegación de servicio (DDoS) o saturación de cuotas de la API de Gemini por parte de un solo usuario.

**Estrategia implementada:**
- Instalación de `@nestjs/throttler`.
- Creación de un guardián personalizado: `UserThrottlerGuard` en `src/common/guards/user-throttler.guard.ts`.
  - **Decisión arquitectónica:** Limitamos por **ID de Usuario** (si está autenticado) en lugar de por IP, ya que múltiples usuarios podrían estar detrás del mismo NAT en un hospital o clínica. Si no hay ID de usuario, se hace fallback a la IP.
- **Tiers (Niveles) configurados en `app.module.ts`:**
  - `default`: 60 peticiones por minuto.
  - `chat`: 12 peticiones por minuto (endpoint costoso).
- **Manejo de Errores Seguros:** 
  - Se extendió el `GlobalExceptionFilter` para interceptar `ThrottlerException`.
  - En lugar de devolver un stack trace, se devuelve un JSON limpio (HTTP 429) con un mensaje amigable: *"Has enviado demasiados mensajes. Por favor, espera un momento..."* y el header estándar `Retry-After: 60`.

## 2. TypeORM Connection Pool (T-11)

Para prevenir el agotamiento de conexiones a la base de datos (PostgreSQL) bajo cargas simultáneas de chats asíncronos.

**Estrategia implementada:**
- Se inyectaron parámetros explícitos de "pool" al driver `pg` desde `src/config/database.config.ts`.
- **Configuraciones aplicadas:**
  - `max: 20` (Tamaño máximo del pool de conexiones).
  - `idleTimeoutMillis: 30000` (Cierra conexiones inactivas después de 30s).
  - `connectionTimeoutMillis: 2000` (Timeout de 2s para obtener una conexión del pool, previniendo cuelgues indefinidos).
- Se mapearon a variables de entorno en `.env.example` para su tuning en producción.

## 3. Pruebas Unitarias de Seguridad Clínica (Safety Tests) - T-12

Se implementaron las **primeras pruebas unitarias (`*.spec.ts`) del repositorio**, con un total de **42 tests (100% PASS)** centrados exclusivamente en la infraestructura crítica y el manejo de errores del sistema.

### Suites implementadas:

1. **`SafeFallbackBuilder` (`safe-fallback.builder.spec.ts`) - 11 tests**
   - Verifica que el fallback devuelva JSON válido según el esquema Zod de la API.
   - **Cerrojo de Emergencia:** Asegura que si hubo una emergencia previa, el fallback de chat incluya un aviso de urgencias médicas.
   - **Anti-Alucinación:** Verifica mediante regex que NUNCA se intente fabricar contenido clínico (diagnósticos, enfermedades o tratamientos falsos) cuando el servicio está caído.
   - **PHI Safe:** Asegura que los datos protegidos del paciente nunca se incluyan en el log del error de fallback.

2. **`ErrorClassifier` (`error-classifier.spec.ts`) - 17 tests**
   - Verifica el mapeo correcto de errores (Timeout, Parse, 429, 503, Policy Block) basándose en sentinelas internos (`__kind`), códigos de estado HTTP o expresiones regulares en el mensaje original de Gemini.

3. **`GeminiClientService` (`gemini-client.service.spec.ts`) - 8 tests**
   - **Timeout estricto:** Simula llamadas que quedan colgadas indefinidamente para asegurar que nuestro timeout las corta y lanza un `AppException`.
   - **Retry Policy:** Verifica que los errores `429` y `503` se reintenten (con backoff), mientras que errores como `PARSE` o `TIMEOUT` local se cortan de inmediato sin reintento (Fail Fast).

4. **`UserThrottlerGuard` (`user-throttler.guard.spec.ts`) - 4 tests**
   - Prueba el método `getTracker` aislando la lógica para confirmar que correctamente abstrae el ID del usuario como clave del rate limit.

5. **`ChatService` Latch Pattern (`chat.service.spec.ts`) - 2 tests**
   - Prueba específica de persistencia en TypeORM.
   - Simula que la IA detecta una emergencia, asegurando que `emergencyDetected: true` se guarde en base de datos.
   - Simula un turno posterior donde la IA dice "ya no es emergencia", validando que el backend **no sobrescriba** el valor y el cerrojo permanezca en `true`.

## Impacto Global
Con la culminación de PR-3, el subsistema de chat ahora es **totalmente resiliente**. No se caerá ante picos de tráfico (Pool), no será víctima de usuarios abusivos (Throttler), no colgará procesos por respuestas lentas de Gemini (Timeouts + Retries), y garantiza la no-fabricación de datos clínicos ante desastres de API, todo respaldado por pruebas unitarias automatizadas.
