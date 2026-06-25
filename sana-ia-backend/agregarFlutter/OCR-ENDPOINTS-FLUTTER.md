# OCR de Laboratorio — Guía de Integración para Flutter

**Versión:** 1.0  
**Fecha:** 2026-06-24  
**Rama backend:** `bullMQ`

---

## 1. Resumen de la funcionalidad

El módulo OCR permite que el usuario suba una imagen de sus resultados de laboratorio (foto o PDF), y el backend extrae automáticamente los biomarcadores (glucosa, colesterol, hemoglobina, etc.) de forma **asíncrona**.

### ¿Por qué es asíncrono?

El procesamiento de imágenes con Gemini Vision tarda entre **15 y 120 segundos** según la complejidad del examen. Mantener una conexión HTTP abierta ese tiempo en mobile causa timeouts y pérdida de datos. La arquitectura adoptada es:

```
Flutter          Backend                   BullMQ / Worker
  │                │                            │
  │─── POST ──────►│  guarda en PostgreSQL       │
  │                │──── encola job ────────────►│
  │◄── 202 ───────│  devuelve jobId             │
  │                │                            │ procesa imagen
  │── GET (poll) ─►│  lee estado desde PG ◄─────│ (Gemini Vision)
  │◄── queued ────│                            │
  │── GET (poll) ─►│                            │
  │◄── completed ─│  devuelve biomarcadores     │
```

**Patrón: Upload → 202 Accepted → Polling**

El frontend NO espera el resultado. Sube la imagen, recibe un `jobId`, y consulta periódicamente hasta que el status sea `completed` o `failed`.

---

## 2. Autenticación

Todos los endpoints de OCR requieren un JWT Bearer token. El token se obtiene con el endpoint de login.

### Login

**Método:** `POST`  
**Ruta:** `/v1/auth/login`  
**Content-Type:** `application/json`

**Body:**

```json
{
  "email": "usuario@ejemplo.com",
  "password": "mipassword123"
}
```

**Respuesta exitosa (200 OK):**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 42,
    "email": "usuario@ejemplo.com",
    "name": "Juan Pérez",
    "role": "user"
  }
}
```

El `access_token` expira (ver configuración del servidor). Para renovarlo sin relogueo usar `POST /v1/auth/refresh` con el `refresh_token`.

### Uso del token en cada request

Agregar el header `Authorization` en **todas** las llamadas a OCR:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## 3. Endpoint 1 — Subir imagen de laboratorio

### Especificación

| Campo | Valor |
|-------|-------|
| **Método** | `POST` |
| **Ruta** | `/v1/ocr/analyze` |
| **Content-Type** | `multipart/form-data` |
| **Auth requerida** | Sí — Bearer token |

### Campos del formulario multipart

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `image` | File | **Sí** | Imagen o PDF del laboratorio |
| `consultationId` | number | No | ID de consulta a la que asociar este resultado |
| `originalFilename` | string | No | Nombre de archivo a mostrar (si no se envía, se usa el nombre original del archivo) |

### Restricciones del archivo

| Restricción | Valor |
|-------------|-------|
| Tamaño máximo | **10 MB** |
| Tipos MIME permitidos | `image/jpeg`, `image/png`, `image/webp`, `application/pdf` |

Si el archivo supera el tamaño o tiene un tipo no permitido, el servidor rechaza el upload con `400 Bad Request`.

### Respuesta exitosa (202 Accepted)

```json
{
  "statusCode": 202,
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "message": "Lab image received. Processing will begin shortly."
}
```

El campo `jobId` es el UUID que el front usará para hacer polling.

---

## 4. Endpoint 2 — Consultar resultado del job (Polling)

### Especificación

| Campo | Valor |
|-------|-------|
| **Método** | `GET` |
| **Ruta** | `/v1/ocr/jobs/:id` |
| **Auth requerida** | Sí — Bearer token |

El parámetro `:id` es el `jobId` recibido en el paso anterior. El servidor valida que el job pertenezca al usuario autenticado.

---

### Respuestas posibles según estado

#### a) Job en proceso (`queued` o `processing`)

El job fue recibido pero todavía no terminó. El front debe seguir consultando.

```json
{
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "createdAt": "2026-06-24T10:30:00.000Z",
  "processingTimeMs": null
}
```

```json
{
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "processing",
  "createdAt": "2026-06-24T10:30:00.000Z",
  "processingTimeMs": null
}
```

#### b) Job completado (`completed`)

El OCR terminó exitosamente. `extractedData` contiene los biomarcadores estructurados.

```json
{
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "completed",
  "createdAt": "2026-06-24T10:30:00.000Z",
  "processingTimeMs": 18432,
  "extractedData": {
    "biomarkers": [
      {
        "name": "Glucosa",
        "value": "95",
        "unit": "mg/dL",
        "referenceRange": "70-100",
        "flag": "normal"
      },
      {
        "name": "Colesterol Total",
        "value": "215",
        "unit": "mg/dL",
        "referenceRange": "< 200",
        "flag": "alto"
      },
      {
        "name": "Hemoglobina",
        "value": "11.2",
        "unit": "g/dL",
        "referenceRange": "12-16",
        "flag": "bajo"
      },
      {
        "name": "Potasio",
        "value": "3.1",
        "unit": "mEq/L",
        "referenceRange": "3.5-5.1",
        "flag": "critico"
      }
    ],
    "labType": "química sanguínea",
    "labDate": "2026-06-20",
    "confidence": 0.94
  }
}
```

##### Shape de cada biomarcador

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `name` | `string` | Nombre del biomarcador (ej. "Glucosa") |
| `value` | `string` | Valor numérico detectado como string |
| `unit` | `string` | Unidad de medida exacta (ej. "mg/dL", "mEq/L", "g/dL") |
| `referenceRange` | `string` | Rango de referencia visible en el laboratorio, o `null` si no es legible |
| `flag` | `string` | Estado del valor: `"normal"` \| `"alto"` \| `"bajo"` \| `"critico"` |

##### Campos adicionales de `extractedData`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `labType` | `string` | Tipo de examen detectado |
| `labDate` | `string` | Fecha del examen en formato ISO 8601, si es legible en la imagen |
| `confidence` | `number` | Confianza del modelo (0.0 a 1.0) sobre la extracción |

> **Nota:** Si la imagen no es un laboratorio reconocible, `biomarkers` puede llegar vacío y `confidence` será `0`. Verificar `biomarkers.length > 0` antes de renderizar.

#### c) Job fallido (`failed`)

El procesamiento falló (error en Gemini, imagen ilegible, etc.). El mensaje es sanitizado — no expone detalles internos ni PHI.

```json
{
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "failed",
  "createdAt": "2026-06-24T10:30:00.000Z",
  "processingTimeMs": 4201,
  "errorMessage": "The request could not be processed. Please check your input."
}
```

El campo `extractedData` **no está presente** en respuestas fallidas.

---

## 5. Ciclo de vida del job

```
[QUEUED] ──────► [PROCESSING] ──────► [COMPLETED]
                      │
                      └─────────────► [FAILED]
```

| Estado | Descripción |
|--------|-------------|
| `queued` | Job encolado en BullMQ, esperando worker disponible |
| `processing` | Worker activo procesando la imagen con Gemini Vision |
| `completed` | OCR exitoso, biomarcadores disponibles en `extractedData` |
| `failed` | Error durante el procesamiento |

### Reintentos automáticos

El sistema reintenta automáticamente hasta **3 veces** antes de marcar el job como `failed`. El backoff es exponencial: 2s → 4s → 8s. El front **no necesita manejar los reintentos** — el job llega a `failed` solo cuando se agotaron todos los intentos.

---

## 6. Guía de polling para el front

### Intervalo recomendado

Consultar cada **3 a 5 segundos**. No pollear más rápido: el procesamiento tarda mínimo 15 segundos y saturar el servidor no acelera el resultado.

### Cuándo detener el polling

| Condición | Acción |
|-----------|--------|
| `status === 'completed'` | Detener. Mostrar resultados. |
| `status === 'failed'` | Detener. Mostrar error al usuario. |
| Han pasado más de **3 minutos** desde el envío | Detener. Mostrar timeout al usuario. Sugerir reintentar. |

### Estrategia de timeout

El front debe implementar un timeout propio (3 minutos es razonable para los casos más lentos). Si el timeout se alcanza con el job todavía en `queued` o `processing`, mostrar un mensaje amigable y permitir reintentar la subida.

---

## 7. Ejemplos de código Flutter/Dart

Los ejemplos usan el paquete [`dio`](https://pub.dev/packages/dio). Si se prefiere `http`, la lógica es equivalente.

### Dependencias

```yaml
# pubspec.yaml
dependencies:
  dio: ^5.4.0
```

### Configuración base

```dart
import 'package:dio/dio.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'https://api.sana-ia.com', // Reemplazar con la URL real
  connectTimeout: const Duration(seconds: 30),
  receiveTimeout: const Duration(seconds: 30),
));

// Agregar el token a todas las requests
void setAuthToken(String accessToken) {
  dio.options.headers['Authorization'] = 'Bearer $accessToken';
}
```

### Login

```dart
Future<Map<String, dynamic>> login(String email, String password) async {
  final response = await dio.post('/v1/auth/login', data: {
    'email': email,
    'password': password,
  });

  final data = response.data as Map<String, dynamic>;
  setAuthToken(data['access_token'] as String);
  return data;
}
```

### Subir imagen de laboratorio

```dart
import 'dart:io';
import 'package:dio/dio.dart';

/// Sube una imagen de laboratorio y retorna el jobId para hacer polling.
/// [imageFile] puede ser una foto de cámara o un PDF seleccionado del dispositivo.
/// [consultationId] es opcional: asocia el resultado a una consulta existente.
Future<String> submitLabImage(
  File imageFile, {
  int? consultationId,
}) async {
  final formData = FormData.fromMap({
    'image': await MultipartFile.fromFile(
      imageFile.path,
      filename: imageFile.uri.pathSegments.last,
    ),
    if (consultationId != null)
      'consultationId': consultationId.toString(),
  });

  final response = await dio.post(
    '/v1/ocr/analyze',
    data: formData,
    options: Options(
      contentType: 'multipart/form-data',
      // El archivo puede ser grande; dar tiempo suficiente
      sendTimeout: const Duration(seconds: 60),
    ),
  );

  // response.statusCode == 202
  final data = response.data as Map<String, dynamic>;
  return data['jobId'] as String;
}
```

### Consultar estado del job (polling)

```dart
import 'dart:async';

enum OcrStatus { queued, processing, completed, failed }

class OcrJobResult {
  final OcrStatus status;
  final Map<String, dynamic>? extractedData;
  final String? errorMessage;
  final int? processingTimeMs;

  const OcrJobResult({
    required this.status,
    this.extractedData,
    this.errorMessage,
    this.processingTimeMs,
  });
}

Future<OcrJobResult> getJobStatus(String jobId) async {
  final response = await dio.get('/v1/ocr/jobs/$jobId');
  final data = response.data as Map<String, dynamic>;

  final statusStr = data['status'] as String;
  final status = OcrStatus.values.firstWhere(
    (s) => s.name == statusStr,
    orElse: () => OcrStatus.queued,
  );

  return OcrJobResult(
    status: status,
    extractedData: data['extractedData'] as Map<String, dynamic>?,
    errorMessage: data['errorMessage'] as String?,
    processingTimeMs: data['processingTimeMs'] as int?,
  );
}

/// Hace polling automático hasta completar o timeout.
/// Lanza [TimeoutException] si supera [maxWaitDuration].
Future<OcrJobResult> pollUntilDone(
  String jobId, {
  Duration interval = const Duration(seconds: 4),
  Duration maxWaitDuration = const Duration(minutes: 3),
}) async {
  final deadline = DateTime.now().add(maxWaitDuration);

  while (DateTime.now().isBefore(deadline)) {
    final result = await getJobStatus(jobId);

    if (result.status == OcrStatus.completed ||
        result.status == OcrStatus.failed) {
      return result;
    }

    await Future.delayed(interval);
  }

  throw TimeoutException(
    'OCR job did not complete within ${maxWaitDuration.inMinutes} minutes.',
    maxWaitDuration,
  );
}
```

### Flujo completo de uso

```dart
Future<void> processLabImage(File imageFile) async {
  try {
    // 1. Subir imagen → recibir jobId
    final jobId = await submitLabImage(imageFile, consultationId: 123);
    print('Job encolado: $jobId');

    // Mostrar indicador de progreso al usuario
    showLoadingIndicator('Analizando laboratorio...');

    // 2. Pollear hasta completar
    final result = await pollUntilDone(jobId);

    hideLoadingIndicator();

    if (result.status == OcrStatus.completed) {
      final biomarkers =
          result.extractedData?['biomarkers'] as List<dynamic>? ?? [];
      print('Biomarcadores detectados: ${biomarkers.length}');
      displayBiomarkers(biomarkers);
    } else {
      showError(result.errorMessage ?? 'Error procesando el laboratorio.');
    }
  } on TimeoutException {
    hideLoadingIndicator();
    showError('El análisis tardó demasiado. Por favor, intentá de nuevo.');
  } on DioException catch (e) {
    hideLoadingIndicator();
    handleHttpError(e);
  }
}
```

---

## 8. Manejo de errores HTTP

| Código | Cuándo ocurre | Qué mostrar al usuario |
|--------|--------------|------------------------|
| `202` | Imagen recibida y encolada | Indicador de progreso — no es error |
| `400` | Archivo con tipo MIME no permitido, o archivo demasiado grande (> 10 MB), o campo inválido | "El archivo no es válido. Verificá que sea JPEG, PNG, WebP o PDF y que no supere 10 MB." |
| `401` | Token expirado o ausente | Redirigir a pantalla de login |
| `404` | `jobId` no existe o no pertenece al usuario autenticado | "No se encontró el resultado. Verificá que el análisis haya sido iniciado correctamente." |
| `413` | Payload demasiado grande (a nivel de infraestructura, antes de llegar al handler) | "El archivo es demasiado grande." |
| `500` | Error interno del servidor | "Ocurrió un error en el servidor. El equipo fue notificado. Intentá de nuevo en unos minutos." |

### Manejo de errores con Dio

```dart
void handleHttpError(DioException e) {
  switch (e.response?.statusCode) {
    case 400:
      showError(
        'Archivo no válido. Debe ser JPEG, PNG, WebP o PDF, máximo 10 MB.',
      );
    case 401:
      navigateTo('/login');
    case 404:
      showError('No se encontró el análisis.');
    default:
      showError('Error inesperado. Por favor, intentá de nuevo.');
  }
}
```

---

## 9. Consideraciones de seguridad

- Los **datos de laboratorio son PHI** (información de salud protegida). Nunca almacenarlos en `SharedPreferences` o logs del dispositivo.
- El servidor elimina la imagen del disco después de procesarla (éxito o fallo) — el archivo no queda persistido más allá del procesamiento.
- Los detalles del error interno **no se exponen** al front. El campo `errorMessage` en respuestas `failed` es siempre un mensaje genérico sanitizado.
- El endpoint de polling valida que el `jobId` pertenezca al usuario autenticado — no es posible consultar jobs de otros usuarios.
