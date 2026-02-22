import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { AiController } from './ai.controller';
import { ConsultationsModule } from '../consultations/consultations.module';
import { ChatMessagesModule } from '../chat-messages/chat-messages.module';

@Module({
    imports: [
        ConsultationsModule,
        ChatMessagesModule,
    ],
    controllers: [AiController],
    providers: [AiService, ChatService],
    exports: [AiService, ChatService],
})
export class AiModule { }
