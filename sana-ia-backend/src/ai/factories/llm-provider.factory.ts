import { Provider } from '@nestjs/common';
import { LlmProviderPort, LLM_PROVIDER_PORT } from '../ports/llm-provider.port';
import { GeminiAdapter } from '../adapters/gemini-adapter';
import { GroqAdapter } from '../adapters/groq-adapter';
import { DeepSeekAdapter } from '../adapters/deepseek-adapter';
import { GeminiClientService } from '../services/gemini-client.service';

/**
 * LLM Provider Factory — creates a Map of all available providers
 * keyed by name ('gemini', 'groq', 'deepseek', etc).
 *
 * This enables config-driven provider selection without code changes.
 * Add new providers by:
 * 1. Creating an adapter (e.g., ZhipuAdapter)
 * 2. Adding it to the factory map
 * 3. Updating .env: LLM_FALLBACK_CHAIN=groq,deepseek,zhipu
 */
export const createLlmProviderFactory = (): Provider => {
  return {
    provide: LLM_PROVIDER_PORT,
    useFactory: (
      geminiClient: GeminiClientService,
      groqAdapter: GroqAdapter,
      deepSeekAdapter: DeepSeekAdapter,
    ): Map<string, LlmProviderPort> => {
      const geminiAdapter = new GeminiAdapter(geminiClient);

      const providers = new Map<string, LlmProviderPort>([
        ['gemini', geminiAdapter],
        ['groq', groqAdapter],
        ['deepseek', deepSeekAdapter],
        // Future providers:
        // ['zhipu', zhipuAdapter],
        // ['cerebras', cerebrasAdapter],
      ]);

      return providers;
    },
    inject: [GeminiClientService, GroqAdapter, DeepSeekAdapter],
  };
};
