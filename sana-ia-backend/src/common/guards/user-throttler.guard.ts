import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Override default IP-based throttling to key by authenticated user ID.
 * This prevents one user blocking others on the same carrier NAT or corporate network.
 * Falls back to IP for unauthenticated endpoints.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
    protected async getTracker(req: Record<string, any>): Promise<string> {
        return req.user?.id?.toString() ?? req.ip;
    }
}
