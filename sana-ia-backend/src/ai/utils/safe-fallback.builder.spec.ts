import { SafeFallbackBuilder } from './safe-fallback.builder';
import { GeminiErrorKind } from './gemini-error-kind';
import { AiResponseSchema } from '../schemas/ai-response.schema';

describe('SafeFallbackBuilder', () => {
    describe('forAnalyze', () => {
        it('should return a Zod-valid response on parse failure', () => {
            const result = SafeFallbackBuilder.forAnalyze({
                emergencyDetected: null,
                kind: GeminiErrorKind.PARSE,
            });

            expect(result).toEqual(
                expect.objectContaining({
                    isEmergency: false,
                    requiresHardData: true,
                    confidenceLevel: 0,
                    disclaimer: expect.any(String),
                }),
            );

            // Must pass Zod validation — the schema contract is a safety invariant
            const validated = AiResponseSchema.parse(result);
            expect(validated).toBeDefined();
        });

        it('should preserve emergencyDetected=true in fallback', () => {
            const result = SafeFallbackBuilder.forAnalyze({
                emergencyDetected: true,
                kind: GeminiErrorKind.TIMEOUT,
            });

            expect(result.isEmergency).toBe(true);
        });

        it('should never hardcode isEmergency:false (the original bug)', () => {
            const kinds = [
                GeminiErrorKind.PARSE,
                GeminiErrorKind.TIMEOUT,
                GeminiErrorKind.UNAVAILABLE,
                GeminiErrorKind.RATE_LIMITED,
                GeminiErrorKind.POLICY_BLOCK,
                GeminiErrorKind.UNKNOWN,
            ];

            kinds.forEach((kind) => {
                const withEmergency = SafeFallbackBuilder.forAnalyze({
                    emergencyDetected: true,
                    kind,
                });
                expect(withEmergency.isEmergency).toBe(true);

                const withoutEmergency = SafeFallbackBuilder.forAnalyze({
                    emergencyDetected: false,
                    kind,
                });
                expect(withoutEmergency.isEmergency).toBe(false);
            });
        });

        it('should set isEmergency=false when emergencyDetected is null', () => {
            const result = SafeFallbackBuilder.forAnalyze({
                emergencyDetected: null,
                kind: GeminiErrorKind.TIMEOUT,
            });

            expect(result.isEmergency).toBe(false);
        });

        it('should never include PHI in the fallback response', () => {
            const result = SafeFallbackBuilder.forAnalyze({
                emergencyDetected: null,
                kind: GeminiErrorKind.PARSE,
            });

            const responseStr = JSON.stringify(result);
            expect(responseStr).not.toMatch(/symptom/i);
            expect(responseStr).not.toMatch(/treatment/i);
            expect(responseStr).not.toMatch(/diagnosis/i);
            expect(responseStr).not.toMatch(/patient/i);
        });

        it('should pass Zod validation for all error kinds', () => {
            const kinds = Object.values(GeminiErrorKind);

            kinds.forEach((kind) => {
                const result = SafeFallbackBuilder.forAnalyze({
                    emergencyDetected: false,
                    kind,
                });
                expect(() => AiResponseSchema.parse(result)).not.toThrow();
            });
        });
    });

    describe('forChat', () => {
        it('should recommend contacting a health professional when emergencyDetected=true', () => {
            const result = SafeFallbackBuilder.forChat({
                emergencyDetected: true,
                kind: GeminiErrorKind.PARSE,
            });

            // Softened wording (commit 19f85d0): no longer says "urgencias",
            // but must still escalate to a health professional out of caution.
            expect(result.message).toContain('profesional de la salud');
            expect(result.message).toContain('precaución');
        });

        it('should return neutral retry message when emergencyDetected=false', () => {
            const result = SafeFallbackBuilder.forChat({
                emergencyDetected: false,
                kind: GeminiErrorKind.TIMEOUT,
            });

            expect(result.message).not.toContain('urgencias');
            expect(result.message).toMatch(/intentá|reintent/i);
        });

        it('should return neutral retry message when emergencyDetected=null', () => {
            const result = SafeFallbackBuilder.forChat({
                emergencyDetected: null,
                kind: GeminiErrorKind.UNAVAILABLE,
            });

            expect(result.message).not.toContain('urgencias');
            expect(result.message).toContain('médico');
        });

        it('should never fabricate clinical content', () => {
            const result = SafeFallbackBuilder.forChat({
                emergencyDetected: null,
                kind: GeminiErrorKind.PARSE,
            });

            // Should not fabricate actual clinical content (diagnosis, conditions, diseases)
            // Note: 'análisis' is acceptable as it refers to the service, not clinical analysis
            expect(result.message).not.toMatch(/diagnosis|condición|enfermedad|tratamiento/i);
        });

        it('should always return null diagnosis and extractedData', () => {
            const kinds = Object.values(GeminiErrorKind);

            kinds.forEach((kind) => {
                const result = SafeFallbackBuilder.forChat({
                    emergencyDetected: false,
                    kind,
                });

                expect(result.diagnosis).toBeNull();
                expect(result.extractedData.symptoms).toBeNull();
                expect(result.extractedData.treatment).toBeNull();
                expect(result.extractedData.duration).toBeNull();
            });
        });
    });
});
