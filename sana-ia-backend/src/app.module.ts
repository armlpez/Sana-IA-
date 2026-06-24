import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { ChatMessagesModule } from './chat-messages/chat-messages.module';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import databaseConfig from './config/database.config';
import aiModelsConfig from './ai/config/model-tiers.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, aiModelsConfig],
      envFilePath: '.env',
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 60,
      },
      {
        name: 'chat',
        ttl: 60_000,
        limit: parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN ?? '12', 10),
      },
    ]),
    DatabaseModule,
    UsersModule,
    RolesModule,
    AuthModule,
    ConsultationsModule,
    ChatMessagesModule,
    AiModule,
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
