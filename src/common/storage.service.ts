import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

export class StorageService {
  private client: S3Client | null = null;
  private bucket: string;
  private publicDomain: string;

  constructor() {
    this.bucket = process.env.R2_BUCKET_NAME || '';
    this.publicDomain = process.env.R2_PUBLIC_DOMAIN || '';

    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const endpoint = process.env.R2_ENDPOINT;

    if (accessKeyId && secretAccessKey && endpoint && this.bucket) {
      this.client = new S3Client({
        region: process.env.R2_REGION || 'auto',
        endpoint,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    }
  }

  async uploadBase64(
    base64Data: string,
    mimeType: string,
    folder = 'evidences',
  ): Promise<string | null> {
    if (!this.client) return null;
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const ext = mimeType.split('/')[1] || 'jpg';
      const key = `${folder}/${Date.now()}-${randomUUID()}.${ext}`;

      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
        }),
      );

      return `${this.publicDomain.replace(/\/$/, '')}/${key}`;
    } catch (err) {
      console.error('Error uploading to Cloudflare R2:', err);
      return null;
    }
  }
}

export const storage = new StorageService();

