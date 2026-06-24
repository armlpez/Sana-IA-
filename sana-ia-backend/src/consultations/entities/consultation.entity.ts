import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToMany,
    JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ChatMessage } from '../../chat-messages/entities/chat-message.entity';
import { ConsultationStatus } from '../enums/consultation-status.enum';

@Entity('consultation')
export class Consultation {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    userId: number;

    @ManyToOne(() => User, { eager: false })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ type: 'varchar', length: 255, nullable: true })
    title: string;

    @Column({ type: 'text', nullable: true })
    extractedSymptoms: string;

    @Column({ type: 'text', nullable: true })
    extractedTreatment: string;

    @Column({ type: 'text', nullable: true })
    extractedDuration: string;

    @Column({ type: 'jsonb', nullable: true })
    summary: Record<string, any>;

    @Column({
        type: 'enum',
        enum: ConsultationStatus,
        default: ConsultationStatus.COLLECTING,
    })
    status: ConsultationStatus;

    /**
     * Latched emergency flag — once set to true by a successful AI parse,
     * it is NEVER cleared back to false. Used by SafeFallbackBuilder to
     * preserve prior emergency signals even when the current AI turn fails.
     */
    @Column({ type: 'boolean', default: false, nullable: true })
    emergencyDetected: boolean;

    @OneToMany(() => ChatMessage, (message) => message.consultation, {
        cascade: true,
    })
    messages: ChatMessage[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
