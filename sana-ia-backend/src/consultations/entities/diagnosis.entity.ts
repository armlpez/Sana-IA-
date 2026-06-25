import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Consultation } from './consultation.entity';
import { ConsultationStatus } from '../enums/consultation-status.enum';

/**
 * Immutable, append-only clinical record of a diagnosis emitted by the AI.
 *
 * One row is inserted every time the model emits a non-null diagnosis for a
 * consultation. Rows are NEVER updated or deleted — this preserves the full
 * reasoning trail for medical auditability. There is intentionally no
 * `updatedAt` column: immutability is part of the contract.
 *
 * The structured payload is stored verbatim in `payload` (jsonb) for fidelity,
 * while the clinically load-bearing fields are promoted to columns so they can
 * be queried/analyzed without cracking the JSON.
 *
 * The report reads the latest row with `statusAtEmit = 'completed'` for a
 * consultation.
 */
@Entity('diagnosis')
@Index(['consultationId', 'createdAt'])
export class Diagnosis {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    consultationId: number;

    @ManyToOne(() => Consultation, { eager: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'consultationId' })
    consultation: Consultation;

    @Column()
    userId: number;

    @ManyToOne(() => User, { eager: false })
    @JoinColumn({ name: 'userId' })
    user: User;

    /**
     * Consultation status at the moment this diagnosis was emitted.
     * Distinguishes a preliminary (analyzing) hypothesis from a final
     * (completed) conclusion.
     */
    @Column({
        type: 'enum',
        enum: ConsultationStatus,
    })
    statusAtEmit: ConsultationStatus;

    /** Promoted from payload — true when the model flagged a vital emergency. */
    @Column({ type: 'boolean', default: false })
    isEmergency: boolean;

    /** Promoted from payload — suggested medical specialist, if any. */
    @Column({ type: 'varchar', length: 255, nullable: true })
    suggestedSpecialist: string | null;

    /** Promoted from payload — model confidence (0-100), if provided. */
    @Column({ type: 'integer', nullable: true })
    confidenceLevel: number | null;

    /**
     * Full structured diagnosis payload as returned by the model
     * (rootCauseHypothesis, fiveWhysTrace, detectedBiomarkers, requiresHardData,
     * statusInconsistency, disclaimer, ...). Stored verbatim for fidelity.
     */
    @Column({ type: 'jsonb' })
    payload: Record<string, any>;

    @CreateDateColumn()
    createdAt: Date;
}
