import {
    Controller,
    Post,
    Get,
    Delete,
    Body,
    Param,
    ParseIntPipe,
    UseGuards,
    HttpCode,
    HttpStatus,
    Request,
} from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { AnalyzeInputDto } from './dto/analyze-input.dto';
import { AnalyzeResponseDto } from './dto/analyze-response.dto';
import { ChatInputDto } from '../consultations/dto/chat-input.dto';
import { ChatResponseDto } from '../consultations/dto/chat-response.dto';
import { DeleteConversationsDto } from '../consultations/dto/delete-conversations.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// 'auth-sensitive'/'registration' are anti-abuse tiers scoped to specific auth
// endpoints — @nestjs/throttler applies every forRoot() tier to all routes by
// default, so without this skip, normal chat usage (>5 msgs/15min) silently
// trips the password-reset rate limit and returns 429 on real consultations.
@SkipThrottle({ 'auth-sensitive': true, registration: true })
@Controller({ path: 'ai', version: '1' })
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
    @Throttle({ chat: {} })
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

    /**
     * DELETE /v1/ai/conversations
     *
     * Bulk hard-delete of the user's conversations. Body: { "ids": number[] }.
     * Returns 200 with { deletedIds, notFoundIds } — ids that don't exist or
     * belong to another user land in notFoundIds instead of failing the batch.
     */
    @Delete('conversations')
    @HttpCode(HttpStatus.OK)
    async deleteConversations(
        @Body() dto: DeleteConversationsDto,
        @Request() req: any,
    ) {
        return this.chatService.deleteConversations(dto.ids, req.user.id);
    }
}
