import { Injectable, Logger } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { AnalyzeInputDto } from './dto/analyze-input.dto';
import { AnalyzeResponseDto } from './dto/analyze-response.dto';
import { AiResponseSchema, AiResponseType } from './schemas/ai-response.schema';
import { SANA_SYSTEM_PROMPT, buildAnalysisPrompt } from './prompts/system-prompt';
import { ResilientLlmService } from './services/resilient-llm.service';
import { SafeFallbackBuilder } from './utils/safe-fallback.builder';
import { GeminiErrorKind } from './utils/gemini-error-kind';
import { classifyGeminiError } from './utils/error-classifier';
import { MODEL_TIER_PRO } from './config/model-tiers.config';
import { AppException } from '../common/exceptions/app-exception';
import { ErrorCode } from '../common/enums/error-codes.enum';

@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name);

    constructor(private readonly resilientLlm: ResilientLlmService) {}

    /**
     * Analyzes symptoms using the pro-tier Gemini model.
     *
     * On success: returns a Zod-validated AiResponseType.
     * On parse failure: returns SafeFallbackBuilder.forAnalyze (no rawText, no hardcoded isEmergency:false).
     * On Gemini terminal error: throws AppException (caught by GlobalExceptionFilter).
     *
     * analyzeSymptoms has no prior consultation context so emergencyDetected is always null here.
     */
    async analyzeSymptoms(input: AnalyzeInputDto): Promise<AnalyzeResponseDto> {
        const { symptoms, currentTreatment, durationWithoutImprovement } = input;

        this.logger.log('Starting symptom analysis...');
        const startTime = Date.now();

        const prompt = [SANA_SYSTEM_PROMPT, buildAnalysisPrompt(symptoms, currentTreatment, durationWithoutImprovement)].join('\n\n');

        // ResilientLlmService handles multi-provider fallback (Gemini → Groq → SafeFallback)
        // and timeout + retry + classification. If it throws, the error is an AppException.
        let rawText: string;
        try {
            const llmResult = await this.resilientLlm.generateWithFallback(MODEL_TIER_PRO, prompt);
            rawText = llmResult.text;
        } catch (err: unknown) {
            // Re-classify in case the inner service threw something unexpected
            const kind = err instanceof AppException
                ? GeminiErrorKind.UNKNOWN
                : classifyGeminiError(err);

            this.logger.error('Gemini terminal error during analyzeSymptoms', {
                errorKind: kind,
                elapsedMs: Date.now() - startTime,
            });

            // Return safe fallback rather than throwing on the analyze path
            // (no prior consultation context → emergencyDetected: null)
            return SafeFallbackBuilder.forAnalyze({ emergencyDetected: null, kind }) as AnalyzeResponseDto;
        }

        const responseTimeMs = Date.now() - startTime;

        // Parse and validate
        const parsed = this.parseAndValidateResponse(rawText, responseTimeMs);

        this.logger.log(`Analysis completed — emergency: ${parsed.isEmergency}, inconsistency: ${parsed.statusInconsistency}, elapsedMs: ${responseTimeMs}`);

        return parsed as AnalyzeResponseDto;
    }

    /**
     * Parses and Zod-validates the raw Gemini response text.
     *
     * On parse failure returns SafeFallbackBuilder.forAnalyze with PARSE kind.
     * PHI (rawText / patient content) is NEVER logged — only sanitized metadata.
     *
     * This resolves W-01 (no hardcoded isEmergency:false) and W-02 (no PHI in logs).
     */
    private parseAndValidateResponse(rawText: string, responseTimeMs: number): AiResponseType {
        try {
            let cleaned = rawText.trim();
            if (cleaned.startsWith('```json')) {
                cleaned = cleaned.replace(/^```json\n?/, '').replace(/\n?```$/, '');
            } else if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/^```\n?/, '').replace(/\n?```$/, '');
            }

            const jsonData = JSON.parse(cleaned);
            const validated = AiResponseSchema.parse(jsonData);

            return validated;
        } catch (error) {
            // Log only sanitized metadata — NEVER log rawText (PHI risk)
            this.logger.error('Failed to parse AI response', {
                errorMessage: (error as Error).message,
                responseTimeMs,
            });

            // SafeFallbackBuilder — no hardcoded isEmergency:false (W-01 resolved)
            // analyzeSymptoms has no consultation context so emergencyDetected is null
            return SafeFallbackBuilder.forAnalyze({
                emergencyDetected: null,
                kind: GeminiErrorKind.PARSE,
            });
        }
    }
}
