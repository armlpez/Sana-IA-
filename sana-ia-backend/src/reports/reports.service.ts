import {
    Injectable,
    Logger,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces';
import { Consultation } from '../consultations/entities/consultation.entity';
import { Diagnosis } from '../consultations/entities/diagnosis.entity';
import { ConsultationStatus } from '../consultations/enums/consultation-status.enum';
import { OcrResult } from '../ocr/entities/ocr-result.entity';
import { OcrJobStatus } from '../ocr/enums/ocr-job-status.enum';

// pdfmake 0.3.x exposes a configured server singleton (no constructable PdfPrinter export).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfMake = require('pdfmake');

// Base-14 PDF fonts — built into every reader, no .ttf files, and they cover
// Latin-1 accents (á, é, í, ñ, ¿) needed for Spanish content.
const STANDARD_FONTS = new Set([
    'Helvetica',
    'Helvetica-Bold',
    'Helvetica-Oblique',
    'Helvetica-BoldOblique',
]);
pdfMake.setFonts({
    Helvetica: {
        normal: 'Helvetica',
        bold: 'Helvetica-Bold',
        italics: 'Helvetica-Oblique',
        bolditalics: 'Helvetica-BoldOblique',
    },
});
// Security hardening: deny all external URL access, and allow ONLY the built-in
// base-14 fonts locally (deny any other local-file access from doc definitions).
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy((path: string) => STANDARD_FONTS.has(path));

/**
 * Generates clinical consultation reports as PDF, in-memory.
 *
 * Design decisions (see docs/FASE4-REPORTS.md):
 * - Synchronous generation: a single-consultation report is sub-second.
 * - In-memory only: the PDF is never written to disk (PHI privacy).
 * - Uses the PDF base-14 fonts (Helvetica) so no font files are required and
 *   Latin-1 accents (á, é, í, ñ, ¿) render correctly for Spanish content.
 */
@Injectable()
export class ReportsService {
    private readonly logger = new Logger(ReportsService.name);

    constructor(
        @InjectRepository(Consultation)
        private readonly consultationRepo: Repository<Consultation>,
        @InjectRepository(Diagnosis)
        private readonly diagnosisRepo: Repository<Diagnosis>,
        @InjectRepository(OcrResult)
        private readonly ocrResultRepo: Repository<OcrResult>,
    ) {}

    /**
     * Generates the consultation report PDF for an owned, completed consultation.
     *
     * @throws NotFoundException  consultation does not exist
     * @throws ForbiddenException requester is not the consultation owner
     * @throws BadRequestException consultation is not completed / has no diagnosis
     */
    async generateConsultationReport(consultationId: number, userId: number): Promise<Buffer> {
        const consultation = await this.consultationRepo.findOne({
            where: { id: consultationId },
            relations: ['user'],
        });

        if (!consultation) {
            throw new NotFoundException('Consultation not found');
        }
        if (consultation.userId !== userId) {
            throw new ForbiddenException('You do not have access to this consultation');
        }
        if (consultation.status !== ConsultationStatus.COMPLETED) {
            throw new BadRequestException('Report cannot be generated for an incomplete consultation');
        }

        // Latest FINAL diagnosis (append-only table → newest completed row).
        const diagnosis = await this.diagnosisRepo.findOne({
            where: { consultationId, statusAtEmit: ConsultationStatus.COMPLETED },
            order: { createdAt: 'DESC' },
        });
        if (!diagnosis) {
            throw new BadRequestException('No completed diagnosis available for this consultation');
        }

        // Biomarkers from successfully processed lab images linked to this consultation.
        const ocrResults = await this.ocrResultRepo.find({
            where: { consultationId, status: OcrJobStatus.COMPLETED },
        });
        const biomarkers = ocrResults.flatMap(
            (r) => (r.extractedData?.biomarkers as BiomarkerRow[] | undefined) ?? [],
        );

        const docDefinition = this.buildDocDefinition(consultation, diagnosis, biomarkers);
        const pdf = await this.renderToBuffer(docDefinition);

        this.logger.log(
            `Report generated — consultation: ${consultationId}, user: ${userId}, biomarkers: ${biomarkers.length}, bytes: ${pdf.length}`,
        );

        return pdf;
    }

    // -------------------------------------------------------------------------
    // PDF construction
    // -------------------------------------------------------------------------

    private buildDocDefinition(
        consultation: Consultation,
        diagnosis: Diagnosis,
        biomarkers: BiomarkerRow[],
    ): TDocumentDefinitions {
        const payload = diagnosis.payload ?? {};
        const generatedAt = new Date();

        const content: Content[] = [
            { text: 'Informe de Consulta Clínica', style: 'title' },
            { text: 'Sana-IA · Motor de Inferencia Clínica (ACR)', style: 'subtitle' },
            {
                text: `Generado: ${this.formatDateTime(generatedAt)}`,
                style: 'meta',
                margin: [0, 0, 0, 12],
            },
        ];

        // Emergency banner (only when the consultation flagged an emergency).
        // Rendered as a filled table cell so the background colour is honoured.
        if (consultation.emergencyDetected || diagnosis.isEmergency) {
            content.push({
                table: {
                    widths: ['*'],
                    body: [[
                        {
                            text: 'EMERGENCIA DETECTADA — Se recomendó atención médica de urgencia.',
                            style: 'emergencyText',
                            fillColor: '#c0392b',
                            margin: [6, 6, 6, 6],
                        },
                    ]],
                },
                layout: 'noBorders',
                margin: [0, 0, 0, 12],
            });
        }

        // Patient section
        content.push(
            { text: 'Datos del paciente', style: 'section' },
            this.keyValueTable([
                ['Nombre', consultation.user?.name ?? '—'],
                ['Email', consultation.user?.email ?? '—'],
                ['Edad', this.formatAge(consultation.user?.birthDate)],
                ['ID de consulta', String(consultation.id)],
                ['Fecha de consulta', this.formatDateTime(consultation.createdAt)],
            ]),
        );

        // Symptoms section
        content.push(
            { text: 'Síntomas reportados', style: 'section' },
            this.keyValueTable([
                ['Síntomas', this.str(consultation.extractedSymptoms)],
                ['Tratamiento actual', this.str(consultation.extractedTreatment)],
                ['Duración', this.str(consultation.extractedDuration)],
            ]),
        );

        // Diagnosis section
        content.push(
            { text: 'Análisis de causa raíz (ACR)', style: 'section' },
            this.keyValueTable([
                ['Hipótesis de causa raíz', this.str(payload['rootCauseHypothesis'])],
                ['Especialista sugerido', diagnosis.suggestedSpecialist ?? '—'],
                [
                    'Nivel de confianza',
                    diagnosis.confidenceLevel != null ? `${diagnosis.confidenceLevel}%` : '—',
                ],
            ]),
        );

        // Five Whys trace, if present. The model already numbers each step, so
        // render them as plain paragraphs (no ordered list) to avoid "1. 1.".
        const fiveWhys = payload['fiveWhysTrace'];
        if (Array.isArray(fiveWhys) && fiveWhys.length > 0) {
            content.push(
                { text: 'Trazado de los 5 Porqués', style: 'section' },
                {
                    stack: fiveWhys.map((w) => ({
                        text: this.str(w),
                        style: 'body',
                        margin: [0, 0, 0, 4],
                    })),
                },
            );
        }

        // Biomarkers table
        content.push({ text: 'Biomarcadores de laboratorio', style: 'section' });
        if (biomarkers.length > 0) {
            content.push(this.biomarkersTable(biomarkers));
        } else {
            content.push({
                text: 'No hay resultados de laboratorio adjuntos a esta consulta.',
                style: 'body',
                italics: true,
            });
        }

        // Legal disclaimer
        const disclaimer =
            this.str(payload['disclaimer']) !== '—'
                ? this.str(payload['disclaimer'])
                : 'Este informe es REFERENCIAL y no sustituye la consulta médica profesional. Para cualquier decisión de salud, consulte a un profesional médico colegiado.';
        content.push({
            text: disclaimer,
            style: 'disclaimer',
            margin: [0, 18, 0, 0],
        });

        return {
            content,
            defaultStyle: { font: 'Helvetica', fontSize: 10, color: '#222222' },
            pageMargins: [40, 48, 40, 56],
            footer: (currentPage: number, pageCount: number) => ({
                columns: [
                    { text: 'Sana-IA · Documento confidencial', style: 'footer' },
                    {
                        text: `Página ${currentPage} de ${pageCount}`,
                        style: 'footer',
                        alignment: 'right',
                    },
                ],
                margin: [40, 16, 40, 0],
            }),
            styles: {
                title: { fontSize: 20, bold: true, color: '#1a3c5e' },
                subtitle: { fontSize: 11, color: '#5a6b7b', margin: [0, 2, 0, 0] },
                meta: { fontSize: 9, color: '#8a97a3' },
                section: {
                    fontSize: 13,
                    bold: true,
                    color: '#1a3c5e',
                    margin: [0, 14, 0, 6],
                },
                body: { fontSize: 10, lineHeight: 1.3 },
                emergencyText: {
                    fontSize: 12,
                    bold: true,
                    color: '#ffffff',
                    alignment: 'center',
                },
                tableLabel: { bold: true, color: '#445566' },
                tableHeader: { bold: true, color: '#ffffff', fillColor: '#1a3c5e', fontSize: 10 },
                disclaimer: { fontSize: 8, italics: true, color: '#8a97a3' },
                footer: { fontSize: 8, color: '#8a97a3' },
            },
        };
    }

    /** Two-column key/value table with no visible vertical borders. */
    private keyValueTable(rows: [string, string][]): Content {
        return {
            table: {
                widths: [140, '*'],
                body: rows.map(([k, v]) => [
                    { text: k, style: 'tableLabel' },
                    { text: v, style: 'body' },
                ]),
            },
            layout: 'lightHorizontalLines',
            margin: [0, 0, 0, 4],
        };
    }

    private biomarkersTable(biomarkers: BiomarkerRow[]): Content {
        const header = ['Biomarcador', 'Valor', 'Unidad', 'Rango ref.', 'Estado'].map((h) => ({
            text: h,
            style: 'tableHeader',
        }));

        const body = biomarkers.map((b) => [
            { text: this.str(b?.name), style: 'body' },
            { text: this.str(b?.value), style: 'body' },
            { text: this.str(b?.unit), style: 'body' },
            { text: this.str(b?.referenceRange), style: 'body' },
            { text: this.str(b?.flag), style: 'body' },
        ]);

        return {
            table: {
                headerRows: 1,
                widths: ['*', 'auto', 'auto', 'auto', 'auto'],
                body: [header, ...body],
            },
            layout: 'lightHorizontalLines',
            margin: [0, 4, 0, 4],
        };
    }

    private renderToBuffer(docDefinition: TDocumentDefinitions): Promise<Buffer> {
        // pdfmake 0.3.x: createPdf(...).getBuffer() resolves to a Buffer.
        return pdfMake.createPdf(docDefinition).getBuffer();
    }

    // -------------------------------------------------------------------------
    // Formatting helpers
    // -------------------------------------------------------------------------

    /** Coerces an unknown payload value to a display string (never PHI paths). */
    private str(value: unknown): string {
        if (value == null) return '—';
        if (typeof value === 'string') return this.sanitize(value.trim()) || '—';
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return '—';
    }

    /**
     * Maps Unicode symbols the model commonly emits (arrows, math signs) to
     * Latin-1-safe equivalents, since the base-14 Helvetica font only covers
     * WinAnsi. Punctuation already in WinAnsi (— – “ ” … •) is left untouched.
     */
    private sanitize(text: string): string {
        const map: Record<string, string> = {
            '→': '->', '⟶': '->', '←': '<-', '↑': '^', '↓': 'v',
            '↔': '<->', '⇒': '=>', '⇐': '<=', '⇔': '<=>',
            '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '≡': '=',
            '∞': 'inf', '√': 'raiz', '∴': 'por lo tanto',
        };
        return text.replace(/[→⟶←↑↓↔⇒⇐⇔≥≤≠≈≡∞√∴]/g, (c) => map[c] ?? '');
    }

    private formatDateTime(date?: Date | null): string {
        if (!date) return '—';
        const d = new Date(date);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleString('es', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    private formatAge(birthDate?: Date | null): string {
        if (!birthDate) return '—';
        const b = new Date(birthDate);
        if (Number.isNaN(b.getTime())) return '—';
        const now = new Date();
        let age = now.getFullYear() - b.getFullYear();
        const m = now.getMonth() - b.getMonth();
        if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
        return age >= 0 && age < 130 ? `${age} años` : '—';
    }
}

interface BiomarkerRow {
    name?: string;
    value?: string | number;
    unit?: string;
    referenceRange?: string;
    flag?: string;
}
