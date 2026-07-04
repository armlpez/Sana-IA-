import { Injectable } from '@nestjs/common';
import { GeminiClientService } from '../services/gemini-client.service';
import { LlmProviderPort } from '../ports/llm-provider.port';
import { ModelTier } from '../config/model-tiers.config';

/**
 * Gemini Adapter — wraps GeminiClientService to implement LlmProviderPort.
 * This allows Gemini to be used interchangeably with other providers (Groq, Zhipu, etc).
 */
@Injectable()
export class GeminiAdapter implements LlmProviderPort {
  constructor(private readonly geminiClient: GeminiClientService) {}

  async generateWithResilience(tier: ModelTier, prompt: string | any[]): Promise<string> {
    return this.geminiClient.generateWithResilience(tier, prompt);
  }

  getName(): string {
    return 'gemini';
  }

  supportsVision(): boolean {
    return true; // Gemini Vision handles inlineData parts natively
  }
}
