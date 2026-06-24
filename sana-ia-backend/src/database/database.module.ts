import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
    imports: [
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                type: 'postgres',
                host: configService.get<string>('database.host'),
                port: configService.get<number>('database.port'),
                username: configService.get<string>('database.username'),
                password: configService.get<string>('database.password'),
                database: configService.get<string>('database.database'),
                entities: [__dirname + '/../**/*.entity{.ts,.js}'],
                synchronize: configService.get<boolean>('database.synchronize'),
                logging: configService.get<boolean>('database.logging'),
                extra: configService.get('database.extra'),
            }),
        }),
    ],
})
export class DatabaseModule { }
