import { ChatService } from './chat.service';
import { Repository } from 'typeorm';
import { Consultation } from '../consultations/entities/consultation.entity';
import { ChatMessage } from '../chat-messages/entities/chat-message.entity';
import { Diagnosis } from '../consultations/entities/diagnosis.entity';

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
            JSON.stringify({
                message: 'Vaya a urgencias',
                diagnosis: {
                    isEmergency: true,
                    rootCauseHypothesis: 'Posible evento cardíaco',
                }
            })
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
            JSON.stringify({
                message: 'Te derivo a endocrinología',
                status: 'completed',
                diagnosis: {
                    isEmergency: false,
                    rootCauseHypothesis: 'Hiperaldosteronismo primario',
                    suggestedSpecialist: 'Endocrinología',
                    confidenceLevel: 88,
                },
            }),
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
            JSON.stringify({
                message: '¿Hace cuánto tenés los síntomas?',
                status: 'collecting',
                diagnosis: null,
            }),
        );

        await chatService.sendMessage(100, { conversationId: 8, message: 'me duele la cabeza' });

        expect(diagnosisRepo.save).not.toHaveBeenCalled();
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
            JSON.stringify({
                message: 'Tómate un antiácido',
                diagnosis: {
                    isEmergency: false,
                    rootCauseHypothesis: 'Parece acidez',
                }
            })
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
