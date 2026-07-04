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
        tokensUsed?: number;
        responseTimeMs?: number;
        // Operational diagnostics for the fallback path. Persisted so the reason a
        // consultation shows "servicio no disponible" is queryable from the DB,
        // without needing to grep server logs. Contains NO patient content (PHI).
        failure?: {
            errorKind: string;
        };
    };

    @CreateDateColumn()
    createdAt: Date;
}
