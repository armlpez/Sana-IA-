import { Injectable, Logger, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { Consultation } from '../consultations/entities/consultation.entity';
import { ConsultationStatus } from '../consultations/enums/consultation-status.enum';
import { ChatMessage } from '../chat-messages/entities/chat-message.entity';
import { MessageRole } from '../chat-messages/enums/message-role.enum';
import { ChatInputDto } from '../consultations/dto/chat-input.dto';
import { ChatResponseDto } from '../consultations/dto/chat-response.dto';
import { SANA_CHAT_SYSTEM_PROMPT } from './prompts/chat-system-prompt';

@Injectable()
export class ChatService {
    private readonly logger = new Logger(ChatService.name);
    private readonly chatModel: GenerativeModel;
    private readonly modelName: string;

    constructor(
        @InjectRepository(Consultation)
        private readonly consultationRepo: Repository<Consultation>,
        @InjectRepository(ChatMessage)
        private readonly chatMessageRepo: Repository<ChatMessage>,
        private readonly configService: ConfigService,
    ) {
        const apiKey = this.configService.get<string>('GEMINI_API_KEY');
        this.modelName = this.configService.get<string>('GEMINI_MODEL') || 'gemini-2.0-flash-lite';

        if (!apiKey) {
            this.logger.warn('GEMINI_API_KEY no configurada. El chat no funcionará.');
            return;
        }

        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            this.chatModel = genAI.getGenerativeModel({
                model: this.modelName,
                systemInstruction: SANA_CHAT_SYSTEM_PROMPT,
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.4,
                },
            });
            this.logger.log(`ChatService initialized with model: ${this.modelName}`);
        } catch (error) {
            this.logger.error(`Error initializing ChatService: ${error.message}`);
        }
    }

    async sendMessage(userId: number, dto: ChatInputDto): Promise<ChatResponseDto> {
        if (!this.chatModel) {
            throw new InternalServerErrorException('El servicio de chat no está configurado (Falta GEMINI_API_KEY)');
        }

        const startTime = Date.now();

        // 1. Obtener o crear la consulta
        let consultation: Consultation;
        if (dto.conversationId) {
            const found = await this.consultationRepo.findOne({
                where: { id: dto.conversationId, userId },
            });
            if (!found) {
                throw new NotFoundException('Conversación no encontrada');
            }
            consultation = found;
        } else {
            consultation = this.consultationRepo.create({
                userId,
                status: ConsultationStatus.COLLECTING,
            });
            consultation = await this.consultationRepo.save(consultation);
            this.logger.log(`New consultation created: ${consultation.id} for user: ${userId}`);
        }

        // 2. Guardar el mensaje del usuario
        const userMessage = this.chatMessageRepo.create({
            consultationId: consultation.id,
            role: MessageRole.USER,
            content: dto.message,
        });
        await this.chatMessageRepo.save(userMessage);

        // 3. Construir el prompt con contexto
        const prompt = this.buildPromptWithContext(dto.message, consultation);

        // 4. Llamar a Gemini
        try {
            const result = await this.chatModel.generateContent(prompt);
            const response = result.response;
            const rawText = response.text();
            const responseTimeMs = Date.now() - startTime;

            this.logger.debug(`Raw chat response: ${rawText}`);

            // 5. Parsear la respuesta de la IA
            const parsed = this.parseResponse(rawText);

            // 6. Guardar el mensaje de la IA
            const assistantMessage = this.chatMessageRepo.create({
                consultationId: consultation.id,
                role: MessageRole.ASSISTANT,
                content: parsed.message,
                metadata: {
                    model: this.modelName,
                    tokensUsed: response.usageMetadata?.totalTokenCount ?? undefined,
                    responseTimeMs,
                },
            });
            await this.chatMessageRepo.save(assistantMessage);

            // 7. Actualizar la consulta con los datos extraídos
            await this.updateConsultation(consultation, parsed);

            this.logger.log(`Chat message processed for consultation ${consultation.id} | Status: ${parsed.status}`);

            // 8. Construir el summary para la respuesta
            const responseSummary = parsed.summary
                ? (typeof parsed.summary === 'string' ? { text: parsed.summary } : parsed.summary)
                : consultation.summary;

            return {
                conversationId: consultation.id,
                message: parsed.message,
                summary: responseSummary || null,
                status: parsed.status,
                extractedData: parsed.extractedData,
                diagnosis: parsed.diagnosis || null,
            };
        } catch (error) {
            this.logger.error(`Error in chat: ${error.message}`, error.stack);

            // Guardar respuesta de error como mensaje de la IA
            const errorMessage = this.chatMessageRepo.create({
                consultationId: consultation.id,
                role: MessageRole.ASSISTANT,
                content: 'Lo siento, hubo un problema procesando tu mensaje. ¿Podrías intentar de nuevo?',
                metadata: {
                    model: this.modelName,
                    responseTimeMs: Date.now() - startTime,
                },
            });
            await this.chatMessageRepo.save(errorMessage);

            throw new InternalServerErrorException('Error al procesar el mensaje');
        }
    }

    async getConversation(id: number, userId: number): Promise<Consultation> {
        const consultation = await this.consultationRepo.findOne({
            where: { id, userId },
            relations: ['messages'],
            order: { messages: { createdAt: 'ASC' } },
        });

        if (!consultation) {
            throw new NotFoundException('Conversación no encontrada');
        }

        return consultation;
    }

    async getUserConversations(userId: number): Promise<Consultation[]> {
        return this.consultationRepo.find({
            where: { userId },
            order: { updatedAt: 'DESC' },
            select: ['id', 'title', 'summary', 'status', 'createdAt', 'updatedAt'],
        });
    }

    private buildPromptWithContext(message: string, consultation: Consultation): string {
        let prompt = '';

        // Agregar el summary anterior como contexto
        if (consultation.summary) {
            prompt += `[Contexto previo de la conversación]\n`;
            prompt += `Resumen: ${JSON.stringify(consultation.summary)}\n`;

            if (consultation.extractedSymptoms) {
                prompt += `Síntomas detectados: ${consultation.extractedSymptoms}\n`;
            }
            if (consultation.extractedTreatment) {
                prompt += `Tratamiento actual: ${consultation.extractedTreatment}\n`;
            }
            if (consultation.extractedDuration) {
                prompt += `Duración reportada: ${consultation.extractedDuration}\n`;
            }

            prompt += `\n`;
        }

        prompt += `[Mensaje del paciente]\n${message}`;

        return prompt;
    }

    private parseResponse(rawText: string): {
        message: string;
        extractedData: { symptoms: string | null; treatment: string | null; duration: string | null };
        summary: Record<string, any> | null;
        status: string;
        diagnosis: Record<string, any> | null;
    } {
        try {
            let cleanedText = rawText.trim();
            if (cleanedText.startsWith('```json')) {
                cleanedText = cleanedText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
            } else if (cleanedText.startsWith('```')) {
                cleanedText = cleanedText.replace(/^```\n?/, '').replace(/\n?```$/, '');
            }

            const parsed = JSON.parse(cleanedText);

            const summary = parsed.summary
                ? (typeof parsed.summary === 'string' ? { text: parsed.summary } : parsed.summary)
                : null;

            return {
                message: parsed.message || 'No pude generar una respuesta.',
                extractedData: {
                    symptoms: parsed.extractedData?.symptoms || null,
                    treatment: parsed.extractedData?.treatment || null,
                    duration: parsed.extractedData?.duration || null,
                },
                summary,
                status: parsed.status || 'collecting',
                diagnosis: parsed.diagnosis || null,
            };
        } catch (error) {
            this.logger.error(`Failed to parse chat response: ${error.message}`);
            this.logger.debug(`Raw text: ${rawText}`);

            return {
                message: rawText || 'No pude procesar la respuesta.',
                extractedData: { symptoms: null, treatment: null, duration: null },
                summary: null,
                status: 'collecting',
                diagnosis: null,
            };
        }
    }

    private async updateConsultation(
        consultation: Consultation,
        parsed: {
            extractedData: { symptoms: string | null; treatment: string | null; duration: string | null };
            summary: Record<string, any> | null;
            status: string;
            diagnosis: Record<string, any> | null;
        },
    ): Promise<void> {
        const updates: Partial<Consultation> = {};

        // Actualizar campos extraídos (solo si tienen valor nuevo)
        if (parsed.extractedData.symptoms) {
            updates.extractedSymptoms = parsed.extractedData.symptoms;
        }
        if (parsed.extractedData.treatment) {
            updates.extractedTreatment = parsed.extractedData.treatment;
        }
        if (parsed.extractedData.duration) {
            updates.extractedDuration = parsed.extractedData.duration;
        }

        // Actualizar summary
        if (parsed.summary) {
            updates.summary = parsed.summary;
        }

        // Actualizar status
        if (parsed.status === 'completed') {
            updates.status = ConsultationStatus.COMPLETED;
        } else if (parsed.status === 'analyzing') {
            updates.status = ConsultationStatus.ANALYZING;
        }

        // Generar título automático si no existe
        if (!consultation.title && parsed.extractedData.symptoms) {
            updates.title = `Consulta: ${parsed.extractedData.symptoms.substring(0, 100)}`;
        }

        if (Object.keys(updates).length > 0) {
            await this.consultationRepo.update(consultation.id, updates);
        }
    }
}
