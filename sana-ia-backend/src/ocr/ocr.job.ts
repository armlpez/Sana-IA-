/**
 * Typed payload for OCR jobs in BullMQ.
 *
 * CRITICAL: This is what travels through Redis.
 * It must contain ONLY reference IDs — never image bytes,
 * biomarker values, patient names, or any PHI.
 */
export interface OcrJobPayload {
    /** UUID of the OcrResult row in PostgreSQL */
    ocrResultId: string;

    /** User who submitted the job (for logging, not PHI) */
    userId: number;

    /** ISO timestamp of when the job was requested */
    requestedAt: string;
}

/** BullMQ queue name constant */
export const OCR_QUEUE_NAME = 'ocr';
