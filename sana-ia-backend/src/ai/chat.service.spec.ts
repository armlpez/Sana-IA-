import { ChatService } from './chat.service';
import { Repository } from 'typeorm';
import { Consultation } from '../consultations/entities/consultation.entity';
import { ChatMessage } from '../chat-messages/entities/chat-message.entity';

describe('ChatService — Emergency Latch', () => {
    let chatService: ChatService;
    let consultationRepo: Repository<Consultation>;
    let chatMessageRepo: Repository<ChatMessage>;
    let geminiClientService: any;
    let aiService: any;

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

        geminiClientService = {
            generateWithResilience: jest.fn(),
        };

        aiService = {};

        chatService = new ChatService(
            consultationRepo,
            chatMessageRepo,
            geminiClientService,
            aiService,
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
        geminiClientService.generateWithResilience.mockResolvedValue(
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
        geminiClientService.generateWithResilience.mockResolvedValue(
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
