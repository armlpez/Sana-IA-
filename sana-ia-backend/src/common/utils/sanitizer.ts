import * as crypto from 'crypto';

export class DataSanitizer {
  private static readonly SENSITIVE_FIELDS = [
    'password',
    'token',
    'refreshToken',
    'apiKey',
    'secret',
  ];

  private static readonly PII_FIELDS = [
    'email',
    'phone',
    'birthDate',
    'birthDate',
    'ssn',
    'creditCard',
    'bankAccount',
  ];

  /**
   * Sanitize sensitive data for logging
   * Redacts passwords/tokens, hashes PII
   */
  static sanitizeForLog(data: any): any {
    if (!data) return data;
    if (typeof data !== 'object') return data;

    const sanitized = Array.isArray(data) ? [...data] : { ...data };

    Object.keys(sanitized).forEach((key) => {
      const lowerKey = key.toLowerCase();

      // Redact passwords, tokens, secrets
      if (this.SENSITIVE_FIELDS.some((field) => lowerKey.includes(field))) {
        sanitized[key] = '[REDACTED]';
      }
      // Hash PII
      else if (this.PII_FIELDS.some((field) => lowerKey.includes(field))) {
        sanitized[key] = this.hashForLog(sanitized[key]);
      }
      // Recursively sanitize nested objects
      else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizeForLog(sanitized[key]);
      }
    });

    return sanitized;
  }

  /**
   * Create a hash for PII fields (for logging only, not cryptographically secure)
   * Example: user@example.com → "user...@ex" (partial reveal for context)
   */
  private static hashForLog(value: any): string {
    if (!value) return '[REDACTED]';

    const str = String(value);

    // For emails, show partial: user...@example
    if (str.includes('@')) {
      const [local, domain] = str.split('@');
      const shortLocal = local.slice(0, 4) + '...';
      return `${shortLocal}@${domain.slice(0, 3)}...`;
    }

    // For other strings, show hash (first 8 chars)
    const hash = crypto.createHash('sha256').update(str).digest('hex');
    return `[${hash.slice(0, 8)}]`;
  }

  /**
   * Extract field names from validation error for user response
   * Does NOT include values, only field names
   */
  static extractValidationFields(errors: any[]): string[] {
    const fields: Set<string> = new Set();

    const extract = (obj: any) => {
      if (Array.isArray(obj)) {
        obj.forEach(extract);
      } else if (typeof obj === 'object' && obj !== null) {
        if (obj.property) {
          fields.add(obj.property);
        }
        Object.values(obj).forEach((val) => {
          if (typeof val === 'object' && val !== null) {
            extract(val);
          }
        });
      }
    };

    extract(errors);
    return Array.from(fields);
  }
}
