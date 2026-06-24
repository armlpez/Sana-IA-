import { classifyGeminiError } from './error-classifier';
import { GeminiErrorKind } from './gemini-error-kind';

describe('classifyGeminiError', () => {
    describe('timeout sentinel', () => {
        it('should classify __kind=TIMEOUT as TIMEOUT', () => {
            const err = { __kind: GeminiErrorKind.TIMEOUT, message: 'timed out' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.TIMEOUT);
        });
    });

    describe('parse sentinel', () => {
        it('should classify __kind=PARSE as PARSE', () => {
            const err = { __kind: GeminiErrorKind.PARSE, message: 'bad json' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.PARSE);
        });
    });

    describe('HTTP status codes', () => {
        it('should classify status=429 as RATE_LIMITED', () => {
            const err = { status: 429, message: 'Too Many Requests' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.RATE_LIMITED);
        });

        it('should classify statusCode=429 as RATE_LIMITED', () => {
            const err = { statusCode: 429, message: 'rate limited' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.RATE_LIMITED);
        });

        it('should classify status=503 as UNAVAILABLE', () => {
            const err = { status: 503, message: 'Service Unavailable' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.UNAVAILABLE);
        });

        it('should classify httpStatus=503 as UNAVAILABLE', () => {
            const err = { httpStatus: 503, message: 'down' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.UNAVAILABLE);
        });
    });

    describe('message-based classification', () => {
        it('should classify "blocked" message as POLICY_BLOCK', () => {
            const err = { message: 'Response blocked due to safety' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.POLICY_BLOCK);
        });

        it('should classify "safety" message as POLICY_BLOCK', () => {
            const err = { message: 'finish_reason: SAFETY' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.POLICY_BLOCK);
        });

        it('should classify "[429 Too Many Requests]" message as RATE_LIMITED', () => {
            const err = { message: '[429 Too Many Requests] quota exceeded' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.RATE_LIMITED);
        });

        it('should classify "too many requests" message as RATE_LIMITED', () => {
            const err = { message: 'error: too many requests' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.RATE_LIMITED);
        });

        it('should classify "[503" message as UNAVAILABLE', () => {
            const err = { message: '[503 Service Unavailable]' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.UNAVAILABLE);
        });

        it('should classify "service unavailable" message as UNAVAILABLE', () => {
            const err = { message: 'the service unavailable now' };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.UNAVAILABLE);
        });
    });

    describe('edge cases', () => {
        it('should return UNKNOWN for a generic Error', () => {
            const err = new Error('something random');
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.UNKNOWN);
        });

        it('should return UNKNOWN for null', () => {
            expect(classifyGeminiError(null)).toBe(GeminiErrorKind.UNKNOWN);
        });

        it('should return UNKNOWN for undefined', () => {
            expect(classifyGeminiError(undefined)).toBe(GeminiErrorKind.UNKNOWN);
        });

        it('should return UNKNOWN for non-object', () => {
            expect(classifyGeminiError('string error')).toBe(GeminiErrorKind.UNKNOWN);
        });

        it('should prioritize __kind sentinel over HTTP status', () => {
            const err = { __kind: GeminiErrorKind.TIMEOUT, status: 429 };
            expect(classifyGeminiError(err)).toBe(GeminiErrorKind.TIMEOUT);
        });
    });
});
