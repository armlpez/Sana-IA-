# Verificación de Cuenta y Recuperación de Contraseña — Guía de Integración para Flutter

**Versión:** 1.0
**Fecha:** 2026-07-08
**Rama backend:** `main` (merged)
**IP del backend:** `http://52.204.103.99:3000` (EC2 prod)
**Estado:** ✅ Feature completo — todas las capacidades implementadas, testeadas (237 tests verdes), migración aplicada, y deployado en producción. Los endpoints y landing pages están listos para consumir desde Flutter.

---

## 1. Resumen de la funcionalidad

Se agregan dos capacidades de seguridad que hoy no existen:

1. **Verificación de email obligatoria**: un usuario recién registrado NO puede iniciar sesión hasta hacer click en el link de verificación que recibe por correo.
2. **Recuperación de contraseña**: flujo "olvidé mi contraseña" por email, con tokens de un solo uso y expiración corta.

Ambas usan el mismo mecanismo: el backend envía un correo con un link que contiene un token de un solo uso. Los links abren **páginas web servidas por el propio backend** (el usuario las ve en el navegador del teléfono), por lo que Flutter NO necesita implementar las pantallas de "verificar" ni "escribir contraseña nueva" — solo las pantallas que **inician** cada flujo y el manejo de los errores nuevos en login.

### Los 4 flujos, en pareja

```
RECUPERACIÓN DE CONTRASEÑA          VERIFICACIÓN DE CUENTA
──────────────────────────          ──────────────────────
1. forgot-password                  3. verify-email
   (la app PIDE el link)               (el link del correo COMPLETA
                                        la verificación — vía navegador)
2. reset-password
   (el link del correo CAMBIA       4. resend-verification
    la contraseña — vía navegador)     (la app PIDE un link nuevo
                                        si venció o no llegó)
```

### Qué implementa Flutter y qué no

| Pieza | ¿La implementa Flutter? |
|-------|------------------------|
| Pantalla "Olvidé mi contraseña" (pide email) → llama endpoint 1 | **Sí** |
| Página donde se escribe la contraseña nueva | No — la sirve el backend en el navegador |
| Manejo del error 403 "cuenta no verificada" en login | **Sí** |
| Botón "Reenviar correo de verificación" → llama endpoint 4 | **Sí** |
| Página de confirmación "cuenta verificada" | No — la sirve el backend en el navegador |
| Aviso "revisa tu correo" tras el registro | **Sí** (cambio de UX en registro) |

---

## 2. Cambio en Login (endpoint existente)

**Ruta:** `POST /v1/auth/login` — sin cambios en el request.

**Caso nuevo a manejar:** si la contraseña es CORRECTA pero la cuenta no está verificada, el login falla con `403`:

```json
{
  "statusCode": 403,
  "errorCode": "ERR_AUTH_007",
  "message": "Tu cuenta aún no ha sido verificada. Revisa tu correo o solicita un nuevo enlace de verificación."
}
```

**UX recomendada:** ante `ERR_AUTH_007`, mostrar el mensaje y un botón **"Reenviar correo de verificación"** que llame al endpoint 4 con el mismo email que el usuario acaba de escribir.

> Nota de seguridad: este error solo aparece con contraseña correcta. Con contraseña incorrecta la respuesta es la misma de siempre (401), sin revelar si la cuenta está verificada o no.

**Usuarios existentes:** todos los usuarios registrados ANTES del deploy de esta feature quedan marcados como verificados automáticamente (la migración los cubre). Nadie pierde acceso.

---

## 3. Cambio en Registro (endpoint existente)

**Ruta:** `POST /v1/users` — sin cambios en el request ni en la respuesta.

**Comportamiento nuevo:** al registrarse, el backend envía automáticamente el correo de verificación. La cuenta se crea igual aunque el envío falle (el usuario puede pedir reenvío después).

**UX recomendada:** tras registro exitoso, en vez de ir al login directo, mostrar pantalla "Te enviamos un correo a **{email}**. Haz click en el enlace para activar tu cuenta." con botón de reenvío (endpoint 4).

---

## 4. Endpoint 1 — Olvidé mi contraseña

| Campo | Valor |
|-------|-------|
| **Método** | `POST` |
| **Ruta** | `/v1/auth/forgot-password` |
| **Content-Type** | `application/json` |
| **Auth requerida** | No |

**Body:**

```json
{ "email": "usuario@ejemplo.com" }
```

**Respuesta (200 OK) — SIEMPRE la misma, exista o no la cuenta:**

```json
{ "message": "Si el correo existe, enviaremos instrucciones." }
```

> **Importante para la UI:** la respuesta es idéntica para emails registrados y no registrados (protección anti-enumeración). NO mostrar "email no encontrado" — mostrar siempre "revisa tu bandeja de entrada".

El link recibido expira en **30 minutos** y sirve **una sola vez**. Pedir un link nuevo invalida los anteriores.

---

## 5. Endpoint 2 — Resetear contraseña

| Campo | Valor |
|-------|-------|
| **Método** | `POST` |
| **Ruta** | `/v1/auth/reset-password` |
| **Auth requerida** | No |

**Flutter normalmente NO llama este endpoint** — lo consume la página web que abre el link del correo (`GET /v1/auth/reset?token=...`). Se documenta por si más adelante se implementa deep-linking hacia la app.

**Body:**

```json
{ "token": "<token del link>", "newPassword": "nuevaContraseña123" }
```

**Efectos al completarse:**
- La contraseña cambia.
- **Todas las sesiones activas se cierran** (todos los refresh tokens se revocan). La app debe manejar que el próximo refresh falle → redirigir a login.
- Si la cuenta no estaba verificada, queda verificada (el click en el link prueba que el correo es suyo).

**Errores:**

| HTTP | errorCode | Significado |
|------|-----------|-------------|
| 400 | `ERR_AUTH_008` | Link inválido o ya utilizado |
| 400 | `ERR_AUTH_009` | Link expirado (>30 min) — pedir uno nuevo |

---

## 6. Endpoint 3 — Verificar email

| Campo | Valor |
|-------|-------|
| **Método** | `POST` |
| **Ruta** | `/v1/auth/verify-email` |
| **Auth requerida** | No |

Igual que el anterior: **lo consume la página web del link** (`GET /v1/auth/verify?token=...`), no la app. El link expira en **24 horas**.

**Body:**

```json
{ "token": "<token del link>" }
```

**Errores:**

| HTTP | errorCode | Significado |
|------|-----------|-------------|
| 400 | `ERR_AUTH_010` | Link inválido o ya utilizado |
| 400 | `ERR_AUTH_011` | Link expirado (>24 h) — pedir reenvío |

---

## 7. Endpoint 4 — Reenviar verificación

| Campo | Valor |
|-------|-------|
| **Método** | `POST` |
| **Ruta** | `/v1/auth/resend-verification` |
| **Auth requerida** | No |

**Body:**

```json
{ "email": "usuario@ejemplo.com" }
```

**Respuesta (200 OK) — SIEMPRE la misma** (exista o no la cuenta, esté o no ya verificada):

```json
{ "message": "Si el correo existe y requiere verificación, enviaremos un nuevo enlace." }
```

El link nuevo invalida cualquier link de verificación anterior.

---

## 8. Cambio de email desde el perfil

**Ruta:** `PATCH /v1/auth/profile` (existente, con Bearer token) — comportamiento nuevo cuando el body incluye un `email` distinto al actual:

- El email actual **NO cambia todavía**. El nuevo queda "pendiente".
- Se envía un correo de verificación **a la dirección nueva**.
- El usuario sigue logueado y su email actual sigue funcionando.
- Cuando hace click en el link (verify-email), recién ahí el email se reemplaza.

**UX recomendada:** tras editar el email, mostrar "Te enviamos un enlace a **{nuevoEmail}**. Tu correo actual sigue activo hasta que lo confirmes."

Si otra cuenta registra ese email antes de que el usuario confirme, el link falla con `409` y debe reiniciar el cambio.

---

## 9. Límites de uso (rate limiting)

| Endpoints | Límite |
|-----------|--------|
| forgot-password, reset-password, verify-email, resend-verification | **5 requests cada 15 min por IP** |
| Registro (`POST /v1/users`) | **10 por hora por IP** |

Al exceder: `429 Too Many Requests`. La UI debe deshabilitar el botón de reenvío unos segundos tras cada intento y mostrar un mensaje amable ante el 429.

---

## 10. Resumen de códigos de error nuevos

| errorCode | HTTP | Cuándo | Mensaje al usuario |
|-----------|------|--------|--------------------|
| `ERR_AUTH_007` | 403 | Login con cuenta sin verificar | "Tu cuenta aún no ha sido verificada..." |
| `ERR_AUTH_008` | 400 | Token de reset inválido/usado | "El enlace de restablecimiento no es válido o ya fue utilizado." |
| `ERR_AUTH_009` | 400 | Token de reset expirado | "El enlace de restablecimiento ha expirado. Solicita uno nuevo." |
| `ERR_AUTH_010` | 400 | Token de verificación inválido/usado | "El enlace de verificación no es válido o ya fue utilizado." |
| `ERR_AUTH_011` | 400 | Token de verificación expirado | "El enlace de verificación ha expirado. Solicita uno nuevo." |

Los mensajes llegan listos en español en el campo `message` — la app puede mostrarlos directamente.

---

## 11. Estado de implementación (backend)

| Pieza | Estado |
|-------|--------|
| Tokens de un solo uso (SHA-256, TTL 30min/24h) | ✅ Implementado + tests |
| Envío de email asíncrono (cola + reintentos, Gmail SMTP) | ✅ Implementado + tests + produção |
| Migración de DB (usuarios existentes quedan verificados) | ✅ Ejecutada en RDS |
| Registro envía verificación / cambio de email pendiente | ✅ Implementado + tests |
| Gate de login + 4 flujos (lógica) | ✅ Implementado + tests adversariales |
| Endpoints HTTP + páginas web con branding QuvixSoft | ✅ Implementado + tests |
| Verificación end-to-end del flujo completo | ✅ Validado en produção |

**Todos los endpoints están LISTOS para consumir desde Flutter.** Los contratos (rutas, bodies, códigos de error) están estables y no deberían cambiar. IP: `http://52.204.103.99:3000`
