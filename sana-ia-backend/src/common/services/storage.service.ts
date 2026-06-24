import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * StorageService - Abstraction for file storage (local or S3)
 *
 * Allows switching between:
 * - Local disk: MVP development
 * - S3/LocalStack: Production-ready, multi-pod safe
 *
 * Without changing consuming code.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly storageType: 'local' | 's3';
  private readonly localBasePath: string;

  constructor(private configService: ConfigService) {
    this.storageType = (process.env.STORAGE_TYPE ?? 'local') as 'local' | 's3';
    this.localBasePath = path.join(process.cwd(), 'uploads');

    this.logger.log(`StorageService initialized with type: ${this.storageType}`);
  }

  /**
   * Store a file from disk path to storage backend
   * Returns a storagePath (local path or S3 key) that can be used with getFile()
   */
  async storeFromDisk(sourcePath: string, destinationKey: string): Promise<string> {
    if (this.storageType === 'local') {
      // Local: file already on disk, just return the path
      return sourcePath;
    }
    // S3: upload from disk (implement later)
    throw new Error('S3 storage not yet implemented');
  }

  /**
   * Read file from storage (local disk or S3)
   * Returns Buffer for in-memory processing
   */
  async getFile(storagePath: string): Promise<Buffer> {
    if (this.storageType === 'local') {
      return await fs.readFile(storagePath);
    }
    // S3: download to buffer (implement later)
    throw new Error('S3 storage not yet implemented');
  }

  /**
   * Delete file from storage (after successful processing)
   */
  async deleteFile(storagePath: string): Promise<void> {
    if (this.storageType === 'local') {
      try {
        await fs.unlink(storagePath);
        this.logger.log(`File deleted: ${storagePath}`);
      } catch (err) {
        this.logger.warn(`Failed to delete file: ${storagePath} - ${err.message}`);
      }
      return;
    }
    // S3: delete object (implement later)
    throw new Error('S3 storage not yet implemented');
  }

  /**
   * Extract MIME type from storagePath
   * Works for both local paths and S3 keys
   */
  extractMimeType(storagePath: string): string {
    const ext = path.extname(storagePath).toLowerCase();
    const mimeMap = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };
    return mimeMap[ext] || 'image/jpeg';
  }
}
