import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { OCR_QUEUE_NAME, OcrJobPayload } from './ocr.job';
import { OcrResult } from './entities/ocr-result.entity';
import { OcrJobStatus } from './enums/ocr-job-status.enum';
import { Consultation } from '../consultations/entities/consultation.entity';
import { ChatMessage } from '../chat-messages/entities/chat-message.entity';
import { MessageRole } from '../chat-messages/enums/message-role.enum';
import { EMERGENCY_RESPONSE_MESSAGE } from '../consultations/constants/emergency-response.constant';
import { ResilientLlmService } from '../ai/services/resilient-llm.service';
import { STORAGE_PORT } from '../storage/storage.port';
import type { StoragePort } from '../storage/storage.port';
import { extractMimeType } from '../storage/utils/mime.util';
import { MODEL_TIER_PRO } from '../ai/config/model-tiers.config';
import { Part } from '@google/generative-ai';

/**
 * Worker (consumer) that processes OCR jobs from the BullMQ queue.
 *
 * Flow:
 * 1. Reads the OcrResult row from Postgres (gets imagePath)
 * 2. Loads the image from local storage
 * 3. Sends to the resilient LLM chain (Gemini Vision → Groq vision fallback;
 *    text-only providers like Cerebras are skipped for image prompts)
 * 4. Parses the structured response
 * 5. Writes extractedData back to the OcrResult row
 *
 * PHI SAFETY: Image bytes are read from disk and sent to Gemini in-memory.
 * They are NEVER written to Redis or logged.
 */
@Processor(OCR_QUEUE_NAME, {
    concurrency: 2, // Process up to 2 images in parallel per instance
})
export class OcrWorker extends WorkerHost {
    private readonly logger = new Logger(OcrWorker.name);

    constructor(
        @InjectRepository(OcrResult)
        private readonly ocrResultRepo: Repository<OcrResult>,
        @InjectRepository(Consultation)
        private readonly consultationRepo: Repository<Consultation>,
        @InjectRepository(ChatMessage)
        private readonly chatMessageRepo: Repository<ChatMessage>,
        private readonly resilientLlm: ResilientLlmService,
        @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    ) {
        super();
    }

    async process(job: Job<OcrJobPayload>): Promise<void> {
        const { ocrResultId, userId } = job.data;
        const startTime = Date.now();

        this.logger.log(`Processing OCR job — ocrResultId: ${ocrResultId}, user: ${userId}`);

        try {
            // 1. Mark as processing
            await this.ocrResultRepo.update(ocrResultId, {
                status: OcrJobStatus.PROCESSING,
            });

            // 2. Fetch the record to get imagePath
            const ocrResult = await this.ocrResultRepo.findOne({
                where: { id: ocrResultId },
            });

            if (!ocrResult) {
                throw new Error(`OcrResult not found: ${ocrResultId}`);
            }

            // 3. Read image from storage (local disk or S3 via abstraction)
            const imageBuffer = await this.storage.get(ocrResult.imagePath);
            const base64Image = imageBuffer.toString('base64');
            const mimeType = extractMimeType(ocrResult.imagePath);

            // 4. Build prompt for Gemini Vision
            const prompt = this.buildOcrPrompt(base64Image, mimeType);

            // 5. Call the multi-provider fallback chain (Gemini → Groq vision).
            // MODEL_TIER_PRO → timeoutSlowMs (30s) to accommodate Vision OCR (8-15s typical).
            // The fast tier (8s) is too tight for image processing.
            const llmResult = await this.resilientLlm.generateWithFallback(
                MODEL_TIER_PRO,
                prompt,
            );
            const rawText = llmResult.text;

            // 6. Parse structured biomarkers
            const extractedData = this.parseBiomarkers(rawText);

            // 7. Persist results to PostgreSQL
            const processingTimeMs = Date.now() - startTime;
            await this.ocrResultRepo.update(ocrResultId, {
                status: OcrJobStatus.COMPLETED,
                extractedData,
                // rawText is intentionally omitted (don't store raw LLM output for PHI-safety)
                processingTimeMs,
                metadata: {
                    provider: llmResult.provider,
                    model: llmResult.model,
                    tier: MODEL_TIER_PRO,
                    tokensUsed: llmResult.usage.totalTokens,
                    promptTokens: llmResult.usage.promptTokens,
                    completionTokens: llmResult.usage.completionTokens,
                },
            });

            // hasExtractionNotes is a sanitized boolean — the note's CONTENT stays in
            // extractedData (Postgres, the durable PHI record) and is never logged.
            this.logger.log(
                `OCR job completed — ocrResultId: ${ocrResultId}, biomarkers: ${extractedData?.biomarkers?.length ?? 0}, hasExtractionNotes: ${Boolean(extractedData?.extractionNotes)}, elapsedMs: ${processingTimeMs}`,
            );

            // 8. Emergency escalation: if any biomarker came back flagged "critico",
            // lock the consultation and serve the fixed safety message — same
            // mechanism and exact text as the chat-triggered emergency path (see
            // EMERGENCY_RESPONSE_MESSAGE / ChatService.sendMessage step 2.5). OCR is
            // async with no live channel to the patient, so the message is delivered
            // as a regular ChatMessage, seen the next time they open the conversation.
            const hasCriticalBiomarker = (extractedData?.biomarkers as { flag?: string }[] | undefined)
                ?.some((b) => b.flag === 'critico') ?? false;

            if (hasCriticalBiomarker && ocrResult.consultationId) {
                const consultation = await this.consultationRepo.findOne({
                    where: { id: ocrResult.consultationId },
                });
                if (consultation && !consultation.emergencyDetected) {
                    await this.consultationRepo.update(consultation.id, { emergencyDetected: true });
                    await this.chatMessageRepo.save(
                        this.chatMessageRepo.create({
                            consultationId: consultation.id,
                            role: MessageRole.ASSISTANT,
                            content: EMERGENCY_RESPONSE_MESSAGE,
                            metadata: { locked: true },
                        }),
                    );
                    this.logger.warn(
                        `OCR detected critical biomarker(s) — consultation ${consultation.id} locked (ocrResultId: ${ocrResultId})`,
                    );
                }
            }
        } catch (err: unknown) {
            // Explicit error handling with detailed logging
            const processingTimeMs = Date.now() - startTime;
            const errorDetails = this.buildErrorDetails(err);

            this.logger.error(
                `OCR job failed — ocrResultId: ${ocrResultId}, elapsed: ${processingTimeMs}ms`,
                {
                    errorType: errorDetails.type,
                    errorMessage: errorDetails.message,
                    errorCode: errorDetails.code,
                    stack: errorDetails.stack,
                },
            );

            // Persist detailed error info to DB
            await this.ocrResultRepo.update(ocrResultId, {
                status: OcrJobStatus.FAILED,
                errorMessage: errorDetails.userMessage,          // Public: shown to client
                internalErrorMessage: errorDetails.message,      // Internal: for debugging
                processingTimeMs,
            });
        } finally {
            // Cleanup: delete file after processing (success or failure)
            // Allows disk cleanup for local storage, automatic via S3 lifecycle for cloud
            try {
                const ocrResult = await this.ocrResultRepo.findOne({
                    where: { id: ocrResultId },
                });
                if (ocrResult?.imagePath) {
                    await this.storage.remove(ocrResult.imagePath);
                }
            } catch (cleanupErr) {
                this.logger.warn(`Cleanup failed for OCR job ${ocrResultId}: ${cleanupErr}`);
            }
        }
    }


    /**
     * Extracts structured error information for logging and DB storage.
     * Returns both detailed server-side info (for logs) and user-safe message (for DB).
     */
    private buildErrorDetails(err: unknown): {
        type: string;
        message: string;
        code?: string;
        stack?: string;
        userMessage: string;
    } {
        if (err instanceof Error) {
            const isAppException = (err as any).errorCode !== undefined;
            const code = isAppException ? (err as any).errorCode : 'UNKNOWN_ERROR';
            const stack = err.stack?.split('\n').slice(0, 3).join(' | ') || 'no stack';

            return {
                type: err.constructor.name,
                message: err.message,
                code,
                stack,
                userMessage: isAppException
                    ? (err as any).publicMessage.substring(0, 200)
                    : `[PROCESSING_ERROR] OCR processing failed: ${err.message.substring(0, 150)}`,
            };
        }

        const message = String(err);
        return {
            type: 'UnknownError',
            message,
            userMessage: `[UNKNOWN_ERROR] OCR processing encountered an unexpected error: ${message.substring(0, 150)}`,
        };
    }

    /**
     * Builds the Gemini Vision prompt for biomarker extraction.
     * Instructs the model to return structured JSON with detected lab values.
     */
    private buildOcrPrompt(base64Image: string, mimeType: string): Part[] {
        const textPrompt = `Eres un sistema de extracción de datos de laboratorio clínico.
Analiza la siguiente imagen de un examen de laboratorio y extrae TODOS los resultados visibles.

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura:
{
  "biomarkers": [
    {
      "name": "Nombre del biomarcador",
      "value": "resultado tal como aparece en el examen (numérico o textual)",
      "unit": "unidad de medida si aplica (mg/dL, mEq/L, etc.), o null si el resultado no tiene unidad",
      "referenceRange": "rango o valor de referencia si es visible",
      "flag": "normal | alto | bajo | anormal | critico — o null si no es determinable"
    }
  ],
  "labType": "tipo de examen (química sanguínea, hematología, uroanálisis, cultivo, etc.)",
  "labDate": "fecha del examen si es visible (ISO 8601)",
  "confidence": 0.0 a 1.0,
  "extractionNotes": "null si la extracción fue completa. Si extrajiste pocos o cero resultados, o partes del documento no se pudieron leer, explica aquí BREVEMENTE el motivo (imagen borrosa, documento cortado, texto ilegible, reflejo, etc.)"
}

REGLAS:
- Un biomarcador es CUALQUIER resultado reportado en el examen, sea numérico
  (ej. 14.5 g/dL) o cualitativo/textual (ej. "Negativo", "Trazas", un color, una
  descripción de cultivo). NUNCA descartes un resultado por no ser numérico:
  uroanálisis, coprológicos, cultivos y serologías son mayormente cualitativos
  y sus resultados deben extraerse igual que los numéricos.
- Extrae TODOS los resultados visibles, no solo los anormales.
- Las unidades de medida deben ser exactas (mg/dL, mEq/L, g/dL, etc.).
- Si no puedes leer un valor con certeza, omítelo y menciona en "extractionNotes" que hubo valores ilegibles.
- Si la imagen no es un examen de laboratorio, devuelve: { "biomarkers": [], "confidence": 0, "error": "No se detectó un examen de laboratorio", "extractionNotes": "describe qué contiene la imagen en su lugar" }
- NO inventes valores. Solo reporta lo que es VISIBLE en la imagen.`;

        return [
            { text: textPrompt },
            {
                inlineData: {
                    data: base64Image,
                    mimeType: mimeType
                }
            }
        ];
    }

    /**
     * Parses the raw Gemini response into structured biomarker data.
     * Throws on invalid JSON (caller handles failure) instead of silent fallback.
     */
    private parseBiomarkers(rawText: string): Record<string, any> {
        let cleaned = rawText.trim();
        if (cleaned.startsWith('```json')) {
            cleaned = cleaned.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        } else if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```\n?/, '').replace(/\n?```$/, '');
        }

        try {
            return JSON.parse(cleaned);
        } catch (parseErr) {
            // Throw explicit error so process() catch block can mark job as FAILED
            throw new Error(
                `[PARSE_ERROR] Gemini Vision response was not valid JSON: ${parseErr.message}`
            );
        }
    }
}
