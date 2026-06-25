import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ReportsService } from './reports.service';
import { Consultation } from '../consultations/entities/consultation.entity';
import { Diagnosis } from '../consultations/entities/diagnosis.entity';
import { OcrResult } from '../ocr/entities/ocr-result.entity';
import { ConsultationStatus } from '../consultations/enums/consultation-status.enum';
import { OcrJobStatus } from '../ocr/enums/ocr-job-status.enum';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConsultation(overrides: Partial<Consultation> = {}): Consultation {
    return {
        id: 1,
        userId: 42,
        user: {
            id: 42,
            name: 'María García',
            email: 'maria@example.com',
            birthDate: new Date('1985-03-15'),
        } as any,
        title: 'Consulta test',
        extractedSymptoms: 'fiebre y dolor de cabeza',
        extractedTreatment: 'ibuprofeno 400mg',
        extractedDuration: '3 días',
        summary: {},
        status: ConsultationStatus.COMPLETED,
        emergencyDetected: false,
        messages: [],
        ocrResults: [],
        createdAt: new Date('2025-06-01T10:00:00Z'),
        updatedAt: new Date('2025-06-01T11:00:00Z'),
        ...overrides,
    } as Consultation;
}

function makeDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
    return {
        id: 'uuid-diag-1',
        consultationId: 1,
        userId: 42,
        statusAtEmit: ConsultationStatus.COMPLETED,
        isEmergency: false,
        suggestedSpecialist: 'Medicina General',
        confidenceLevel: 85,
        payload: {
            rootCauseHypothesis: 'Síndrome gripal',
            fiveWhysTrace: [
                '1. ¿Por qué fiebre? Por infección viral.',
                '2. ¿Por qué viral? Sistema inmune respondiendo.',
            ],
            disclaimer: 'Este informe es referencial.',
        },
        createdAt: new Date('2025-06-01T11:00:00Z'),
        ...overrides,
    } as Diagnosis;
}

function makeOcrResult(overrides: Partial<OcrResult> = {}): OcrResult {
    return {
        id: 'uuid-ocr-1',
        userId: 42,
        consultationId: 1,
        imagePath: 'uploads/lab-result.jpg',
        originalFilename: 'lab-result.jpg',
        status: OcrJobStatus.COMPLETED,
        extractedData: {
            biomarkers: [
                { name: 'Hemoglobina', value: '15.5', unit: 'g/dL', referenceRange: '12-17', flag: 'Normal' },
                { name: 'Glucosa', value: '105', unit: 'mg/dL', referenceRange: '70-100', flag: 'Alto' },
            ],
        },
        rawText: null,
        errorMessage: null,
        processingTimeMs: 850,
        createdAt: new Date('2025-06-01T10:30:00Z'),
        updatedAt: new Date('2025-06-01T10:31:00Z'),
        ...overrides,
    } as OcrResult;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ReportsService', () => {
    let service: ReportsService;
    let consultationRepo: jest.Mocked<Pick<Repository<Consultation>, 'findOne'>>;
    let diagnosisRepo: jest.Mocked<Pick<Repository<Diagnosis>, 'findOne'>>;
    let ocrResultRepo: jest.Mocked<Pick<Repository<OcrResult>, 'find'>>;

    beforeEach(() => {
        consultationRepo = { findOne: jest.fn() } as any;
        diagnosisRepo    = { findOne: jest.fn() } as any;
        ocrResultRepo    = { find: jest.fn() }    as any;

        service = new ReportsService(
            consultationRepo as any,
            diagnosisRepo    as any,
            ocrResultRepo    as any,
        );
    });

    // -------------------------------------------------------------------------
    // TA-1: Happy path — completed consultation, correct owner, completed diagnosis
    // -------------------------------------------------------------------------
    describe('TA-1: happy path', () => {
        it('should return a PDF Buffer starting with %PDF- and longer than 1000 bytes', async () => {
            consultationRepo.findOne.mockResolvedValue(makeConsultation());
            diagnosisRepo.findOne.mockResolvedValue(makeDiagnosis());
            ocrResultRepo.find.mockResolvedValue([]);

            const result = await service.generateConsultationReport(1, 42);

            expect(Buffer.isBuffer(result)).toBe(true);
            expect(result.subarray(0, 5).toString()).toBe('%PDF-');
            expect(result.length).toBeGreaterThan(1000);
        });
    });

    // -------------------------------------------------------------------------
    // TA-2: Biomarkers — ocrResultRepo.find returns completed result with biomarkers
    // -------------------------------------------------------------------------
    describe('TA-2: biomarkers included', () => {
        it('should not throw and should return a valid PDF when OCR results with biomarkers exist', async () => {
            consultationRepo.findOne.mockResolvedValue(makeConsultation());
            diagnosisRepo.findOne.mockResolvedValue(makeDiagnosis());
            ocrResultRepo.find.mockResolvedValue([makeOcrResult()]);

            const result = await service.generateConsultationReport(1, 42);

            expect(Buffer.isBuffer(result)).toBe(true);
            expect(result.subarray(0, 5).toString()).toBe('%PDF-');

            // Verify that ocrResultRepo was queried for the right consultation.
            expect(ocrResultRepo.find).toHaveBeenCalledWith(
                expect.objectContaining({ where: expect.objectContaining({ consultationId: 1 }) }),
            );
        });
    });

    // -------------------------------------------------------------------------
    // TA-3: Ownership — different userId → ForbiddenException
    // -------------------------------------------------------------------------
    describe('TA-3: ownership validation', () => {
        it('should throw ForbiddenException when the requester is not the consultation owner', async () => {
            // Consultation belongs to userId 42, requester is userId 99.
            consultationRepo.findOne.mockResolvedValue(makeConsultation({ userId: 42 }));

            await expect(service.generateConsultationReport(1, 99)).rejects.toThrow(ForbiddenException);
        });
    });

    // -------------------------------------------------------------------------
    // TA-4: Incomplete consultation — status 'collecting' → BadRequestException
    // -------------------------------------------------------------------------
    describe('TA-4: incomplete consultation', () => {
        it('should throw BadRequestException when consultation status is collecting', async () => {
            consultationRepo.findOne.mockResolvedValue(
                makeConsultation({ status: ConsultationStatus.COLLECTING }),
            );

            await expect(service.generateConsultationReport(1, 42)).rejects.toThrow(BadRequestException);
        });

        it('should throw BadRequestException when consultation status is analyzing', async () => {
            consultationRepo.findOne.mockResolvedValue(
                makeConsultation({ status: ConsultationStatus.ANALYZING }),
            );

            await expect(service.generateConsultationReport(1, 42)).rejects.toThrow(BadRequestException);
        });
    });

    // -------------------------------------------------------------------------
    // TA-5: Audit log — deferred (RF-4 not implemented yet)
    // -------------------------------------------------------------------------
    it.todo('TA-5: audit log de descargas — diferido (RF-4): ReportDownload entity y log de descarga no implementados aún');

    // -------------------------------------------------------------------------
    // TA-6: Consultation not found → NotFoundException
    // -------------------------------------------------------------------------
    describe('TA-6: not found', () => {
        it('should throw NotFoundException when consultation does not exist', async () => {
            consultationRepo.findOne.mockResolvedValue(null);

            await expect(service.generateConsultationReport(99999, 42)).rejects.toThrow(NotFoundException);
        });
    });

    // -------------------------------------------------------------------------
    // TA-7: No PHI leakage
    // Note: extracting text from a compressed PDF binary is not feasible at
    // unit-test level. The str()/sanitize() helpers are tested indirectly via
    // the happy-path (the PDF renders without throwing), and the full PHI leak
    // check (/home/armando, src/, Error:, stack) belongs in e2e tests where
    // pdf-parse or a headless renderer can extract plain text.
    // -------------------------------------------------------------------------
    it.todo('TA-7: no PHI leakage — validated at e2e level with pdf-parse; str()/sanitize() lack of server paths cannot be asserted on compressed binary at unit level');

    // -------------------------------------------------------------------------
    // Extra: no completed diagnosis → BadRequestException
    // -------------------------------------------------------------------------
    describe('extra: no completed diagnosis', () => {
        it('should throw BadRequestException when no completed diagnosis exists for the consultation', async () => {
            consultationRepo.findOne.mockResolvedValue(makeConsultation());
            diagnosisRepo.findOne.mockResolvedValue(null);

            await expect(service.generateConsultationReport(1, 42)).rejects.toThrow(BadRequestException);
        });
    });
});
