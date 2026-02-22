import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { AnalyzeInputDto } from './dto/analyze-input.dto';
import { AnalyzeResponseDto } from './dto/analyze-response.dto';
import { AiResponseSchema, AiResponseType } from './schemas/ai-response.schema';
import { SANA_SYSTEM_PROMPT, buildAnalysisPrompt } from './prompts/system-prompt';

@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name);
    private readonly model: GenerativeModel;
    private readonly genAI: GoogleGenerativeAI;

    constructor(private configService: ConfigService) {
        const apiKey = this.configService.get<string>('GEMINI_API_KEY');
        const modelName = this.configService.get<string>('GEMINI_MODEL') || 'gemini-1.5-pro';

        if (!apiKey) {
            this.logger.warn('GEMINI_API_KEY no está configurada en .env. El módulo de IA no funcionará.');
            return;
        }

        try {
            this.genAI = new GoogleGenerativeAI(apiKey);
            this.model = this.genAI.getGenerativeModel({
                model: modelName,
                systemInstruction: SANA_SYSTEM_PROMPT,
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.3,
                },
            });
            this.logger.log(`AiService initialized with model: ${modelName}`);
        } catch (error) {
            this.logger.error(`Error initializing Gemini: ${error.message}`);
        }
    }

    async analyzeSymptoms(input: AnalyzeInputDto): Promise<AnalyzeResponseDto> {
        if (!this.model) {
            throw new InternalServerErrorException('El servicio de IA no está configurado (Falta GEMINI_API_KEY)');
        }

        const { symptoms, currentTreatment, durationWithoutImprovement } = input;

        this.logger.log('Starting symptom analysis...');

        try {
            const prompt = buildAnalysisPrompt(
                symptoms,
                currentTreatment,
                durationWithoutImprovement,
            );

            const result = await this.model.generateContent(prompt);
            const response = result.response;
            const rawText = response.text();

            this.logger.debug(`Raw AI response: ${rawText}`);

            // Parse and validate with Zod
            const parsed = this.parseAndValidateResponse(rawText);

            this.logger.log(`Analysis completed. Emergency: ${parsed.isEmergency}, Inconsistency: ${parsed.statusInconsistency}`);

            return parsed as AnalyzeResponseDto;
        } catch (error) {
            this.logger.error(`Error during symptom analysis: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Error al procesar el análisis de síntomas');
        }
    }

    private parseAndValidateResponse(rawText: string): AiResponseType {
        try {
            // Clean the response if it has markdown code blocks
            let cleanedText = rawText.trim();
            if (cleanedText.startsWith('```json')) {
                cleanedText = cleanedText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
            } else if (cleanedText.startsWith('```')) {
                cleanedText = cleanedText.replace(/^```\n?/, '').replace(/\n?```$/, '');
            }

            const jsonData = JSON.parse(cleanedText);
            const validated = AiResponseSchema.parse(jsonData);

            return validated;
        } catch (error) {
            this.logger.error(`Failed to parse AI response: ${error.message}`);
            this.logger.debug(`Raw text was: ${rawText}`);

            // Return a safe fallback response
            return {
                statusInconsistency: false,
                detectedBiomarkers: [],
                rootCauseHypothesis: 'No se pudo procesar la respuesta del sistema de IA',
                suggestedSpecialist: 'Medicina General',
                confidenceLevel: 0,
                requiresHardData: true,
                isEmergency: false,
                disclaimer: 'Este análisis es REFERENCIAL y no sustituye la consulta médica profesional.',
                fiveWhysTrace: ['Error en procesamiento'],
            };
        }
    }
}
