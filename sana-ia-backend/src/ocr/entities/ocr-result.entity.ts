import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Consultation } from '../../consultations/entities/consultation.entity';
import { OcrJobStatus } from '../enums/ocr-job-status.enum';

/**
 * Persists OCR job state and extracted biomarkers.
 *
 * PostgreSQL is the durable record for PHI — Redis only holds
 * ephemeral job coordination data (IDs, never image bytes or biomarkers).
 */
@Entity('ocr_result')
export class OcrResult {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: number;

    @ManyToOne(() => User, { eager: false })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ nullable: true })
    consultationId?: number;

    @ManyToOne(() => Consultation, (consultation) => consultation.ocrResults, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'consultationId' })
    consultation: Consultation;

    /**
     * Path or key to the uploaded lab image in secure storage.
     * The raw image is NEVER stored in Redis — only this reference.
     */
    @Column({ type: 'text' })
    imagePath: string;

    /**
     * Original filename uploaded by the patient (for display purposes only).
     */
    @Column({ type: 'varchar', length: 255, nullable: true })
    originalFilename: string;

    @Column({
        type: 'enum',
        enum: OcrJobStatus,
        default: OcrJobStatus.QUEUED,
    })
    status: OcrJobStatus;

    /**
     * Extracted biomarkers from the lab image.
     * Structure: { biomarkers: [{ name, value, unit, referenceRange, flag }] }
     *
     * Only populated after successful OCR processing.
     */
    @Column({ type: 'jsonb', nullable: true })
    extractedData: Record<string, any>;

    /**
     * Raw text extracted from the image before structured parsing.
     */
    @Column({ type: 'text', nullable: true })
    rawText: string;

    /**
     * Error message if processing failed (sanitized, no PHI).
     */
    @Column({ type: 'text', nullable: true })
    errorMessage: string;

    /**
     * Processing time in milliseconds (for observability).
     */
    @Column({ type: 'integer', nullable: true })
    processingTimeMs: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
