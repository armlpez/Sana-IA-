/**
 * Multimodal prompt utilities — shared between ResilientLlmService (vision-aware
 * chain filtering) and OpenAI-compatible adapters (Gemini Part[] → content conversion).
 *
 * The canonical multimodal prompt format in this codebase is Gemini's Part[]:
 *   [{ text: '...' }, { inlineData: { data: '<base64>', mimeType: 'image/png' } }]
 */

/**
 * Returns true if the prompt contains at least one image part (Gemini inlineData).
 * String prompts and text-only Part[] arrays are NOT multimodal.
 */
export function isMultimodalPrompt(prompt: string | any[]): boolean {
  if (typeof prompt === 'string') return false;
  return prompt.some((p) => p?.inlineData?.data);
}

/**
 * Converts a Gemini Part[] prompt to the OpenAI-compatible vision content array
 * used by Groq (and any other OpenAI-style provider):
 *   { text }                       → { type: 'text', text }
 *   { inlineData: {data, mime} }   → { type: 'image_url', image_url: { url: 'data:mime;base64,data' } }
 *
 * Unknown part shapes are dropped (defensive — should not happen in practice).
 */
export function partsToOpenAiContent(parts: any[]): any[] {
  return parts
    .map((p) => {
      if (typeof p?.text === 'string') {
        return { type: 'text', text: p.text };
      }
      if (p?.inlineData?.data) {
        const mime = p.inlineData.mimeType ?? 'image/jpeg';
        return {
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${p.inlineData.data}` },
        };
      }
      return null;
    })
    .filter(Boolean);
}
