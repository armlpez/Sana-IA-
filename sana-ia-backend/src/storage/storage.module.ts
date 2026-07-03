import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { STORAGE_PORT } from './storage.port';
import { LocalStorageAdapter } from './adapters/local-storage.adapter';
import { S3StorageAdapter } from './adapters/s3-storage.adapter';

/**
 * Wires STORAGE_PORT to a concrete adapter based on STORAGE_TYPE.
 *
 * This is the ONLY place that knows about every adapter. Adding a new
 * backend means adding one `case` here — consumers never change.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STORAGE_PORT,
      useFactory: (configService: ConfigService) => {
        const storageType = configService.get<string>('STORAGE_TYPE') ?? 'local';
        switch (storageType) {
          case 's3':
            return new S3StorageAdapter(configService);
          case 'local':
            return new LocalStorageAdapter(configService);
          default:
            throw new Error(`Unknown STORAGE_TYPE: ${storageType}`);
        }
      },
      inject: [ConfigService],
    },
  ],
  exports: [STORAGE_PORT],
})
export class StorageModule {}
