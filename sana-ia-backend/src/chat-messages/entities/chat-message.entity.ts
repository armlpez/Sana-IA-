import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { Consultation } from '../../consultations/entities/consultation.entity';
import { MessageRole } from '../enums/message-role.enum';

@Entity('chat_message')
export class ChatMessage {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    consultationId: number;

    @ManyToOne(() => Consultation, (consultation) => consultation.messages, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'consultationId' })
    consultation: Consultation;

    @Column({
        type: 'enum',
        enum: MessageRole,
    })
    role: MessageRole;

    @Column({ type: 'text' })
    content: string;

    @Column({ type: 'jsonb', nullable: true })
    metadata: {
        model?: string;
        // Which provider in the fallback chain actually served this call (e.g. 'gemini', 'groq').
        provider?: string;
        tier?: string;
        // Total tokens (prompt + completion), as reported by the provider SDK.
        tokensUsed?: number;
        promptTokens?: number;
        completionTokens?: number;
        responseTimeMs?: number;
        // Operational diagnostics for the fallback path. Persisted so the reason a
        // consultation shows "servicio no disponible" is queryable from the DB,
        // without needing to grep server logs. Contains NO patient content (PHI).
        failure?: {
            errorKind: string;
            // Provider error message (sanitized, no PHI) — set by handleChatFailure
            errorMessage?: string;
            // Which LLM model finally broke the chain (e.g. 'cerebras'), and the
            // full ordered chain that was attempted (e.g. ['gemini','groq','cerebras']).
            // Provider names only — never PHI. Lets operators tell WHICH model failed
            // straight from the DB. Absent when the failure is not chain-related (e.g. PARSE).
            failedProvider?: string;
            attemptedProviders?: string[];
        };
    };

    @CreateDateColumn()
    createdAt: Date;
}
