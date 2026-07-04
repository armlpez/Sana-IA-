import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { AiController } from './ai.controller';
import { GeminiClientService } from './services/gemini-client.service';
import { ResilientLlmService } from './services/resilient-llm.service';
import { GeminiAdapter } from './adapters/gemini-adapter';
import { GroqAdapter } from './adapters/groq-adapter';
import { DeepSeekAdapter } from './adapters/deepseek-adapter';
import { createLlmProviderFactory } from './factories/llm-provider.factory';
import { ConsultationsModule } from '../consultations/consultations.module';
import { ChatMessagesModule } from '../chat-messages/chat-messages.module';
import aiModelsConfig from './config/model-tiers.config';

@Module({
    imports: [
        ConsultationsModule,
        ChatMessagesModule,
        // Ensure the aiModels config namespace is available within this module.
        // app.module.ts already registers it globally via ConfigModule.load([aiModelsConfig]),
        // but importing it here makes the module self-contained and testable in isolation.
        ConfigModule.forFeature(aiModelsConfig),
    ],
    controllers: [AiController],
    providers: [
        GeminiClientService,
        GroqAdapter,
        DeepSeekAdapter,
        GeminiAdapter,
        createLlmProviderFactory(),
        ResilientLlmService,
        AiService,
        ChatService,
    ],
    exports: [AiService, ChatService, GeminiClientService, ResilientLlmService],
})
export class AiModule {}
