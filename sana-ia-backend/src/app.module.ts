import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';
import { OcrModule } from './ocr/ocr.module';
import { ReportsModule } from './reports/reports.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { ChatMessagesModule } from './chat-messages/chat-messages.module';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import databaseConfig from './config/database.config';
import redisConfig from './config/redis.config';
import aiModelsConfig from './ai/config/model-tiers.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, aiModelsConfig, redisConfig],
      envFilePath: '.env',
    }),
    // Rate limiting configuration
    // TESTING: High limits to allow rapid testing
    // PRODUCTION: Uncomment and use values below for safety
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        // TESTING: 10000 requests/min (almost unlimited)
        // PRODUCTION: limit: 60,
        limit: 10000,
      },
      {
        name: 'chat',
        ttl: 60_000,
        // TESTING: 1000 requests/min per user
        // PRODUCTION: limit: parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN ?? '12', 10),
        limit: 1000,
      },
      {
        name: 'auth-sensitive',
        // PRODUCTION: security-critical anti-abuse tier (forgot-password,
        // resend-verification, reset-password, verify-email). Unlike
        // 'default'/'chat' above, these are the actual PRODUCTION values —
        // not loosened for testing — because loosening a brute-force/
        // enumeration guard defeats its purpose. 15 min window, 5 req/IP.
        ttl: 900_000,
        limit: 5,
      },
      {
        name: 'registration',
        // PRODUCTION: anti-abuse tier for POST /v1/users. Actual production
        // value (see 'auth-sensitive' comment above for rationale).
        // 1 hour window, 10 req/IP.
        ttl: 3_600_000,
        limit: 10,
      },
    ]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('redis.host'),
          port: config.get('redis.port'),
          password: config.get('redis.password'),
          family: 4, // Force IPv4 to avoid Alpine musl dns.lookup bug with single-label hostnames
        },
      }),
    }),
    DatabaseModule,
    UsersModule,
    RolesModule,
    AuthModule,
    ConsultationsModule,
    ChatMessagesModule,
    AiModule,
    OcrModule,
    ReportsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
  ],
})
export class AppModule { }

