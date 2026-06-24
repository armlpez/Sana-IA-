import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { AiController } from './ai.controller';
import { GeminiClientService } from './services/gemini-client.service';
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
        AiService,
        ChatService,
    ],
    exports: [AiService, ChatService, GeminiClientService],
})
export class AiModule {}
