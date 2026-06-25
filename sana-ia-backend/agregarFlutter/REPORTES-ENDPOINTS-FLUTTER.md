# Reportes PDF de Consulta — Guía de Integración para Flutter

**Versión:** 1.0
**Fecha:** 2026-06-24
**Rama backend:** `main`

---

## 1. Resumen de la funcionalidad

Una vez que una consulta llega a su conclusión (estado `completed` con diagnóstico generado), el usuario puede **descargar un informe clínico en PDF** de esa consulta. El informe está pensado para que el paciente lo lleve a su médico: incluye los datos del paciente, los síntomas reportados, el análisis de causa raíz (ACR / 5 Porqués), el especialista sugerido y la tabla de biomarcadores de laboratorio.

### Características clave

- **Generación dinámica y en memoria.** El PDF se construye en el momento de cada request a partir de los datos de la base (consulta + diagnóstico + biomarcadores) y se envía directo. **No se guarda en el servidor** (ni disco, ni nube). Si los datos cambian, el próximo PDF lo refleja.
- **Síncrono.** A diferencia del OCR (que es asíncrono con polling), el reporte se devuelve **directo en la respuesta**. No hay `jobId` ni polling: pedís el PDF y lo recibís.
- **Por consulta.** Cada PDF corresponde a UNA consulta específica (la `conversationId` / `id` de consulta). Nunca mezcla datos de otras conversaciones del usuario.

```
Flutter                 Backend
  │                       │
  │── GET .../report ────►│  lee consulta + diagnóstico + biomarkers (DB)
  │                       │  arma el PDF en memoria (pdfmake)
  │◄──── 200 + PDF ───────│  devuelve los bytes (application/pdf)
  │   (guardar / abrir)   │  (no persiste nada)
```

---

## 2. Autenticación

Igual que en OCR: todos los endpoints requieren un **JWT Bearer token** obtenido del login.

**Login:** `POST /v1/auth/login` con `{ email, password }` → devuelve `{ access_token, refresh_token, user }`.
(Ver detalle completo en `OCR-ENDPOINTS-FLUTTER.md` sección 2.)

Header requerido en el endpoint de reporte:

```
Authorization: Bearer <access_token>
```

---

## 3. Endpoint — Descargar el reporte PDF

**Método:** `GET`
**Ruta:** `/v1/consultations/:id/report`
**`:id`** = el id de la consulta (el mismo `conversationId` que devuelve el chat).
**Auth:** Bearer token (obligatorio)

### Precondiciones

Para que el reporte se genere, la consulta debe:

1. **Existir** y **pertenecer al usuario** autenticado (no se puede descargar el reporte de otro paciente).
2. Estar en estado **`completed`** (la conversación llegó a un diagnóstico final).

Si no se cumplen, el endpoint devuelve un error (ver sección 5).

### Respuesta exitosa (200 OK)

El cuerpo de la respuesta es el **binario del PDF** (no es JSON). Los headers relevantes:

| Header | Valor | Uso en el front |
|---|---|---|
| `Content-Type` | `application/pdf` | Confirmar que es un PDF |
| `Content-Disposition` | `attachment; filename="consulta-<id>-<fecha>.pdf"` | Nombre sugerido del archivo |
| `Content-Length` | tamaño en bytes | (opcional) progreso de descarga |

> ⚠️ Importante: la respuesta NO es JSON. En Flutter hay que pedir los **bytes** (`ResponseType.bytes` en Dio), no intentar parsear como texto/JSON.

---

## 4. Contenido del PDF

El informe incluye (en español):

- **Encabezado**: título "Informe de Consulta Clínica", subtítulo Sana-IA y fecha de generación.
- **Banner de emergencia** (solo si la consulta detectó emergencia): franja roja "EMERGENCIA DETECTADA".
- **Datos del paciente**: nombre, email, edad, id de consulta, fecha.
- **Síntomas reportados**: síntomas, tratamiento actual, duración.
- **Análisis de causa raíz (ACR)**: hipótesis de causa raíz, especialista sugerido, nivel de confianza.
- **Trazado de los 5 Porqués**: el razonamiento paso a paso.
- **Biomarcadores de laboratorio**: tabla con `Biomarcador | Valor | Unidad | Rango ref. | Estado`. Si la consulta no tiene labs adjuntos (vía OCR), muestra "No hay resultados de laboratorio adjuntos".
- **Disclaimer legal** + pie de página con paginación.

> Los biomarcadores que aparecen en el reporte son los de las imágenes de laboratorio que se subieron **a esa misma consulta** mediante el flujo de OCR (ver `OCR-ENDPOINTS-FLUTTER.md`). Para que el reporte los incluya, al subir la imagen hay que mandar el `consultationId` correspondiente.

---

## 5. Manejo de errores

El cuerpo de error SÍ es JSON (formato estándar del backend):

```json
{
  "statusCode": 400,
  "message": "...",
  "errorCode": "ERR_...",
  "timestamp": "2026-06-24T21:00:00.000Z",
  "requestId": "..."
}
```

| HTTP | Cuándo ocurre | Qué mostrar al usuario |
|---|---|---|
| **200** | OK — cuerpo = bytes del PDF | Abrir / guardar / compartir el PDF |
| **400** | La consulta no está `completed` aún, o no tiene diagnóstico | "El informe estará disponible cuando termines la consulta." |
| **401** | Token ausente, inválido o expirado | Renovar token (`/v1/auth/refresh`) o re-login |
| **403** | La consulta no pertenece al usuario | "No tenés acceso a este informe." |
| **404** | La consulta no existe | "Consulta no encontrada." |
| **429** | Demasiadas solicitudes (rate limit) | "Esperá un momento e intentá de nuevo." |
| **500** | Error inesperado al generar | "No pudimos generar el informe. Intentá más tarde." |

> En 400/401/403/404 el cuerpo es JSON. En 200 el cuerpo es binario. Conviene chequear el `statusCode` antes de tratar el cuerpo como PDF.

---

## 6. Ejemplo de implementación (Dart / Dio)

### Dependencias sugeridas

```yaml
dependencies:
  dio: ^5.x
  path_provider: ^2.x   # carpeta temporal/documentos
  open_filex: ^4.x      # abrir el PDF (o usar share_plus para compartir)
```

### Descargar y abrir el PDF

```dart
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:open_filex/open_filex.dart';

class ReportService {
  final Dio _dio;
  final String baseUrl;

  ReportService(this._dio, this.baseUrl);

  /// Descarga el informe PDF de una consulta completada y lo abre.
  Future<void> downloadAndOpenReport({
    required int consultationId,
    required String accessToken,
  }) async {
    try {
      final response = await _dio.get<List<int>>(
        '$baseUrl/v1/consultations/$consultationId/report',
        options: Options(
          responseType: ResponseType.bytes, // <-- clave: bytes, no JSON
          headers: {'Authorization': 'Bearer $accessToken'},
          // No lanzar excepción en 4xx para poder leer el JSON de error:
          validateStatus: (status) => status != null && status < 500,
        ),
      );

      if (response.statusCode == 200) {
        final dir = await getTemporaryDirectory();
        final file = File('${dir.path}/consulta-$consultationId.pdf');
        await file.writeAsBytes(response.data!);
        await OpenFilex.open(file.path); // abre con el visor de PDF del sistema
      } else {
        // En error, el cuerpo viene como bytes → decodificar a JSON
        final errorJson = _decodeError(response.data);
        throw ReportException(response.statusCode!, errorJson);
      }
    } on DioException catch (e) {
      throw ReportException(e.response?.statusCode ?? 0, null);
    }
  }

  Map<String, dynamic>? _decodeError(List<int>? bytes) {
    if (bytes == null) return null;
    try {
      return jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }
}

class ReportException implements Exception {
  final int statusCode;
  final Map<String, dynamic>? body;
  ReportException(this.statusCode, this.body);
}
```

### Compartir en vez de abrir (opcional)

```dart
import 'package:share_plus/share_plus.dart';

await Share.shareXFiles(
  [XFile(file.path, mimeType: 'application/pdf')],
  text: 'Informe de consulta Sana-IA',
);
```

---

## 7. Flujo recomendado en la UI

1. El usuario termina la conversación → el chat devuelve `status: "completed"`.
2. Mostrar un botón **"Descargar informe"** en la pantalla de resumen de la consulta.
3. Al tocarlo, llamar a `downloadAndOpenReport(consultationId, accessToken)`.
4. Mostrar un loader breve (la generación es sub-segundo, pero la descarga depende de la red).
5. En éxito → abrir/compartir el PDF. En error → mostrar el mensaje según la tabla de la sección 5.

> El botón solo tiene sentido cuando la consulta está `completed`. Para consultas en `collecting`/`analyzing`, ocultarlo o deshabilitarlo (de lo contrario el backend responde 400).

---

## 8. Resumen rápido para el dev

| Item | Valor |
|---|---|
| Endpoint | `GET /v1/consultations/:id/report` |
| Auth | `Authorization: Bearer <access_token>` |
| Respuesta OK | `200` + binario PDF (`application/pdf`) |
| Tipo de respuesta en Dio | `ResponseType.bytes` |
| Precondición | consulta `completed` y propiedad del usuario |
| Errores | 400 (incompleta), 401 (auth), 403 (no es dueño), 404 (no existe) |
| Persistencia | ninguna — se genera dinámicamente por request |
| Relación con OCR | los biomarkers vienen de imágenes subidas a la misma consulta (`consultationId`) |
