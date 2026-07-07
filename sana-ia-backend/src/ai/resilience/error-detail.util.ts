export interface ErrorDetail {
    status: string;
    message: string;
    raw?: string;
}

/**
 * Extract structured detail from any provider error shape for rich logging.
 *
 * Merges the shapes duplicated across all 4 current adapters:
 *   - Gemini SDK errors:        .status/.statusCode/.httpStatus/.code, .errorDetails, .response?.data, .cause
 *   - fetch-style errors:       .status/.statusCode/.httpStatus,       .cause, .body, .response?.data
 *   - Groq SDK APIError errors: .status/.statusCode/.httpStatus,       .error, .body, .response?.data
 */
export function extractErrorDetail(err: unknown): ErrorDetail {
    if (!err) return { status: 'N/A', message: 'null/undefined error' };

    const e = err as any;
    const status = e.status ?? e.statusCode ?? e.httpStatus ?? e.code ?? 'N/A';
    const message = e.message ?? String(err);

    let raw: string | undefined;
    try {
        const details = e.errorDetails ?? e.cause ?? e.error ?? e.body ?? e.response?.data;
        if (details) {
            raw = typeof details === 'string' ? details.substring(0, 500) : JSON.stringify(details).substring(0, 500);
        }
    } catch { /* ignore serialization errors */ }

    return { status: String(status), message: message.substring(0, 300), raw };
}
