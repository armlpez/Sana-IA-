# Eliminar Conversaciones (borrado múltiple) — Guía de Integración para Flutter

**Versión:** 1.0
**Fecha:** 2026-07-14
**Rama backend:** `main` (commit `257dd73`, ya desplegado en la EC2 de dev)
**Estado:** ✅ Implementado + testeado (unit + adversarial HTTP end-to-end). Contrato estable.

---

## 1. Resumen de la funcionalidad

Un endpoint para que el usuario borre **una o varias conversaciones de una sola vez** desde la app (por ejemplo, selección múltiple en la pantalla de historial con checkboxes + botón "Eliminar").

### Características clave

- **Borrado físico, no reversible.** No hay papelera ni forma de recuperar una conversación borrada. Al borrar una conversación se borran también, en cascada:
  - Todos sus mensajes de chat.
  - Su diagnóstico (si lo tenía).
  - Sus resultados de laboratorio (OCR) asociados a esa conversación, **incluida la imagen del examen** subida.
- **Batch, no una request por id.** Se manda un array de ids en un solo request — no hace falta loopear del lado de Flutter.
- **Nunca borra conversaciones de otro usuario**, ni siquiera si el id se manda por error o a propósito — ver sección 4.

```
Flutter                        Backend
  │                              │
  │── DELETE .../conversations ─►│  valida ownership de cada id
  │      { ids: [1, 2, 3] }      │  borra en cascada (mensajes, diagnóstico, labs)
  │◄──── 200 + resultado ────────│  { deletedIds, notFoundIds }
```

---

## 2. Autenticación

Igual que el resto de los endpoints de `/v1/ai/*`: requiere **JWT Bearer token**.

```
Authorization: Bearer <access_token>
```

Sin token válido → `401` (ver sección 5).

---

## 3. Endpoint

**Método:** `DELETE`
**Ruta:** `/v1/ai/conversations`
**Auth:** Bearer token (obligatorio)

### Body (JSON)

```json
{ "ids": [12, 45, 78] }
```

| Campo | Tipo | Reglas |
|---|---|---|
| `ids` | `number[]` (enteros) | Obligatorio, no vacío, **máximo 50 ids por request**, cada valor entre 1 y 2147483647 |

Si necesitás borrar más de 50 conversaciones, hacer varios requests en lotes de 50.

### Respuesta exitosa (200 OK)

```json
{
  "deletedIds": [12, 45],
  "notFoundIds": [78]
}
```

| Campo | Significado |
|---|---|
| `deletedIds` | Los ids que efectivamente se borraron (eran del usuario autenticado). |
| `notFoundIds` | Los ids que **no** se borraron — ver sección 4 para qué puede significar cada caso. |

> El endpoint siempre responde `200`, incluso si ningún id se pudo borrar (`deletedIds: []`). No hay `404` a nivel de request completa — cada id se resuelve individualmente dentro del array de resultado.

---

## 4. `notFoundIds` — un solo bucket para dos casos distintos (a propósito)

Un id puede terminar en `notFoundIds` por dos motivos, y el backend **intencionalmente no distingue cuál fue**:

1. La conversación no existe (id inválido, ya estaba borrada, typo).
2. La conversación existe pero **es de otro usuario**.

Esto es una decisión de seguridad deliberada (anti-enumeración): si el backend respondiera distinto en cada caso, alguien podría usar el endpoint para "adivinar" qué ids de conversación existen en el sistema aunque no sean suyas. Para Flutter esto significa:

- **No mostrar mensajes distintos** según por qué un id cayó en `notFoundIds` — el backend no te da esa información y no hay forma de obtenerla desde este endpoint.
- Un mensaje genérico alcanza: *"No se pudieron eliminar N conversaciones (ya no existían o no tenías acceso)."*
- Si el usuario solo ve/selecciona conversaciones que la propia app le mostró en su historial (`GET /v1/ai/conversations`), en la práctica `notFoundIds` solo debería aparecer si la conversación fue borrada por otra sesión/dispositivo entre que se cargó la lista y se tocó "eliminar" — un caso de sincronización, no un error del usuario.

---

## 5. Manejo de errores

```json
{
  "statusCode": 400,
  "message": "...",
  "errorCode": "ERR_...",
  "timestamp": "2026-07-14T21:00:00.000Z",
  "requestId": "..."
}
```

| HTTP | Cuándo ocurre | Qué mostrar al usuario |
|---|---|---|
| **200** | Siempre que el request es válido — ver `deletedIds`/`notFoundIds` para el detalle | Refrescar la lista de conversaciones quitando los `deletedIds` |
| **400** | `ids` vacío, ausente, con más de 50 elementos, con valores no enteros, o fuera de rango | "No se pudo procesar la solicitud." (no debería pasar si la UI arma bien el array — validar del lado Flutter también, ver sección 6) |
| **401** | Token ausente, inválido o expirado | Renovar token (`/v1/auth/refresh`) o re-login |
| **429** | Demasiadas solicitudes (rate limit) | "Esperá un momento e intentá de nuevo." |
| **500** | Error inesperado | "No pudimos completar la eliminación. Intentá más tarde." |

> No hay `403` ni `404` individual — todo eso queda absorbido en `notFoundIds` dentro de una respuesta `200` (ver sección 4).

---

## 6. Ejemplo de implementación (Dart / Dio)

```dart
import 'package:dio/dio.dart';

class ConversationDeleteResult {
  final List<int> deletedIds;
  final List<int> notFoundIds;
  ConversationDeleteResult(this.deletedIds, this.notFoundIds);
}

class ConversationsService {
  final Dio _dio;
  final String baseUrl;

  ConversationsService(this._dio, this.baseUrl);

  /// Borra una o varias conversaciones. Máximo 50 ids por llamada —
  /// si hay más, loopear en lotes de 50 del lado de la app.
  Future<ConversationDeleteResult> deleteConversations({
    required List<int> ids,
    required String accessToken,
  }) async {
    assert(ids.isNotEmpty && ids.length <= 50);

    final response = await _dio.delete(
      '$baseUrl/v1/ai/conversations',
      data: {'ids': ids},
      options: Options(headers: {'Authorization': 'Bearer $accessToken'}),
    );

    final data = response.data as Map<String, dynamic>;
    return ConversationDeleteResult(
      List<int>.from(data['deletedIds'] as List),
      List<int>.from(data['notFoundIds'] as List),
    );
  }
}
```

### Uso con selección múltiple

```dart
Future<void> onDeleteSelectedPressed(List<int> selectedIds) async {
  final confirmed = await showDeleteConfirmationDialog(count: selectedIds.length);
  if (!confirmed) return;

  final result = await conversationsService.deleteConversations(
    ids: selectedIds,
    accessToken: currentAccessToken,
  );

  setState(() {
    conversations.removeWhere((c) => result.deletedIds.contains(c.id));
  });

  if (result.notFoundIds.isNotEmpty) {
    showSnackBar('No se pudieron eliminar ${result.notFoundIds.length} conversación(es).');
  }
}
```

---

## 7. Flujo recomendado en la UI

1. Habilitar selección múltiple en la pantalla de historial de conversaciones (long-press o modo edición con checkboxes).
2. Botón "Eliminar" visible solo con al menos 1 seleccionada.
3. **Confirmar siempre antes de llamar al endpoint** — es un borrado físico e irreversible, y se lleva puestos los exámenes de laboratorio adjuntos a esas conversaciones. Sugerido: diálogo tipo *"¿Eliminar N conversación(es)? Esta acción no se puede deshacer y también elimina los exámenes de laboratorio adjuntos."*
4. Al confirmar, llamar a `deleteConversations(ids, accessToken)`.
5. Quitar de la lista local los `deletedIds` (no hace falta recargar todo el historial desde el server).
6. Si `notFoundIds` no está vacío, avisar con el mensaje genérico de la sección 4 y, si la app cachea conversaciones localmente, quitarlas también de ahí (probablemente fueron borradas desde otra sesión).

> Si el usuario solo tiene 1 conversación seleccionada, el mismo endpoint sirve (`ids: [unicoId]`) — no hace falta un endpoint separado para borrado individual.

---

## 8. Resumen rápido para el dev

| Item | Valor |
|---|---|
| Endpoint | `DELETE /v1/ai/conversations` |
| Auth | `Authorization: Bearer <access_token>` |
| Body | `{ "ids": number[] }` — 1 a 50 ids, enteros positivos |
| Respuesta OK | `200` + `{ deletedIds: number[], notFoundIds: number[] }` (siempre 200 si el request es válido) |
| Errores | `400` (payload inválido), `401` (auth), `429` (rate limit) |
| `notFoundIds` | Id ajeno o inexistente — mismo bucket a propósito, no distinguir en la UI |
| Persistencia | Borrado físico e irreversible — cascada a mensajes, diagnóstico y resultados de laboratorio (incluida la imagen) |
| Límite por request | 50 ids — loopear en lotes si hay más |
| UX obligatoria | Confirmación antes de borrar (no hay deshacer) |
