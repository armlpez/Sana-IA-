/**
 * Safely embeds a raw string value as a JS string literal inside an inline
 * `<script>` block. Tokens are hex from `crypto.randomBytes` in practice, but
 * we encode defensively so the helper is safe regardless of the input:
 * `JSON.stringify` handles quote/backslash escaping, and replacing `<`/`>`
 * with unicode escapes neutralizes a `</script>` breakout attempt.
 */
export function escapeForInlineScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}
