import { HttpStatus } from '@nestjs/common';
import { GeminiErrorKind } from '../utils/gemini-error-kind';
import { AppException } from '../../common/exceptions/app-exception';
import { ErrorCode } from '../../common/enums/error-codes.enum';

export interface BuildAiProviderExceptionParams {
    providerName: string;
    kind: GeminiErrorKind;
    attempt: number;
}

interface ExceptionSpec {
    code: ErrorCode;
    message: (providerName: string, attempt: number) => string;
    publicMessage: string;
    statusCode: HttpStatus;
}

/**
 * Shared Spanish `publicMessage` strings — identical across all 4 adapters
 * today (GeminiClientService.toAppException is the authoritative source all
 * others copied).
 *
 * Status code decision (canonical fix, replacing per-adapter drift):
 *   - RATE_LIMITED / UNAVAILABLE / TIMEOUT → 503 (was inconsistently 500 for
 *     Groq/Bedrock/Cerebras, 503 for Gemini)
 *   - PARSE / POLICY_BLOCK / UNKNOWN       → 500 (matches 3-of-4 adapters
 *     today; Gemini's PARSE case moves from 503→500 once migrated — PARSE
 *     errors are not retried, so 500 "internal failure to handle the
 *     response" is more semantically correct than 503 "service unavailable")
 */
const EXCEPTION_SPECS: Record<GeminiErrorKind, ExceptionSpec> = {
    [GeminiErrorKind.RATE_LIMITED]: {
        code: ErrorCode.AI_RATE_LIMITED,
        message: (providerName, attempt) => `${providerName} rate limited after ${attempt} attempts. Please try again in a moment.`,
        publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    },
    [GeminiErrorKind.UNAVAILABLE]: {
        code: ErrorCode.AI_UNAVAILABLE,
        message: (providerName, attempt) => `${providerName} service temporarily unavailable after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA no está disponible en este momento. Por favor, intentá de nuevo.',
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    },
    [GeminiErrorKind.TIMEOUT]: {
        code: ErrorCode.AI_TIMEOUT,
        message: (providerName, attempt) => `${providerName} request timed out after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA tardó demasiado. Por favor, intentá de nuevo.',
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    },
    [GeminiErrorKind.PARSE]: {
        code: ErrorCode.AI_PARSE_FAILED,
        message: (providerName, attempt) => `${providerName} response format error after ${attempt} attempts.`,
        publicMessage: 'El servicio de IA no pudo procesar la respuesta. Por favor, intentá de nuevo.',
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    },
    [GeminiErrorKind.POLICY_BLOCK]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: (providerName, attempt) => `${providerName} policy violation after ${attempt} attempts.`,
        publicMessage: 'Error interno en el servicio de IA.',
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    },
    [GeminiErrorKind.UNKNOWN]: {
        code: ErrorCode.AI_SERVICE_ERROR,
        message: (providerName, attempt) => `${providerName} error after ${attempt} attempts.`,
        publicMessage: 'Error interno en el servicio de IA.',
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    },
};

/**
 * Builds the terminal `AppException` thrown by every AI provider adapter
 * once a call fails permanently (non-retryable kind, or retries exhausted).
 *
 * Extracted from the 4 near-identical `toAppException` private methods
 * duplicated across BedrockAdapter, GroqAdapter, CerebrasAdapter and
 * GeminiClientService.
 */
export function buildAiProviderException(params: BuildAiProviderExceptionParams): AppException {
    const { providerName, kind, attempt } = params;
    const spec = EXCEPTION_SPECS[kind];

    return new AppException({
        errorCode: spec.code,
        message: spec.message(providerName, attempt),
        statusCode: spec.statusCode,
        publicMessage: spec.publicMessage,
    });
}
