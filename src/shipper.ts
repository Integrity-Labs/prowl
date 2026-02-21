import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export class S3Shipper {
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(opts: { bucket: string; region: string; prefix: string; endpoint?: string | null }) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix;

    const clientOpts: ConstructorParameters<typeof S3Client>[0] = {
      region: opts.region,
    };

    if (opts.endpoint) {
      clientOpts.endpoint = opts.endpoint;
      clientOpts.forcePathStyle = true;
    }

    this.client = new S3Client(clientOpts);
  }

  async ship(filePath: string): Promise<void> {
    const body = fs.readFileSync(filePath);
    const key = this.buildKey(filePath);

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/x-ndjson',
    }));
  }

  private buildKey(filePath: string): string {
    const agent = this.extractAgent(filePath);
    const sessionFile = path.basename(filePath);
    return `${this.prefix}${agent}/${sessionFile}`;
  }

  private extractAgent(filePath: string): string {
    // Expected path: ~/.openclaw/agents/{agent}/sessions/{sessionId}.jsonl
    const normalized = path.normalize(filePath);
    const parts = normalized.split(path.sep);
    const agentsIdx = parts.indexOf('agents');
    if (agentsIdx !== -1 && agentsIdx + 1 < parts.length) {
      const agent = parts[agentsIdx + 1];
      // Sanitize: only allow alphanumeric, dash, underscore, dot
      if (/^[a-zA-Z0-9._-]+$/.test(agent)) {
        return agent;
      }
    }
    return 'unknown';
  }
}
