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

    @OneToMany(() => ChatMessage, (message) => message.consultation, {
        cascade: true,
    })
    messages: ChatMessage[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
