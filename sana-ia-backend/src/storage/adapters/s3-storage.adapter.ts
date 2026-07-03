import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageObject, StoragePort } from '../storage.port';

/**
 * S3 adapter — multi-instance safe, PHI encrypted at rest.
 *
 * Credentials come from the environment's default provider chain
 * (the EC2 instance role in production). No access keys in code or config.
 */
@Injectable()
export class S3StorageAdapter implements StoragePort {
  private readonly logger = new Logger(S3StorageAdapter.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    const region = configService.get<string>('AWS_REGION') ?? 'us-east-1';
    const endpoint = configService.get<string>('S3_ENDPOINT'); // LocalStack only
    this.bucket = configService.getOrThrow<string>('S3_BUCKET');

    this.client = new S3Client({
      region,
      ...(endpoint && { endpoint, forcePathStyle: true }),
    });
  }

  async save(object: StorageObject, key: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: object.buffer,
        ContentType: object.contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await response.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      this.logger.log(`File deleted: ${key}`);
    } catch (err) {
      this.logger.warn(`Failed to delete file: ${key} - ${err.message}`);
    }
  }
}
