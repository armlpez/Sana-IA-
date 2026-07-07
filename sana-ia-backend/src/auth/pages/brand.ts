/**
 * QuvixSoft brand tokens (https://quvixsoft.com/), extracted from their live
 * `variables.css`. Shared between the verify-email and reset-password pages
 * so both stay visually consistent.
 */
export const BRAND_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
  :root {
    --cyan: #00D4FF;
    --cobalt: #0056B3;
    --bg: #FCFCFD;
    --card-bg: rgba(255, 255, 255, 0.75);
    --border-glass: rgba(0, 86, 179, 0.12);
    --text-primary: #1A2C3E;
    --text-secondary: #2C4C6E;
    --gradient: linear-gradient(135deg, var(--cyan), var(--cobalt));
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    padding: 24px;
  }
  .logo { display: block; max-width: 180px; margin: 0 auto 24px; }
  .card {
    background: var(--card-bg);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    border: 1px solid var(--border-glass);
    border-radius: 16px;
    box-shadow: 0 8px 32px rgba(0, 86, 179, 0.12);
    padding: 32px 24px;
    max-width: 420px;
    width: 100%;
  }
  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 16px;
    text-align: center;
  }
  label { display: block; font-size: 0.9rem; color: var(--text-secondary); margin-top: 16px; margin-bottom: 4px; }
  input[type="password"] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border-glass);
    border-radius: 8px;
    font-size: 1rem;
    font-family: inherit;
    background: #ffffff;
    color: var(--text-primary);
  }
  button {
    width: 100%;
    margin-top: 24px;
    padding: 12px;
    background: var(--gradient);
    color: #ffffff;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: filter 0.15s ease, transform 0.15s ease;
  }
  button:hover { filter: brightness(1.08); transform: translateY(-1px); }
  button:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
  .success { color: #0f7a3d; font-weight: 600; text-align: center; }
  .error { color: #c0362c; font-weight: 600; text-align: center; margin-top: 12px; }
</style>`;

export const BRAND_LOGO =
  '<img class="logo" src="https://quvixsoft.com/assets/LOGO_PNG-SIN%20FONDO.png" alt="QuvixSoft" style="max-width:180px">';
