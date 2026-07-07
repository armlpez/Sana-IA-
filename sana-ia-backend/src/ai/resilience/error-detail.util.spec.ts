import { extractErrorDetail } from './error-detail.util';

describe('extractErrorDetail', () => {
    it('extracts status/message/raw from a fetch-style HTTP error (status + cause)', () => {
        const err = Object.assign(new Error('Bedrock Mantle HTTP 429: rate limited'), {
            status: 429,
            cause: { retryAfter: 30 },
        });

        const detail = extractErrorDetail(err);

        expect(detail.status).toBe('429');
        expect(detail.message).toBe('Bedrock Mantle HTTP 429: rate limited');
        expect(detail.raw).toBe(JSON.stringify({ retryAfter: 30 }));
    });

    it('extracts status/message/raw from a fetch-style error exposing response.data', () => {
        const err = {
            statusCode: 503,
            message: 'upstream unavailable',
            response: { data: { code: 'UNAVAILABLE' } },
        };

        const detail = extractErrorDetail(err);

        expect(detail.status).toBe('503');
        expect(detail.message).toBe('upstream unavailable');
        expect(detail.raw).toBe(JSON.stringify({ code: 'UNAVAILABLE' }));
    });

    it('extracts status/message/raw from a Groq SDK APIError-style error (status + error/body)', () => {
        const err = {
            status: 400,
            httpStatus: 400,
            message: 'invalid request',
            error: { type: 'invalid_request_error', message: 'bad json' },
        };

        const detail = extractErrorDetail(err);

        expect(detail.status).toBe('400');
        expect(detail.message).toBe('invalid request');
        expect(detail.raw).toBe(JSON.stringify({ type: 'invalid_request_error', message: 'bad json' }));
    });

    it('falls back to N/A status and String(err) message for a plain Error with no status', () => {
        const err = new Error('boom');

        const detail = extractErrorDetail(err);

        expect(detail.status).toBe('N/A');
        expect(detail.message).toBe('boom');
        expect(detail.raw).toBeUndefined();
    });

    it('returns a sentinel detail for null input', () => {
        const detail = extractErrorDetail(null);

        expect(detail).toEqual({ status: 'N/A', message: 'null/undefined error' });
    });

    it('returns a sentinel detail for undefined input', () => {
        const detail = extractErrorDetail(undefined);

        expect(detail).toEqual({ status: 'N/A', message: 'null/undefined error' });
    });

    it('truncates message to 300 chars and raw to 500 chars', () => {
        const longMessage = 'x'.repeat(400);
        const longRaw = 'y'.repeat(600);
        const err = { message: longMessage, cause: longRaw };

        const detail = extractErrorDetail(err);

        expect(detail.message.length).toBe(300);
        expect(detail.raw?.length).toBe(500);
    });
});
