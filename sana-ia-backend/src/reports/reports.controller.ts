import {
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';

// See ai.controller.ts for why this skip is needed: 'auth-sensitive'/
// 'registration' would otherwise silently rate-limit normal report downloads.
@SkipThrottle({ 'auth-sensitive': true, registration: true })
@UseGuards(JwtAuthGuard)
@Controller({ path: 'consultations', version: '1' })
export class ReportsController {
    constructor(private readonly reportsService: ReportsService) {}

    /**
     * GET /v1/consultations/:id/report
     *
     * Generates and returns the consultation report as a PDF (synchronous).
     * Only the consultation owner can download it, and only once the
     * consultation is completed (a final diagnosis exists).
     *
     * The PDF is generated in-memory and streamed back — never persisted to disk.
     */
    @Get(':id/report')
    async getConsultationReport(
        @Param('id', ParseIntPipe) id: number,
        @Req() req: any,
        @Res() res: Response,
    ): Promise<void> {
        const pdf = await this.reportsService.generateConsultationReport(id, req.user.id);

        const filename = `consulta-${id}-${new Date().toISOString().slice(0, 10)}.pdf`;
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': String(pdf.length),
        });
        res.end(pdf);
    }
}
