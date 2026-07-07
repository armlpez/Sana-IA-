import { HttpStatus } from '@nestjs/common';
import { buildAiProviderException } from './exception.util';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';

describe('buildAiProviderException', () => {
    it('builds a 503 RATE_LIMITED exception with interpolated provider name', () => {
        const ex = buildAiProviderException({ providerName: 'Bedrock', kind: GeminiErrorKind.RATE_LIMITED, attempt: 2 });

        expect(ex).toBeInstanceOf(AppException);
        expect(ex.errorCode).toBe(ErrorCode.AI_RATE_LIMITED);
        expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect((ex.getResponse() as any).message).toContain('Bedrock');
        expect(ex.publicMessage).toBe(
            'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
        );
    });

    it('builds a 503 UNAVAILABLE exception with interpolated provider name', () => {
        const ex = buildAiProviderException({ providerName: 'Groq', kind: GeminiErrorKind.UNAVAILABLE, attempt: 1 });

        expect(ex.errorCode).toBe(ErrorCode.AI_UNAVAILABLE);
        expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect((ex.getResponse() as any).message).toContain('Groq');
        expect(ex.publicMessage).toBe(
            'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
        );
    });

    it('builds a 503 TIMEOUT exception with interpolated provider name', () => {
        const ex = buildAiProviderException({ providerName: 'Cerebras', kind: GeminiErrorKind.TIMEOUT, attempt: 0 });

        expect(ex.errorCode).toBe(ErrorCode.AI_TIMEOUT);
        expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect((ex.getResponse() as any).message).toContain('Cerebras');
        expect(ex.publicMessage).toBe('El servicio de IA tardó demasiado. Por favor, intentá de nuevo.');
    });

    it('builds a 500 PARSE exception with interpolated provider name', () => {
        const ex = buildAiProviderException({ providerName: 'Gemini', kind: GeminiErrorKind.PARSE, attempt: 3 });

        expect(ex.errorCode).toBe(ErrorCode.AI_PARSE_FAILED);
        expect(ex.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect((ex.getResponse() as any).message).toContain('Gemini');
        expect(ex.publicMessage).toBe(
            'El servicio de IA no pudo procesar la respuesta. Por favor, intentá de nuevo.',
        );
    });

    it('builds a 500 POLICY_BLOCK exception with interpolated provider name', () => {
        const ex = buildAiProviderException({ providerName: 'Bedrock', kind: GeminiErrorKind.POLICY_BLOCK, attempt: 0 });

        expect(ex.errorCode).toBe(ErrorCode.AI_SERVICE_ERROR);
        expect(ex.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect((ex.getResponse() as any).message).toContain('Bedrock');
        expect(ex.publicMessage).toBe('Error interno en el servicio de IA.');
    });

    it('builds a 500 UNKNOWN exception with interpolated provider name', () => {
        const ex = buildAiProviderException({ providerName: 'Groq', kind: GeminiErrorKind.UNKNOWN, attempt: 1 });

        expect(ex.errorCode).toBe(ErrorCode.AI_SERVICE_ERROR);
        expect(ex.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect((ex.getResponse() as any).message).toContain('Groq');
        expect(ex.publicMessage).toBe('Error interno en el servicio de IA.');
    });
});
