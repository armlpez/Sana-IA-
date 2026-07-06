import { Provider } from '@nestjs/common';
import { LlmProviderPort, LLM_PROVIDER_PORT } from '../ports/llm-provider.port';
import { GeminiAdapter } from '../adapters/gemini-adapter';
import { GroqAdapter } from '../adapters/groq-adapter';
import { CerebrasAdapter } from '../adapters/cerebras-adapter';
import { BedrockAdapter } from '../adapters/bedrock-adapter';
import { GeminiClientService } from '../services/gemini-client.service';

/**
 * LLM Provider Factory — creates a Map of all available providers
 * keyed by name ('bedrock', 'gemini', 'groq', 'cerebras', etc).
 *
 * This enables config-driven provider selection without code changes.
 * Add new providers by:
 * 1. Creating an adapter (e.g., ZhipuAdapter)
 * 2. Adding it to the factory map
 * 3. Updating .env: LLM_FALLBACK_CHAIN=gemini,groq,cerebras,zhipu
 */
export const createLlmProviderFactory = (): Provider => {
  return {
    provide: LLM_PROVIDER_PORT,
    useFactory: (
      geminiClient: GeminiClientService,
      groqAdapter: GroqAdapter,
      cerebrasAdapter: CerebrasAdapter,
      bedrockAdapter: BedrockAdapter,
    ): Map<string, LlmProviderPort> => {
      const geminiAdapter = new GeminiAdapter(geminiClient);

      const providers = new Map<string, LlmProviderPort>([
        ['bedrock', bedrockAdapter],
        ['gemini', geminiAdapter],
        ['groq', groqAdapter],
        ['cerebras', cerebrasAdapter],
        // Future providers:
        // ['zhipu', zhipuAdapter],
      ]);

      return providers;
    },
    inject: [GeminiClientService, GroqAdapter, CerebrasAdapter, BedrockAdapter],
  };
};

