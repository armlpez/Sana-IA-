import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Consultation } from '../consultations/entities/consultation.entity';
import { Diagnosis } from '../consultations/entities/diagnosis.entity';
import { ConsultationStatus } from '../consultations/enums/consultation-status.enum';
import { ChatMessage } from '../chat-messages/entities/chat-message.entity';
import { MessageRole } from '../chat-messages/enums/message-role.enum';
import { ChatInputDto } from '../consultations/dto/chat-input.dto';
import { ChatResponseDto } from '../consultations/dto/chat-response.dto';
import { SANA_CHAT_SYSTEM_PROMPT } from './prompts/chat-system-prompt';
import { CONVERSATION_TOPICS, isConversationTopicKey } from './prompts/conversation-topics';
import { EMERGENCY_RESPONSE_MESSAGE } from '../consultations/constants/emergency-response.constant';
import { ResilientLlmService, getLlmFailureDiagnostics, LlmFailureDiagnostics } from './services/resilient-llm.service';
import { SafeFallbackBuilder, ChatFallbackShape } from './utils/safe-fallback.builder';
import { GeminiErrorKind } from './utils/gemini-error-kind';
import { classifyGeminiError } from './utils/error-classifier';
import { tierForStatus } from './config/model-tiers.config';
import { AppException } from '../common/exceptions/app-exception';

/** Maximum characters from the free-form summary blob injected into the prompt. */
const PROMPT_SUMMARY_MAX_CHARS = parseInt(process.env.PROMPT_SUMMARY_MAX_CHARS ?? '2000', 10);

@Injectable()
export class ChatService {
    private readonly logger = new Logger(ChatService.name);

    constructor(
        @InjectRepository(Consultation)
        private readonly consultationRepo: Repository<Consultation>,
        @InjectRepository(ChatMessage)
        private readonly chatMessageRepo: Repository<ChatMessage>,
        private readonly resilientLlm: ResilientLlmService,
        @InjectRepository(Diagnosis)
        private readonly diagnosisRepo: Repository<Diagnosis>,
    ) {}

    async sendMessage(userId: number, dto: ChatInputDto): Promise<ChatResponseDto> {
        const startTime = Date.now();

        // 1. Find or create the consultation
        let consultation: Consultation;
        if (dto.conversationId) {
            const found = await this.consultationRepo.findOne({
                where: { id: dto.conversationId, userId },
                relations: ['ocrResults']
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

        // 2. Save the user message
        const userMessage = this.chatMessageRepo.create({
            consultationId: consultation.id,
            role: MessageRole.USER,
            content: dto.message,
        });
        await this.chatMessageRepo.save(userMessage);

        // 2.5. A consultation locked by a prior emergency signal never reaches
        // the LLM again — re-serve the fixed safety message. The user's
        // message above is still persisted for the audit trail.
        if (consultation.emergencyDetected) {
            const lockedMsg = this.chatMessageRepo.create({
                consultationId: consultation.id,
                role: MessageRole.ASSISTANT,
                content: EMERGENCY_RESPONSE_MESSAGE,
                metadata: { locked: true },
            });
            await this.chatMessageRepo.save(lockedMsg);

            return {
                conversationId: consultation.id,
                message: EMERGENCY_RESPONSE_MESSAGE,
                summary: consultation.summary ?? null,
                status: 'completed',
                extractedData: {
                    symptoms: consultation.extractedSymptoms ?? null,
                    treatment: consultation.extractedTreatment ?? null,
                    duration: consultation.extractedDuration ?? null,
                },
                diagnosis: null,
                isEmergency: true,
            };
        }

        // 3. Build prompt with bounded context
        const tier = tierForStatus(consultation.status);
        const prompt = this.buildPromptWithContext(dto.message, consultation);

        // 4. Call LLM via multi-provider resilience layer (Gemini → Groq → fallback)
        let llmResult: Awaited<ReturnType<ResilientLlmService['generateWithFallback']>>;
        try {
            llmResult = await this.resilientLlm.generateWithFallback(tier, prompt);
        } catch (err: unknown) {
            const kind = err instanceof AppException
                ? this.kindFromAppException(err)
                : classifyGeminiError(err);

            // Which model(s) the resilient chain tried, and which one finally failed.
            const diagnostics = getLlmFailureDiagnostics(err);

            // Log detailed error info server-side
            this.logger.error('Gemini call failed in chat', {
                consultationId: consultation.id,
                userId: consultation.userId,
                errorKind: kind,
                errorType: err instanceof Error ? err.constructor.name : typeof err,
                errorMessage: err instanceof Error ? err.message : String(err),
                failedProvider: diagnostics?.failedProvider,
                attemptedProviders: diagnostics?.attemptedProviders,
            });

            return this.handleChatFailure(
                consultation,
                kind,
                startTime,
                err instanceof Error ? err.message : String(err),
                diagnostics,
            );
        }

        const responseTimeMs = Date.now() - startTime;
        const rawText = llmResult.text;

        // 5. Parse the AI response
        let parsed: ReturnType<typeof this.parseResponse>;
        try {
            parsed = this.parseResponse(rawText);
        } catch (parseErr: unknown) {
            // Log only sanitized metadata — NEVER log rawText (W-02 resolved)
            this.logger.error('Failed to parse chat response', {
                consultationId: consultation.id,
                responseTimeMs,
            });
            return this.handleChatFailure(
                consultation,
                GeminiErrorKind.PARSE,
                startTime,
                parseErr instanceof Error ? parseErr.message : 'Failed to parse AI response JSON'
            );
        }

        // 6. Latch emergencyDetected when the model signals an emergency (monotonic flag).
        // Checks BOTH the top-level `isEmergency` (collecting/analyzing — added so the
        // model can escalate before completing FASE 1-3, see ESCALAMIENTO INMEDIATO)
        // and the legacy `diagnosis.isEmergency` (completed mode).
        const emergencyThisTurn =
            parsed.isEmergency === true ||
            (parsed.diagnosis != null &&
                typeof parsed.diagnosis === 'object' &&
                (parsed.diagnosis as Record<string, unknown>)['isEmergency'] === true);

        // Safety-critical wording is never LLM-improvised: replace whatever the model
        // wrote with the fixed, exact protocol message and force closure — a partial
        // interview is a moot point once the patient needs to be at an ER, not chatting.
        if (emergencyThisTurn) {
            parsed.message = EMERGENCY_RESPONSE_MESSAGE;
            parsed.status = 'completed';
        }

        // 7. Persist assistant message + consultation update in parallel
        const assistantMsg = this.chatMessageRepo.create({
            consultationId: consultation.id,
            role: MessageRole.ASSISTANT,
            content: parsed.message,
            metadata: {
                responseTimeMs,
                model: llmResult.model,
                provider: llmResult.provider,
                tier,
                tokensUsed: llmResult.usage.totalTokens,
                promptTokens: llmResult.usage.promptTokens,
                completionTokens: llmResult.usage.completionTokens,
            },
        });

        const updatePayload = this.buildConsultationUpdate(consultation, parsed, emergencyThisTurn);

        const writes: Promise<unknown>[] = [this.chatMessageRepo.save(assistantMsg)];

        if (Object.keys(updatePayload).length > 0) {
            writes.push(this.consultationRepo.update(consultation.id, updatePayload));
        }

        // Persist the diagnosis as an immutable, append-only clinical record.
        // One row per emitted diagnosis — never updated, preserving the audit trail.
        if (parsed.diagnosis) {
            writes.push(this.diagnosisRepo.save(this.buildDiagnosisRecord(consultation, parsed)));
        } else if (parsed.status === 'completed' && !emergencyThisTurn) {
            // Defensive observability: a completed consultation should carry a diagnosis.
            // Skipped for emergency short-circuits — those intentionally close without
            // a compiled RCA diagnosis (see ESCALAMIENTO INMEDIATO).
            this.logger.warn(
                `Consultation ${consultation.id} reached 'completed' without a diagnosis payload`,
            );
        }

        await Promise.all(writes);

        this.logger.log(
            `Chat message processed — consultation: ${consultation.id}, status: ${parsed.status}, emergency: ${emergencyThisTurn}, elapsedMs: ${responseTimeMs}`,
        );

        // 8. Build summary for the response
        const responseSummary = parsed.summary
            ? (typeof parsed.summary === 'string' ? { text: parsed.summary } : parsed.summary)
            : consultation.summary;

        return {
            conversationId: consultation.id,
            message: parsed.message,
            summary: responseSummary ?? null,
            status: parsed.status,
            extractedData: parsed.extractedData,
            diagnosis: parsed.diagnosis ?? null,
            isEmergency: emergencyThisTurn,
        };
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

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Handles a failed Gemini call on the chat path.
     *
     * Saves a fallback assistant message and returns a 200 with a clinically-safe body.
     * Never throws (so the patient always gets a response, not a 500).
     * PHI is NEVER logged (W-02 resolved for chat).
     */
    private async handleChatFailure(
        consultation: Consultation,
        kind: GeminiErrorKind,
        startTime: number,
        errorMessage?: string,
        diagnostics?: LlmFailureDiagnostics,
    ): Promise<ChatResponseDto> {
        const responseTimeMs = Date.now() - startTime;

        const fallback: ChatFallbackShape = SafeFallbackBuilder.forChat({
            emergencyDetected: consultation.emergencyDetected,
            kind,
        });

        // Log only sanitized metadata — NEVER log rawText or patient content
        this.logger.warn('Chat fallback triggered', {
            consultationId: consultation.id,
            errorKind: kind,
            failedProvider: diagnostics?.failedProvider,
            attemptedProviders: diagnostics?.attemptedProviders,
            priorEmergency: consultation.emergencyDetected,
            responseTimeMs,
        });

        // Save the fallback message so the conversation record is complete.
        // Persist the errorKind so operators can tell WHY the fallback fired
        // (RATE_LIMITED, TIMEOUT, PARSE, ...) and WHICH model failed (failedProvider)
        // directly from the DB — no log grep needed.
        const assistantMsg = this.chatMessageRepo.create({
            consultationId: consultation.id,
            role: MessageRole.ASSISTANT,
            content: fallback.message,
            metadata: {
                responseTimeMs,
                failure: {
                    errorKind: kind,
                    errorMessage: errorMessage,
                    failedProvider: diagnostics?.failedProvider,
                    attemptedProviders: diagnostics?.attemptedProviders,
                },
            },
        });
        await this.chatMessageRepo.save(assistantMsg);

        return {
            conversationId: consultation.id,
            message: fallback.message,
            summary: consultation.summary ?? null,
            status: consultation.status,
            extractedData: fallback.extractedData,
            diagnosis: fallback.diagnosis,
            isEmergency: consultation.emergencyDetected === true,
        };
    }

    /**
     * Builds prompt with bounded consultation context.
     *
     * The free-form summary blob is capped at PROMPT_SUMMARY_MAX_CHARS keeping
     * the TAIL (most recent state). Structured fields are injected separately in full
     * because they are short and clinically load-bearing.
     */
    private buildPromptWithContext(message: string, consultation: Consultation): string {
        let prompt = SANA_CHAT_SYSTEM_PROMPT + '\n\n';

        if (consultation.summary) {
            const summaryStr = typeof consultation.summary === 'string'
                ? consultation.summary
                : JSON.stringify(consultation.summary);

            const bounded = summaryStr.length > PROMPT_SUMMARY_MAX_CHARS
                ? '[...contexto truncado]\n' + summaryStr.slice(-PROMPT_SUMMARY_MAX_CHARS)
                : summaryStr;

            prompt += `[Contexto previo de la conversación]\nResumen: ${bounded}\n`;

            if (consultation.extractedSymptoms) {
                prompt += `Síntomas detectados: ${consultation.extractedSymptoms}\n`;
            }
            if (consultation.extractedTreatment) {
                prompt += `Tratamiento actual: ${consultation.extractedTreatment}\n`;
            }
            if (consultation.extractedDuration) {
                prompt += `Duración reportada: ${consultation.extractedDuration}\n`;
            }

            // Inyectar resultados de OCR (Data Hard) si existen
            if (consultation.ocrResults && consultation.ocrResults.length > 0) {
                const completedResults = consultation.ocrResults.filter(
                    r => r.status === 'completed' && r.extractedData?.biomarkers?.length > 0
                );
                
                if (completedResults.length > 0) {
                    prompt += `\n[RESULTADOS CLÍNICOS DEL PACIENTE (DATA HARD)]\n`;
                    prompt += `Los siguientes biomarcadores fueron extraídos de exámenes de laboratorio:\n`;
                    for (const result of completedResults) {
                        for (const b of result.extractedData.biomarkers) {
                            prompt += `- ${b.name}: ${b.value} ${b.unit || ''} (${b.flag || 'desconocido'})\n`;
                        }
                    }
                    prompt += `*Instrucción Obligatoria: Cruza esta evidencia científica de laboratorio con los síntomas reportados para afinar tu diagnóstico usando los 5 Porqués.*\n`;
                }
            }

            prompt += '\n';
        }

        // [Progreso de la consulta] — always present (from turn 1), OUTSIDE the summary
        // guard. Deterministic anti-repetition memory: the LLM reads which topics were
        // already covered instead of relying on its own rolling summary.
        // D14: labs count as covered when the patient already uploaded results (OCR →
        // biomarkers), even if the AI never asked. Computed at prompt-build time (not
        // persisted) so it always reflects the current state of ocrResults.
        const labsViaOcr = consultation.ocrResults?.some(
            r => r.status === 'completed' && r.extractedData?.biomarkers?.length > 0,
        ) ?? false;

        // A topic is "covered" not only when the AI explicitly asked about it
        // (askedTopics), but also when we already HAVE the underlying data —
        // e.g. the patient volunteers it before being asked. Deriving coverage
        // from what we KNOW (not just what was asked) closes the gap where
        // topicAsked never gets reported for spontaneously-given information.
        const coveredTopics = new Set(consultation.askedTopics ?? []);
        if (consultation.extractedSymptoms) coveredTopics.add(CONVERSATION_TOPICS.SINTOMAS);
        if (consultation.extractedDuration) coveredTopics.add(CONVERSATION_TOPICS.DURACION);
        if (consultation.extractedTreatment) coveredTopics.add(CONVERSATION_TOPICS.AUTOMEDICACION);
        if (labsViaOcr) coveredTopics.add(CONVERSATION_TOPICS.LABORATORIOS);

        const covered = coveredTopics.size ? [...coveredTopics].join(', ') : 'ninguno aún';
        const lastAsked = consultation.askedTopics?.length
            ? consultation.askedTopics[consultation.askedTopics.length - 1]
            : '—';

        // Labs can be "asked but not yet provided" — a state distinct from
        // "covered". Surfacing it explicitly reinforces FASE 2's own rule ("si
        // el paciente no tiene, avanzá igual") instead of leaving the model to
        // re-request them each turn it doesn't see biomarkers.
        const labsAskedNotProvided =
            (consultation.askedTopics ?? []).includes(CONVERSATION_TOPICS.LABORATORIOS) && !labsViaOcr;

        prompt += `[Progreso de la consulta]\n`
            + `Temas ya cubiertos: ${covered}\n`
            + `Última pregunta realizada: ${lastAsked}\n`;

        if (labsAskedNotProvided) {
            prompt += `Laboratorios: ya solicitados, el paciente no los aportó — NO volver a pedirlos, avanzá con hipótesis preliminar.\n`;
        }

        prompt += '\n';

        prompt += `[Mensaje del paciente]\n${message}`;

        return prompt;
    }

    /**
     * Parses the raw JSON from the model.
     * Throws on parse error so the caller can route to handleChatFailure.
     * rawText is NEVER assigned to the message field (W-02 resolved — kills chat.service.ts:235 bug).
     */
    private parseResponse(rawText: string): {
        message: string;
        topicAsked: string | null;
        isEmergency: boolean;
        extractedData: { symptoms: string | null; treatment: string | null; duration: string | null };
        summary: Record<string, unknown> | null;
        status: string;
        diagnosis: Record<string, unknown> | null;
    } {
        let cleaned = rawText.trim();
        const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
            cleaned = jsonMatch[1].trim();
        } else {
            const firstBrace = cleaned.indexOf('{');
            const lastBrace = cleaned.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                cleaned = cleaned.substring(firstBrace, lastBrace + 1);
            }
        }

        const data = JSON.parse(cleaned); // throws if invalid JSON — caught by caller

        const summary = data.summary
            ? (typeof data.summary === 'string' ? { text: data.summary } : data.summary)
            : null;

        return {
            message: typeof data.message === 'string' && data.message.length > 0
                ? data.message
                : 'No pude generar una respuesta.',
            // Only enum keys are accepted — anything else (free text, typos) degrades
            // to null so askedTopics never accumulates garbage labels.
            topicAsked: isConversationTopicKey(data.topicAsked) ? data.topicAsked : null,
            // Checked independently of `diagnosis` (which stays null until FASE 3) so
            // the model can escalate an emergency from any phase — see ESCALAMIENTO
            // INMEDIATO in the system prompt.
            isEmergency: data.isEmergency === true,
            extractedData: {
                symptoms: data.extractedData?.symptoms ?? null,
                treatment: data.extractedData?.treatment ?? null,
                duration: data.extractedData?.duration ?? null,
            },
            summary,
            status: data.status ?? 'collecting',
            diagnosis: data.diagnosis ?? null,
        };
    }

    /**
     * Builds the Consultation update payload for the current turn.
     *
     * Latches emergencyDetected to true when this turn signals an emergency.
     * Never clears it to false (monotonic per design decision 1).
     */
    private buildConsultationUpdate(
        consultation: Consultation,
        parsed: {
            topicAsked: string | null;
            extractedData: { symptoms: string | null; treatment: string | null; duration: string | null };
            summary: Record<string, unknown> | null;
            status: string;
        },
        emergencyThisTurn: boolean,
    ): Partial<Consultation> {
        const updates: Partial<Consultation> = {};

        if (parsed.extractedData.symptoms) {
            updates.extractedSymptoms = parsed.extractedData.symptoms;
        }
        if (parsed.extractedData.treatment) {
            updates.extractedTreatment = parsed.extractedData.treatment;
        }
        if (parsed.extractedData.duration) {
            updates.extractedDuration = parsed.extractedData.duration;
        }

        if (parsed.summary) {
            updates.summary = parsed.summary;
        }

        if (parsed.status === 'completed') {
            updates.status = ConsultationStatus.COMPLETED;
        } else if (parsed.status === 'analyzing') {
            updates.status = ConsultationStatus.ANALYZING;
        }

        if (!consultation.title && parsed.extractedData.symptoms) {
            updates.title = `Consulta: ${parsed.extractedData.symptoms.substring(0, 100)}`;
        }

        // Latch: only write true, never write false
        if (emergencyThisTurn && !consultation.emergencyDetected) {
            updates.emergencyDetected = true;
        }

        // Anti-repetition: accumulate NEW topics only (append-once, like the emergency
        // latch). A turn with topicAsked=null (greeting, patient correction) does NOT
        // consume clinical progress. See docs/IMPLEMENTACION-ANTI-REPETICION-CONSULTA.md.
        if (isConversationTopicKey(parsed.topicAsked)) {
            const label = CONVERSATION_TOPICS[parsed.topicAsked];
            if (!consultation.askedTopics?.includes(label)) {
                updates.askedTopics = [...(consultation.askedTopics ?? []), label];
            }
        }

        return updates;
    }

    /**
     * Builds an immutable Diagnosis record from the parsed AI output.
     *
     * Promotes the clinically load-bearing fields (isEmergency, specialist,
     * confidence) to columns while keeping the full payload verbatim for fidelity.
     */
    private buildDiagnosisRecord(
        consultation: Consultation,
        parsed: { status: string; diagnosis: Record<string, unknown> | null },
    ): Diagnosis {
        const d = parsed.diagnosis ?? {};

        return this.diagnosisRepo.create({
            consultationId: consultation.id,
            userId: consultation.userId,
            statusAtEmit: this.toConsultationStatus(parsed.status),
            isEmergency: d['isEmergency'] === true,
            suggestedSpecialist:
                typeof d['suggestedSpecialist'] === 'string' ? (d['suggestedSpecialist'] as string) : null,
            confidenceLevel:
                typeof d['confidenceLevel'] === 'number' ? (d['confidenceLevel'] as number) : null,
            payload: parsed.diagnosis as Record<string, any>,
        });
    }

    /** Maps the loose AI status string to the ConsultationStatus enum. */
    private toConsultationStatus(status: string): ConsultationStatus {
        switch (status) {
            case 'completed': return ConsultationStatus.COMPLETED;
            case 'analyzing': return ConsultationStatus.ANALYZING;
            default:          return ConsultationStatus.COLLECTING;
        }
    }

    /**
     * Maps an AppException back to the GeminiErrorKind that caused it,
     * for use in the fallback path.
     */
    private kindFromAppException(ex: AppException): GeminiErrorKind {
        switch (ex.errorCode) {
            case 'ERR_AI_002': return GeminiErrorKind.TIMEOUT;
            case 'ERR_AI_003': return GeminiErrorKind.RATE_LIMITED;
            case 'ERR_AI_004': return GeminiErrorKind.UNAVAILABLE;
            case 'ERR_AI_005': return GeminiErrorKind.PARSE;
            default:            return GeminiErrorKind.UNKNOWN;
        }
    }
}
