import { escapeForInlineScript } from './escape-for-inline-script';
import { BRAND_HEAD, BRAND_LOGO } from './brand';

/**
 * Spanish HTML page served at `GET /v1/auth/verify?token=...`, styled with
 * the QuvixSoft brand identity (https://quvixsoft.com/).
 *
 * The frontend is a mobile app with no web routes of its own, so the email
 * verification link opens this backend-served page in the phone browser.
 * On load it POSTs the token to the relative `/v1/auth/verify-email`
 * endpoint (relative so it works on any host) and shows the result. The
 * Google Fonts stylesheet and the hotlinked brand logo are the only
 * external assets; the logo's `alt` text is a graceful fallback so the
 * page stays fully usable if the image fails to load.
 */
export function verifyEmailPage(token: string): string {
  const safeToken = escapeForInlineScript(token);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verificación de cuenta - Sana IA</title>
${BRAND_HEAD}
</head>
<body>
  <div style="width:100%; max-width:420px;">
    ${BRAND_LOGO}
    <div class="card">
      <h1>Verificación de cuenta</h1>
      <div id="content" style="text-align:center;"><p>Verificando tu cuenta...</p></div>
    </div>
  </div>
  <script>
    (function () {
      var token = ${safeToken};
      fetch('/v1/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token })
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          var el = document.getElementById('content');
          if (result.ok) {
            el.innerHTML = '<p class="success">Tu cuenta ha sido verificada. Ya puedes iniciar sesión en la app.</p>';
          } else {
            var msg = (result.data && result.data.message) ? result.data.message : 'Ocurrió un error. Intenta nuevamente.';
            el.innerHTML = '<p class="error">' + msg + '</p>';
          }
        })
        .catch(function () {
          document.getElementById('content').innerHTML = '<p class="error">Ocurrió un error de conexión. Intenta nuevamente.</p>';
        });
    })();
  </script>
</body>
</html>`;
}
