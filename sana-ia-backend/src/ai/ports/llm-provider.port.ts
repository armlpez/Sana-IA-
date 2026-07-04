import { ModelTier } from '../config/model-tiers.config';

/**
 * LlmProviderPort — Hexagonal abstraction for LLM providers (Gemini, Groq, Zhipu, etc).
 *
 * Implementors wrap vendor APIs and expose a unified interface: tier-based model selection,
 * timeout, retry logic, and error classification. Consumers never care which backend is used.
 */
export const LLM_PROVIDER_PORT = Symbol('LlmProviderPort');

export interface LlmProviderPort {
  /**
   * Generate text from a prompt using the given tier's model.
   *
   * @param tier COLLECTING (fast/lite), ANALYZING (mid), or COMPLETED (slow/pro)
   * @param prompt Text or multimodal (text + image) content
   * @returns Raw text from the model
   * @throws AppException on failure (classified error kind for fallback routing)
   */
  generateWithResilience(tier: ModelTier, prompt: string | any[]): Promise<string>;

  /**
   * Returns the provider name for logging/observability.
   */
  getName(): string;

  /**
   * Whether this provider can accept image parts (Gemini inlineData / OpenAI
   * image_url). ResilientLlmService uses this to skip text-only providers when
   * routing a multimodal prompt (e.g. OCR) through the fallback chain.
   */
  supportsVision(): boolean;
}
