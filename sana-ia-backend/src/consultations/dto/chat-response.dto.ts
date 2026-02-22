export class ChatResponseDto {
    conversationId: number;
    message: string;
    summary: Record<string, any> | null;
    status: string;
    extractedData: {
        symptoms: string | null;
        treatment: string | null;
        duration: string | null;
    };
    diagnosis?: Record<string, any> | null;
}
