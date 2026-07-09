# Detección de Emergencia y Bloqueo del Chat — Guía de Integración para Flutter

**Versión:** 1.0
**Fecha:** 2026-07-09
**Rama backend:** `main` (pendiente de merge — avisar cuando esté deployado)
**Estado:** ✅ Implementado + testeado (unit + HTTP end-to-end). Contrato estable.

---

## 1. Resumen de la funcionalidad

SANA puede detectar, durante la conversación o al analizar un examen de laboratorio, señales de una **emergencia médica real** (ej. dolor torácico irradiado + dificultad respiratoria, señales de ACV, biomarcadores en rango crítico). Cuando esto pasa:

1. El backend **reemplaza cualquier texto que la IA haya generado** por un mensaje fijo y aprobado (nunca generado por el LLM — el wording de seguridad no es negociable).
2. La consulta queda **bloqueada permanentemente**: no vuelve a aceptar mensajes nuevos.
3. Esto puede pasar en **cualquier momento** de la conversación (turno 1, 2, 3...) — no espera a que termine la entrevista clínica normal.

### Qué implementa Flutter

| Pieza | ¿La implementa Flutter? |
|-------|--------------------------|
| Leer `isEmergency` en cada respuesta del chat | **Sí — obligatorio** |
| Ocultar el input de texto / deshabilitar el envío cuando `isEmergency: true` | **Sí** |
| Mostrar el mensaje de emergencia con una UI distinta (no como un mensaje de chat más) | **Sí, recomendado** |
| Redirigir a esa misma UI de bloqueo si el usuario reabre una conversación ya bloqueada | **Sí** |
| Decidir el texto del mensaje de emergencia | No — es fijo, lo define el backend, no se debe editar ni truncar en la UI |

---

## 2. El campo `isEmergency` — la única señal válida

**Ruta:** `POST /v1/ai/chat` (sin cambios en el request) — respuesta con un campo nuevo:

```json
{
  "conversationId": 83,
  "message": "SANA ha detectado valores en los datos ingresados que representan un riesgo crítico y urgente para su salud. Por su seguridad, el análisis automatizado de historial ha sido suspendido.\n\nPor favor, siga estas instrucciones de inmediato:\n\nNo espere: Diríjase de forma inmediata a la sala de emergencias del hospital o clínica más cercana.\n\nComuníquese ya: Contacte a su servicio de ambulancias local o a un familiar cercano que pueda asistirlo en su traslado.\n\nMuestre sus exámenes: Al llegar al centro médico, entregue de inmediato el documento original de laboratorio que intentaba cargar en la aplicación al personal de guardia.\n\nNota de seguridad: SANA es un sistema de orientación preventiva y no puede tratar ni diagnosticar emergencias médicas. Su vida es lo primero, busque ayuda profesional ahora mismo.",
  "summary": { "text": "..." },
  "status": "completed",
  "extractedData": { "symptoms": null, "treatment": null, "duration": null },
  "diagnosis": null,
  "isEmergency": true
}
```

> **Importante — usar SOLO `isEmergency` para decidir el bloqueo de UI.** NO comparar el texto de `message` contra un string hardcodeado en la app: es frágil (el wording puede ajustarse en el backend sin que la app se entere) y ya existe un campo booleano explícito para esto.

`isEmergency` viene en **todas** las respuestas del endpoint (no solo cuando es `true`), incluidas las respuestas normales de una consulta sin emergencia (`isEmergency: false`) y las respuestas del fallback cuando el servicio de IA está temporalmente caído (preserva el valor previo si ya había una emergencia detectada antes).

---

## 3. Comportamiento esperado, turno a turno

### Turno donde se detecta la emergencia (primera vez)

- `status: "completed"`
- `diagnosis: null` (no hay un reporte RCA compilado — la consulta se cierra directo, sin esperar a juntar todos los datos clínicos)
- `message` = el texto fijo completo
- `isEmergency: true`

### Cualquier mensaje posterior en la MISMA conversación

El usuario puede seguir escribiendo (el input no debería estar deshabilitado del lado del backend — el bloqueo es a nivel de contenido de la respuesta, no del endpoint), pero **cada respuesta será el mismo mensaje fijo, sin excepción**:

- `message` = el mismo texto fijo, verbatim
- `isEmergency: true`
- El backend **no vuelve a consultar al modelo de IA** — la respuesta es instantánea (no hay latencia de LLM en estos turnos).

### Si el usuario reabre esa conversación después (`GET /v1/ai/conversations/:id` o similar)

El historial de mensajes va a mostrar el mensaje de emergencia como si fuera un mensaje más del asistente. **Flutter debe detectar esto al cargar el historial** (ver sección 5) y arrancar la pantalla ya en modo bloqueado, no dejar que el usuario intente seguir chateando.

---

## 4. UX recomendada para el estado de emergencia

No tratar el mensaje de emergencia como un mensaje de chat más (burbuja gris igual a las demás). Sugerido:

- Reemplazar la vista de chat por una pantalla/banner dedicado, con color de alerta (rojo/naranja), ícono de urgencia.
- Mostrar el texto completo de `message` tal cual llega — no resumir, no truncar, no reformatear el contenido clínico/instruccional.
- Ocultar o deshabilitar permanentemente el campo de texto de esa conversación. El usuario puede iniciar una consulta **nueva** (sin `conversationId`) si necesita seguir usando SANA para otro motivo — esa consulta nueva no hereda el bloqueo.
- Considerar un botón directo de "Llamar a emergencias" / marcar el número local, si el alcance del producto lo permite (no implementado en backend, es una mejora de UX pura del lado app).

---

## 5. Detectar el bloqueo al cargar el historial (no solo en tiempo real)

Si el usuario cierra la app y vuelve a una conversación ya bloqueada, Flutter necesita saber esto **sin mandar un mensaje nuevo primero**. `GET /v1/ai/conversations/:id` devuelve la consulta completa (incluida su lista de `messages`), y el campo de bloqueo **sí está presente ahí** — pero con un nombre distinto al de `POST /v1/ai/chat`:

```json
{
  "id": 83,
  "status": "completed",
  "emergencyDetected": true,
  "askedTopics": [],
  "messages": [ ... ],
  "...": "..."
}
```

> **Ojo con la inconsistencia de nombres:** el endpoint de chat usa `isEmergency`, el de historial usa `emergencyDetected` (porque este último devuelve la entidad de base de datos tal cual, sin pasar por un DTO). Mismo significado, mismo tipo (`boolean`), distinto nombre de campo según el endpoint. Si esto genera fricción del lado Flutter, avisar y se puede normalizar a un único nombre en el backend.

---

## 6. Este bloqueo aplica a DOS orígenes distintos (mismo comportamiento)

| Origen | Cómo se detecta | Qué ve Flutter |
|--------|------------------|-----------------|
| Conversación de chat | El modelo detecta señales de alta gravedad en el texto del paciente (dolor torácico, ACV, etc.) | `isEmergency: true` en la respuesta de `POST /v1/ai/chat` de ESE turno |
| Examen de laboratorio (OCR) | Un biomarcador extraído viene marcado como `"critico"` | La app NO se entera en el momento de subir la imagen (el OCR es asíncrono) — el mensaje de emergencia aparece como un mensaje nuevo del asistente en esa conversación. Si el usuario está con el chat abierto en ese momento, conviene hacer polling o refrescar el historial tras completarse un OCR para no perderse este caso. |

El texto del mensaje fijo es el mismo en ambos casos.

---

## 7. Resumen de implementación (backend)

| Pieza | Estado |
|-------|--------|
| Mensaje fijo, nunca generado por el LLM | ✅ Implementado |
| Campo `isEmergency` en `POST /v1/ai/chat` (todas las respuestas) | ✅ Implementado + tests |
| Bloqueo de la consulta (no vuelve a llamar al LLM en turnos posteriores) | ✅ Implementado + tests |
| Detección desde biomarcador crítico de OCR | ✅ Implementado |
| Verificación end-to-end (HTTP real, 4 escenarios dedicados) | ✅ Validado — incluye control negativo (síntoma fuerte sin señales de alarma reales, confirmado que NO dispara falso positivo) |
| Señal de bloqueo en `GET /v1/ai/conversations/:id` | ✅ Presente como `emergencyDetected` (nombre distinto a `isEmergency` del endpoint de chat — ver sección 5) |

**Contrato estable en ambos endpoints.**
