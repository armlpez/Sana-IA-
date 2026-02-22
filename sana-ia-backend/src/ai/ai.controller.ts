import {
    Controller,
    Post,
    Get,
    Body,
    Param,
    ParseIntPipe,
    UseGuards,
    HttpCode,
    HttpStatus,
    Request,
} from '@nestjs/common';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { AnalyzeInputDto } from './dto/analyze-input.dto';
import { AnalyzeResponseDto } from './dto/analyze-response.dto';
import { ChatInputDto } from '../consultations/dto/chat-input.dto';
import { ChatResponseDto } from '../consultations/dto/chat-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
    constructor(
        private readonly aiService: AiService,
        private readonly chatService: ChatService,
    ) { }

    // Endpoint original: análisis directo con JSON estructurado
    @Post('analyze')
    @HttpCode(HttpStatus.OK)
    async analyzeSymptoms(@Body() analyzeInputDto: AnalyzeInputDto): Promise<AnalyzeResponseDto> {
        return this.aiService.analyzeSymptoms(analyzeInputDto);
    }

    // Nuevo: enviar mensaje al chat conversacional
    @Post('chat')
    @HttpCode(HttpStatus.OK)
    async sendChatMessage(
        @Body() chatInputDto: ChatInputDto,
        @Request() req: any,
    ): Promise<ChatResponseDto> {
        return this.chatService.sendMessage(req.user.id, chatInputDto);
    }

    // Nuevo: listar conversaciones del usuario
    @Get('conversations')
    async getUserConversations(@Request() req: any) {
        return this.chatService.getUserConversations(req.user.id);
    }

    // Nuevo: obtener detalle de una conversación con mensajes
    @Get('conversations/:id')
    async getConversation(
        @Param('id', ParseIntPipe) id: number,
        @Request() req: any,
    ) {
        return this.chatService.getConversation(id, req.user.id);
    }
}
