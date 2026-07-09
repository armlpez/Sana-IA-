import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AppService } from './app.service';

// Health checks are polled frequently by load balancers/monitoring — they must
// never be throttled. See ai.controller.ts for why 'auth-sensitive'/
// 'registration' need an explicit skip (they'd otherwise apply here too and
// make the app look down to infra monitoring after 5 checks/15min).
@SkipThrottle({ 'auth-sensitive': true, registration: true })
@Controller({ version: VERSION_NEUTRAL })
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }
}
