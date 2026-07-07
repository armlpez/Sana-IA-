import { escapeForInlineScript } from './escape-for-inline-script';
import { BRAND_HEAD, BRAND_LOGO } from './brand';

/**
 * Spanish HTML page served at `GET /v1/auth/reset?token=...`, styled with
 * the QuvixSoft brand identity (https://quvixsoft.com/).
 *
 * The frontend is a mobile app with no web routes of its own, so the
 * password-reset link opens this backend-served page in the phone browser.
 * Renders a new-password form (min 8 chars, confirm field with a
 * client-side match check) that POSTs `{ token, newPassword }` to the
 * relative `/v1/auth/reset-password` endpoint. The Google Fonts stylesheet
 * and the hotlinked brand logo are the only external assets; the logo's
 * `alt` text is a graceful fallback so the page stays fully usable if the
 * image fails to load.
 */
export function resetPasswordPage(token: string): string {
  const safeToken = escapeForInlineScript(token);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Restablecer contraseña - Sana IA</title>
${BRAND_HEAD}
</head>
<body>
  <div style="width:100%; max-width:420px;">
    ${BRAND_LOGO}
    <div class="card">
      <h1>Restablecer contraseña</h1>
      <div id="content">
        <form id="reset-form">
          <label for="newPassword">Nueva contraseña</label>
          <input type="password" id="newPassword" name="newPassword" minlength="8" required>
          <label for="confirmPassword">Confirmar contraseña</label>
          <input type="password" id="confirmPassword" name="confirmPassword" minlength="8" required>
          <div id="form-error" class="error" style="display:none;"></div>
          <button type="submit">Actualizar contraseña</button>
        </form>
      </div>
    </div>
  </div>
  <script>
    (function () {
      var token = ${safeToken};
      var form = document.getElementById('reset-form');
      form.addEventListener('submit', function (event) {
        event.preventDefault();

        var newPassword = document.getElementById('newPassword').value;
        var confirmPassword = document.getElementById('confirmPassword').value;
        var errorEl = document.getElementById('form-error');
        errorEl.style.display = 'none';

        if (newPassword.length < 8) {
          errorEl.textContent = 'La contraseña debe tener al menos 8 caracteres.';
          errorEl.style.display = 'block';
          return;
        }

        if (newPassword !== confirmPassword) {
          errorEl.textContent = 'Las contraseñas no coinciden.';
          errorEl.style.display = 'block';
          return;
        }

        fetch('/v1/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token, newPassword: newPassword })
        })
          .then(function (res) {
            return res.json().then(function (data) {
              return { ok: res.ok, data: data };
            });
          })
          .then(function (result) {
            var content = document.getElementById('content');
            if (result.ok) {
              content.innerHTML = '<p class="success">Contraseña actualizada. Inicia sesión en la app con tu nueva contraseña.</p>';
            } else {
              var msg = (result.data && result.data.message) ? result.data.message : 'Ocurrió un error. Intenta nuevamente.';
              errorEl.textContent = msg;
              errorEl.style.display = 'block';
            }
          })
          .catch(function () {
            errorEl.textContent = 'Ocurrió un error de conexión. Intenta nuevamente.';
            errorEl.style.display = 'block';
          });
      });
    })();
  </script>
</body>
</html>`;
}
