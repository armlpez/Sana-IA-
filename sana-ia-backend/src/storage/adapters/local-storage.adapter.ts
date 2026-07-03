import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StorageObject, StoragePort } from '../storage.port';

/** Local-disk adapter — MVP / single-instance development. */
@Injectable()
export class LocalStorageAdapter implements StoragePort {
  private readonly logger = new Logger(LocalStorageAdapter.name);
  private readonly basePath: string;

  constructor(configService: ConfigService) {
    this.basePath =
      configService.get<string>('STORAGE_LOCAL_PATH') ?? path.join(process.cwd(), 'uploads');
  }

  async save(object: StorageObject, key: string): Promise<string> {
    const destination = path.join(this.basePath, key);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, object.buffer);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(path.join(this.basePath, key));
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.unlink(path.join(this.basePath, key));
      this.logger.log(`File deleted: ${key}`);
    } catch (err) {
      this.logger.warn(`Failed to delete file: ${key} - ${err.message}`);
    }
  }
}
