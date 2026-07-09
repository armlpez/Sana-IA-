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
    /**
     * True when this consultation is locked by an emergency signal (this turn
     * or a prior one). Clients MUST use this field to decide whether to hide
     * the chat input — never infer it by matching `message` text.
     */
    isEmergency: boolean;
}
