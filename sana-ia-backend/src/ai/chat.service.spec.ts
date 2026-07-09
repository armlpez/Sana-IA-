import { ChatService } from './chat.service';
import { Repository } from 'typeorm';
import { Consultation } from '../consultations/entities/consultation.entity';
import { ChatMessage } from '../chat-messages/entities/chat-message.entity';
import { Diagnosis } from '../consultations/entities/diagnosis.entity';

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Builds the LlmGenerationResult (+provider) shape returned by ResilientLlmService.generateWithFallback. */
function llmResult(text: string) {
    return { text, usage: ZERO_USAGE, model: 'test-model', provider: 'gemini' };
}

describe('ChatService — Emergency Latch', () => {
    let chatService: ChatService;
    let consultationRepo: Repository<Consultation>;
    let chatMessageRepo: Repository<ChatMessage>;
    let resilientLlmService: any;
    let diagnosisRepo: Repository<Diagnosis>;

    beforeEach(() => {
        consultationRepo = {
            findOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            save: jest.fn(),
        } as any;

        chatMessageRepo = {
            create: jest.fn(),
            save: jest.fn(),
        } as any;

        resilientLlmService = {
            generateWithFallback: jest.fn(),
        };

        diagnosisRepo = {
            create: jest.fn((entity) => entity),
            save: jest.fn(),
        } as any;

        chatService = new ChatService(
            consultationRepo,
            chatMessageRepo,
            resilientLlmService,
            diagnosisRepo,
        );
    });

    it('should persist emergencyDetected=true when emergency is detected', async () => {
        const consultation = {
            id: 1,
            patientId: 100,
            status: 'analyzing',
            emergencyDetected: false,
            summary: '{}',
        };

        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultation);
        (consultationRepo.save as jest.Mock).mockResolvedValue(consultation);
        (chatMessageRepo.create as jest.Mock).mockReturnValue({});
        (chatMessageRepo.save as jest.Mock).mockResolvedValue({});

        // Simula respuesta estructurada JSON de Gemini que indica emergencia
        resilientLlmService.generateWithFallback.mockResolvedValue(
            llmResult(JSON.stringify({
                message: 'Vaya a urgencias',
                diagnosis: {
                    isEmergency: true,
                    rootCauseHypothesis: 'Posible evento cardíaco',
                }
            })),
        );

        await chatService.sendMessage(100, { consultationId: 1, message: 'me duele el pecho' });

        // Verifica que se haya llamado update con emergencyDetected: true
        expect(consultationRepo.update).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ emergencyDetected: true })
        );
    });

    it('should persist the diagnosis as an append-only record when present', async () => {
        const consultation = {
            id: 7,
            userId: 100,
            status: 'analyzing',
            emergencyDetected: false,
            summary: '{}',
        };

        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultation);
        (chatMessageRepo.create as jest.Mock).mockReturnValue({});
        (chatMessageRepo.save as jest.Mock).mockResolvedValue({});

        resilientLlmService.generateWithFallback.mockResolvedValue(
            llmResult(JSON.stringify({
                message: 'Te derivo a endocrinología',
                status: 'completed',
                diagnosis: {
                    isEmergency: false,
                    rootCauseHypothesis: 'Hiperaldosteronismo primario',
                    suggestedSpecialist: 'Endocrinología',
                    confidenceLevel: 88,
                },
            })),
        );

        await chatService.sendMessage(100, { conversationId: 7, message: 'orino mucho de noche' });

        // A Diagnosis row is inserted with promoted fields extracted from the payload.
        expect(diagnosisRepo.save).toHaveBeenCalledTimes(1);
        expect(diagnosisRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                consultationId: 7,
                userId: 100,
                statusAtEmit: 'completed',
                isEmergency: false,
                suggestedSpecialist: 'Endocrinología',
                confidenceLevel: 88,
            }),
        );
    });

    it('should NOT persist a diagnosis when the model emits none', async () => {
        const consultation = {
            id: 8,
            userId: 100,
            status: 'collecting',
            emergencyDetected: false,
            summary: '{}',
        };

        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultation);
        (chatMessageRepo.create as jest.Mock).mockReturnValue({});
        (chatMessageRepo.save as jest.Mock).mockResolvedValue({});

        resilientLlmService.generateWithFallback.mockResolvedValue(
            llmResult(JSON.stringify({
                message: '¿Hace cuánto tenés los síntomas?',
                status: 'collecting',
                diagnosis: null,
            })),
        );

        await chatService.sendMessage(100, { conversationId: 8, message: 'me duele la cabeza' });

        expect(diagnosisRepo.save).not.toHaveBeenCalled();
    });

    it('persists the failed model + attempted chain into the fallback message metadata', async () => {
        const consultation = {
            id: 42,
            userId: 100,
            status: 'collecting',
            emergencyDetected: false,
            summary: '{}',
        };

        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultation);
        // Echo back what the service builds so we can assert on the metadata.
        (chatMessageRepo.create as jest.Mock).mockImplementation((entity) => entity);
        (chatMessageRepo.save as jest.Mock).mockResolvedValue({});

        // The resilient chain exhausted all providers — the thrown error carries
        // the diagnostics that getLlmFailureDiagnostics() reads.
        const chainError: any = new Error('all providers failed');
        chainError.llmDiagnostics = {
            attemptedProviders: ['gemini', 'groq', 'cerebras'],
            failedProvider: 'cerebras',
        };
        resilientLlmService.generateWithFallback.mockRejectedValue(chainError);

        await chatService.sendMessage(100, { conversationId: 42, message: 'hola' });

        // The assistant fallback message must record WHICH model failed.
        expect(chatMessageRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    failure: expect.objectContaining({
                        failedProvider: 'cerebras',
                        attemptedProviders: ['gemini', 'groq', 'cerebras'],
                    }),
                }),
            }),
        );
    });

    it('should never reset emergencyDetected back to false', async () => {
        const consultation = {
            id: 1,
            patientId: 100,
            status: 'analyzing',
            emergencyDetected: true, // Ya estaba en true
            summary: '{}',
        };

        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultation);
        (consultationRepo.save as jest.Mock).mockResolvedValue(consultation);
        (chatMessageRepo.create as jest.Mock).mockReturnValue({});
        (chatMessageRepo.save as jest.Mock).mockResolvedValue({});

        // Simula respuesta de Gemini que dice que NO es emergencia
        resilientLlmService.generateWithFallback.mockResolvedValue(
            llmResult(JSON.stringify({
                message: 'Tómate un antiácido',
                diagnosis: {
                    isEmergency: false,
                    rootCauseHypothesis: 'Parece acidez',
                }
            })),
        );

        await chatService.sendMessage(100, { consultationId: 1, message: 'me duele un poco' });

        // Verifica que NO se haya intentado actualizar a false.
        // Solo actualizamos el status o no hacemos update del emergency flag.
        expect(consultationRepo.update).not.toHaveBeenCalledWith(
            1,
            expect.objectContaining({ emergencyDetected: false })
        );
    });
});

describe('ChatService — Anti-Repetition Progress (askedTopics)', () => {
    let chatService: ChatService;
    let consultationRepo: Repository<Consultation>;
    let chatMessageRepo: Repository<ChatMessage>;
    let resilientLlmService: any;
    let diagnosisRepo: Repository<Diagnosis>;

    beforeEach(() => {
        consultationRepo = {
            findOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            save: jest.fn(),
        } as any;

        chatMessageRepo = {
            create: jest.fn().mockReturnValue({}),
            save: jest.fn().mockResolvedValue({}),
        } as any;

        resilientLlmService = {
            generateWithFallback: jest.fn(),
        };

        diagnosisRepo = {
            create: jest.fn((entity) => entity),
            save: jest.fn(),
        } as any;

        chatService = new ChatService(
            consultationRepo,
            chatMessageRepo,
            resilientLlmService,
            diagnosisRepo,
        );
    });

    /** Minimal collecting consultation; override fields per test. */
    function consultationWith(overrides: Record<string, unknown> = {}) {
        return {
            id: 10,
            userId: 100,
            status: 'collecting',
            emergencyDetected: false,
            summary: null,
            askedTopics: [],
            ...overrides,
        };
    }

    function mockLlmReply(payload: Record<string, unknown>) {
        resilientLlmService.generateWithFallback.mockResolvedValue(
            llmResult(JSON.stringify({ message: 'ok', status: 'collecting', diagnosis: null, ...payload })),
        );
    }

    it('injects [Progreso de la consulta] with "ninguno aún" from turn 1 (no summary yet)', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultationWith());
        mockLlmReply({});

        await chatService.sendMessage(100, { conversationId: 10, message: 'hola' });

        const prompt = resilientLlmService.generateWithFallback.mock.calls[0][1] as string;
        expect(prompt).toContain('[Progreso de la consulta]');
        expect(prompt).toContain('Temas ya cubiertos: ninguno aún');
        expect(prompt).toContain('Última pregunta realizada: —');
        // The progress block must come BEFORE the patient message
        expect(prompt.indexOf('[Progreso de la consulta]')).toBeLessThan(prompt.indexOf('[Mensaje del paciente]'));
    });

    it('lists accumulated topics and last asked topic in the progress block', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({ askedTopics: ['síntomas', 'duración'] }),
        );
        mockLlmReply({});

        await chatService.sendMessage(100, { conversationId: 10, message: 'sigo igual' });

        const prompt = resilientLlmService.generateWithFallback.mock.calls[0][1] as string;
        expect(prompt).toContain('Temas ya cubiertos: síntomas, duración');
        expect(prompt).toContain('Última pregunta realizada: duración');
    });

    it('marks laboratorios as covered via OCR results even if never asked (D14)', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({
                askedTopics: ['síntomas'],
                ocrResults: [
                    { status: 'completed', extractedData: { biomarkers: [{ name: 'Glucosa', value: '110' }] } },
                ],
            }),
        );
        mockLlmReply({});

        await chatService.sendMessage(100, { conversationId: 10, message: 'subí mis análisis' });

        const prompt = resilientLlmService.generateWithFallback.mock.calls[0][1] as string;
        expect(prompt).toContain('Temas ya cubiertos: síntomas, laboratorios/estudios');
        // OCR coverage is computed, not persisted: last asked stays from askedTopics
        expect(prompt).toContain('Última pregunta realizada: síntomas');
    });

    it('accumulates a NEW topic when the LLM reports topicAsked', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({ askedTopics: ['síntomas'] }),
        );
        mockLlmReply({ topicAsked: 'AUTOMEDICACION' });

        await chatService.sendMessage(100, { conversationId: 10, message: 'no tomé nada' });

        expect(consultationRepo.update).toHaveBeenCalledWith(
            10,
            expect.objectContaining({ askedTopics: ['síntomas', 'automedicación'] }),
        );
    });

    it('does NOT duplicate a topic already covered', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({ askedTopics: ['automedicación'] }),
        );
        mockLlmReply({ topicAsked: 'AUTOMEDICACION' });

        await chatService.sendMessage(100, { conversationId: 10, message: 'ya te dije que no' });

        const updateCalls = (consultationRepo.update as jest.Mock).mock.calls;
        for (const [, payload] of updateCalls) {
            expect(payload).not.toHaveProperty('askedTopics');
        }
    });

    it('a turn with topicAsked=null does NOT consume clinical progress', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({ askedTopics: ['síntomas'] }),
        );
        mockLlmReply({ topicAsked: null });

        await chatService.sendMessage(100, { conversationId: 10, message: 'perdón, me equivoqué' });

        const updateCalls = (consultationRepo.update as jest.Mock).mock.calls;
        for (const [, payload] of updateCalls) {
            expect(payload).not.toHaveProperty('askedTopics');
        }
    });

    it('rejects free-text/invalid topicAsked values (only enum keys accumulate)', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultationWith());
        mockLlmReply({ topicAsked: 'pregunté sobre medicamentos' });

        await chatService.sendMessage(100, { conversationId: 10, message: 'hola' });

        const updateCalls = (consultationRepo.update as jest.Mock).mock.calls;
        for (const [, payload] of updateCalls) {
            expect(payload).not.toHaveProperty('askedTopics');
        }
    });

    it('marks a topic covered from extracted data even if never in askedTopics (spontaneous info)', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({
                askedTopics: [],
                extractedDuration: 'aprox. 24 horas',
                extractedTreatment: 'ibuprofeno anoche',
            }),
        );
        mockLlmReply({});

        await chatService.sendMessage(100, { conversationId: 10, message: 'sigo con dolor' });

        const prompt = resilientLlmService.generateWithFallback.mock.calls[0][1] as string;
        expect(prompt).toContain('Temas ya cubiertos: duración, automedicación');
    });

    it('flags labs as "asked but not provided" instead of silently allowing a re-ask', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({ askedTopics: ['laboratorios/estudios'], ocrResults: [] }),
        );
        mockLlmReply({});

        await chatService.sendMessage(100, { conversationId: 10, message: 'no tengo estudios' });

        const prompt = resilientLlmService.generateWithFallback.mock.calls[0][1] as string;
        expect(prompt).toContain('Laboratorios: ya solicitados, el paciente no los aportó');
    });

    it('does NOT flag labs as pending when OCR biomarkers already cover them', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({
                askedTopics: ['laboratorios/estudios'],
                ocrResults: [
                    { status: 'completed', extractedData: { biomarkers: [{ name: 'Glucosa', value: '110' }] } },
                ],
            }),
        );
        mockLlmReply({});

        await chatService.sendMessage(100, { conversationId: 10, message: 'ahí subí mis análisis' });

        const prompt = resilientLlmService.generateWithFallback.mock.calls[0][1] as string;
        expect(prompt).not.toContain('ya solicitados, el paciente no los aportó');
    });
});

describe('ChatService — Emergency Escalation & Lock', () => {
    let chatService: ChatService;
    let consultationRepo: Repository<Consultation>;
    let chatMessageRepo: Repository<ChatMessage>;
    let resilientLlmService: any;
    let diagnosisRepo: Repository<Diagnosis>;

    beforeEach(() => {
        consultationRepo = {
            findOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            save: jest.fn(),
        } as any;

        chatMessageRepo = {
            create: jest.fn((entity) => entity),
            save: jest.fn().mockResolvedValue({}),
        } as any;

        resilientLlmService = {
            generateWithFallback: jest.fn(),
        };

        diagnosisRepo = {
            create: jest.fn((entity) => entity),
            save: jest.fn(),
        } as any;

        chatService = new ChatService(
            consultationRepo,
            chatMessageRepo,
            resilientLlmService,
            diagnosisRepo,
        );
    });

    function consultationWith(overrides: Record<string, unknown> = {}) {
        return {
            id: 20,
            userId: 100,
            status: 'collecting',
            emergencyDetected: false,
            summary: null,
            askedTopics: [],
            ...overrides,
        };
    }

    it('never calls the LLM when the consultation is already locked by a prior emergency', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({ emergencyDetected: true }),
        );

        const result = await chatService.sendMessage(100, { conversationId: 20, message: 'sigo con dolor' });

        expect(resilientLlmService.generateWithFallback).not.toHaveBeenCalled();
        expect(result.message).toContain('riesgo crítico y urgente');
        expect(result.status).toBe('completed');
        // The locked re-serve is persisted as its own assistant message (audit trail).
        expect(chatMessageRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: { locked: true } }),
        );
    });

    it('still persists the incoming user message on a locked consultation (audit trail)', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(
            consultationWith({ emergencyDetected: true }),
        );

        await chatService.sendMessage(100, { conversationId: 20, message: 'hola de nuevo' });

        expect(chatMessageRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ role: 'user', content: 'hola de nuevo' }),
        );
    });

    it('overrides the LLM message with the fixed protocol when isEmergency=true mid-collection', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultationWith());
        resilientLlmService.generateWithFallback.mockResolvedValue(
            llmResult(JSON.stringify({
                message: 'texto libre que la IA haya redactado',
                status: 'collecting',
                isEmergency: true,
                diagnosis: null,
            })),
        );

        const result = await chatService.sendMessage(100, { conversationId: 20, message: 'dolor de pecho irradiado' });

        expect(result.message).toContain('riesgo crítico y urgente');
        expect(result.message).not.toContain('texto libre que la IA haya redactado');
        expect(result.status).toBe('completed');
    });

    it('latches emergencyDetected=true when isEmergency fires from collecting/analyzing (not just diagnosis)', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultationWith());
        resilientLlmService.generateWithFallback.mockResolvedValue(
            llmResult(JSON.stringify({
                message: 'x',
                status: 'analyzing',
                isEmergency: true,
                diagnosis: null,
            })),
        );

        await chatService.sendMessage(100, { conversationId: 20, message: 'dificultad para respirar' });

        expect(consultationRepo.update).toHaveBeenCalledWith(
            20,
            expect.objectContaining({ emergencyDetected: true, status: 'completed' }),
        );
    });

    it('does NOT override the message or lock when isEmergency is absent/false', async () => {
        (consultationRepo.findOne as jest.Mock).mockResolvedValue(consultationWith());
        resilientLlmService.generateWithFallback.mockResolvedValue(
            llmResult(JSON.stringify({
                message: '¿hace cuánto tenés el dolor?',
                status: 'collecting',
                diagnosis: null,
            })),
        );

        const result = await chatService.sendMessage(100, { conversationId: 20, message: 'me duele la panza' });

        expect(result.message).toBe('¿hace cuánto tenés el dolor?');
        const updateCalls = (consultationRepo.update as jest.Mock).mock.calls;
        for (const [, payload] of updateCalls) {
            expect(payload).not.toHaveProperty('emergencyDetected', true);
        }
    });
});
