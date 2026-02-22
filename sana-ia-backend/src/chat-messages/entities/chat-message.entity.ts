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
    };

    @CreateDateColumn()
    createdAt: Date;
}
