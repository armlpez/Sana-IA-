import { GeminiErrorKind } from './gemini-error-kind';
import { AiResponseType } from '../schemas/ai-response.schema';

/**
 * Shape returned on the chat fallback path.
 * Maps to a valid ChatResponseDto without rawText.
 * Status is passed through from the caller — fallbacks never change it.
 */
export interface ChatFallbackShape {
    message: string;
    diagnosis: null;
    extractedData: {
        symptoms: null;
        treatment: null;
        duration: null;
    };
}

export interface ForAnalyzeInput {
    /** Prior emergencyDetected value from the Consultation entity (null when no consultation context exists). */
    emergencyDetected: boolean | null;
    /** Kind of error that triggered the fallback. */
    kind: GeminiErrorKind;
}

export interface ForChatInput {
    /** Prior emergencyDetected value from the Consultation entity. */
    emergencyDetected: boolean | null;
    /** Kind of error that triggered the fallback. */
    kind: GeminiErrorKind;
}

/**
 * SafeFallbackBuilder — pure safety core for AI resilience.
 *
 * Rules (from design decision 4 / REQ-SAFE-2..4):
 *   - NEVER fabricate clinical content.
 *   - NEVER clear a prior emergencyDetected = true.
 *   - NEVER return rawText in any output field.
 *   - forAnalyze output must always pass AiResponseSchema.parse().
 *   - emergencyDetected === true → urgencias redirect; else → neutral retry.
 */
export class SafeFallbackBuilder {
    /**
     * Returns a Zod-valid AiResponseType for the analyze endpoint fallback path.
     *
     * Critically: isEmergency is set from the prior emergencyDetected flag,
     * NEVER hardcoded to false. A prior emergency signal is always preserved.
     */
    static forAnalyze(input: ForAnalyzeInput): AiResponseType {
        const { emergencyDetected } = input;

        return {
            statusInconsistency: false,
            detectedBiomarkers: [],
            rootCauseHypothesis:
                'No se pudo procesar la respuesta del sistema de análisis. Por favor, intentá de nuevo.',
            suggestedSpecialist: 'Medicina General',
            confidenceLevel: 0,
            requiresHardData: true,
            // Preserve prior emergency state — never override with false
            isEmergency: emergencyDetected === true,
            disclaimer:
                'Este análisis es REFERENCIAL y no sustituye la consulta médica profesional. ' +
                'Si tenés síntomas preocupantes, consultá a un médico de inmediato.',
            fiveWhysTrace: ['El servicio de análisis no está disponible en este momento.'],
        };
    }

    /**
     * Returns a safe chat fallback object.
     *
     * When emergencyDetected is true → urgencias redirect.
     * Otherwise → neutral retry message.
     *
     * rawText is NEVER present in the output (REQ-SAFE-4).
     */
    static forChat(input: ForChatInput): ChatFallbackShape {
        const { emergencyDetected } = input;

        const message =
            emergencyDetected === true
                ? 'Acudí a urgencias de inmediato. Dado que previamente detectamos señales de emergencia, no podemos darte orientación adicional en este momento.'
                : 'Nuestro sistema de análisis no está disponible en este momento. Si tenés síntomas preocupantes, consultá a un médico. Por favor, intentá de nuevo en unos minutos.';

        return {
            message,
            diagnosis: null,
            extractedData: {
                symptoms: null,
                treatment: null,
                duration: null,
            },
        };
    }
}
