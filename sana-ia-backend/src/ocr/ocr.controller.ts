import {
    Controller,
    Post,
    Get,
    Param,
    Req,
    UseInterceptors,
    UploadedFile,
    NotFoundException,
    Body,
    Logger,
    ParseUUIDPipe,
    UseGuards,
    HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { diskStorage } from 'multer';
import { ErrorResponseBuilder } from '../common/utils/error-response.builder';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { extname, join } from 'path';
import { OcrResult } from './entities/ocr-result.entity';
import { OcrJobStatus } from './enums/ocr-job-status.enum';
import { OcrProducer } from './ocr.producer';
import { SubmitOcrDto } from './dto/submit-ocr.dto';

/** Directory where uploaded lab images are stored temporarily */
const UPLOAD_DIR = join(process.cwd(), 'uploads', 'labs');

@UseGuards(JwtAuthGuard)
@Controller('v1/ocr')
export class OcrController {
    private readonly logger = new Logger(OcrController.name);

    constructor(
        @InjectRepository(OcrResult)
        private readonly ocrResultRepo: Repository<OcrResult>,
        private readonly ocrProducer: OcrProducer,
    ) {}

    /**
     * POST /v1/ocr/analyze
     *
     * Receives a lab image, persists the record in Postgres,
     * enqueues the OCR job in BullMQ, and returns 202 Accepted with the jobId.
     *
     * The client should poll GET /v1/ocr/jobs/:id for the result.
     */
    @Post('analyze')
    @UseInterceptors(
        FileInterceptor('image', {
            storage: diskStorage({
                destination: UPLOAD_DIR,
                filename: (_req, file, cb) => {
                    const uniqueName = `${randomUUID()}${extname(file.originalname)}`;
                    cb(null, uniqueName);
                },
            }),
            limits: {
                fileSize: 10 * 1024 * 1024, // 10 MB max
            },
            fileFilter: (_req, file, cb) => {
                const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
                if (allowedMimes.includes(file.mimetype)) {
                    cb(null, true);
                } else {
                    cb(new Error('Only JPEG, PNG, WebP, and PDF files are allowed'), false);
                }
            },
        }),
    )
    async submitOcr(
        @UploadedFile() file: Express.Multer.File,
        @Body() dto: SubmitOcrDto,
        @Req() req: any,
    ) {
        const userId = req.user?.id;

        // 1. Persist the record in Postgres FIRST (durable truth)
        const ocrResult = this.ocrResultRepo.create({
            userId,
            consultationId: dto.consultationId,
            imagePath: file.path,
            originalFilename: dto.originalFilename ?? file.originalname,
            status: OcrJobStatus.QUEUED,
        });
        const saved = await this.ocrResultRepo.save(ocrResult) as OcrResult;

        // 2. Enqueue the job in BullMQ (only IDs travel through Redis)
        await this.ocrProducer.enqueue({
            ocrResultId: saved.id,
            userId,
            requestedAt: new Date().toISOString(),
        });

        this.logger.log(
            `OCR job submitted — ocrResultId: ${saved.id}, user: ${userId}, file: ${file.originalname}`,
        );

        // 3. Return 202 Accepted with the jobId for polling
        return {
            statusCode: 202,
            jobId: saved.id,
            status: OcrJobStatus.QUEUED,
            message: 'Lab image received. Processing will begin shortly.',
        };
    }

    /**
     * GET /v1/ocr/jobs/:id
     *
     * Polling endpoint — the Flutter client calls this every 3-5 seconds
     * to check if the OCR job has completed.
     *
     * Reads from PostgreSQL (the durable store), NOT from Redis.
     */
    @Get('jobs/:id')
    async getJobStatus(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
        const userId = req.user?.id;

        const ocrResult = await this.ocrResultRepo.findOne({
            where: { id, userId },
        });

        if (!ocrResult) {
            throw new NotFoundException('OCR job not found');
        }

        // Base response (always returned)
        const response: Record<string, any> = {
            jobId: ocrResult.id,
            status: ocrResult.status,
            createdAt: ocrResult.createdAt,
            processingTimeMs: ocrResult.processingTimeMs,
        };

        // Include results only when completed
        if (ocrResult.status === OcrJobStatus.COMPLETED) {
            response.extractedData = ocrResult.extractedData;
        }

        // Include sanitized error message on failure (via ErrorResponseBuilder for consistency)
        if (ocrResult.status === OcrJobStatus.FAILED) {
            response.errorMessage = ErrorResponseBuilder.getPublicMessage(HttpStatus.BAD_REQUEST);
            // Internal detailed message stays in ocrResult.errorMessage (server logs only)
        }

        return response;
    }
}
