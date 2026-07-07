/**
 * Full-jitter exponential backoff, extracted verbatim from
 * GeminiClientService.computeBackoff (the canonical implementation all
 * provider adapters converge on).
 *
 * delay = random(0, min(cap, base * 2^attempt))
 */
export function computeBackoff(attempt: number, base: number, cap: number): number {
    const ceiling = Math.min(cap, base * Math.pow(2, attempt));
    return Math.floor(Math.random() * ceiling);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
