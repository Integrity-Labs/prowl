import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { loadPublicKey, encrypt } from './crypto.js';

interface BufferEntry {
  lines: string[];
  bytes: number;
}

export class S3Shipper {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private flushIntervalMs: number;
  private flushMaxBytes: number;
  private onError: ((err: unknown) => void) | null;
  private publicKey: Buffer | null = null;
  private buffers: Map<string, BufferEntry> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    bucket: string;
    region: string;
    prefix: string;
    endpoint?: string | null;
    flush_interval_s?: number;
    flush_max_bytes?: number;
    publicKeyPath?: string | null;
    onError?: (err: unknown) => void;
  }) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix;
    this.flushIntervalMs = (opts.flush_interval_s ?? 60) * 1000;
    this.flushMaxBytes = opts.flush_max_bytes ?? 262144;
    this.onError = opts.onError ?? null;

    if (opts.publicKeyPath) {
      try {
        this.publicKey = loadPublicKey(opts.publicKeyPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: could not load public key: ${msg} — shipping unencrypted`);
      }
    }

    const clientOpts: ConstructorParameters<typeof S3Client>[0] = {
      region: opts.region,
    };

    if (opts.endpoint) {
      clientOpts.endpoint = opts.endpoint;
      clientOpts.forcePathStyle = true;
    }

    this.client = new S3Client(clientOpts);
  }

  /** Returns whether client-side encryption is active. */
  get encrypted(): boolean {
    return this.publicKey !== null;
  }

  /** Encrypt body if a public key is configured. Returns the body, content type, and key suffix. */
  private prepareBody(body: Buffer | string): { body: Buffer | string; contentType: string; suffix: string } {
    if (!this.publicKey) {
      return { body, contentType: 'application/x-ndjson', suffix: '' };
    }
    return {
      body: encrypt(typeof body === 'string' ? Buffer.from(body, 'utf-8') : body, this.publicKey),
      contentType: 'application/octet-stream',
      suffix: '.enc',
    };
  }

  /** One-shot full-file upload (used by `prowl ship <file>` CLI command). */
  async ship(filePath: string): Promise<void> {
    const raw = fs.readFileSync(filePath);
    const { body, contentType, suffix } = this.prepareBody(raw);
    const key = this.buildKey(filePath) + suffix;

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  }

  /** One-shot upload with an explicit S3 key (no path derivation). */
  async shipAs(filePath: string, key: string): Promise<void> {
    const raw = fs.readFileSync(filePath);
    const { body, contentType, suffix } = this.prepareBody(raw);

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key + suffix,
      Body: body,
      ContentType: contentType,
    }));
  }

  /** Append delta lines to the in-memory buffer. Flushes immediately if buffer exceeds max bytes. */
  buffer(filePath: string, lines: string[]): void {
    if (lines.length === 0) return;

    let entry = this.buffers.get(filePath);
    if (!entry) {
      entry = { lines: [], bytes: 0 };
      this.buffers.set(filePath, entry);
    }

    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline
      entry.lines.push(line);
      entry.bytes += lineBytes;
    }

    if (entry.bytes >= this.flushMaxBytes) {
      this.flush(filePath).catch((err) => this.handleError(err));
    }
  }

  /** Flush buffered lines for a single file to S3 as a timestamped NDJSON chunk. */
  async flush(filePath: string): Promise<void> {
    const entry = this.buffers.get(filePath);
    if (!entry || entry.lines.length === 0) return;

    // Take the buffered lines and clear the buffer atomically
    const lines = entry.lines;
    this.buffers.set(filePath, { lines: [], bytes: 0 });

    const raw = lines.join('\n') + '\n';
    const { body, contentType, suffix } = this.prepareBody(raw);
    const key = this.buildChunkKey(filePath) + suffix;

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  }

  /** Flush all buffered files. Used on shutdown and by the periodic timer. */
  async flushAll(): Promise<void> {
    const paths = [...this.buffers.keys()];
    for (const filePath of paths) {
      try {
        await this.flush(filePath);
      } catch (err) {
        this.handleError(err);
      }
    }
  }

  /** Start the periodic flush timer. */
  startFlushing(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flushAll().catch((err) => this.handleError(err));
    }, this.flushIntervalMs);
  }

  /** Stop the periodic flush timer. */
  stopFlushing(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private buildKey(filePath: string): string {
    const agent = this.extractAgent(filePath);
    const sessionFile = path.basename(filePath);
    return `${this.prefix}${agent}/${sessionFile}`;
  }

  private buildChunkKey(filePath: string): string {
    const agent = this.extractAgent(filePath);
    const sessionId = path.basename(filePath, path.extname(filePath));
    const timestamp = Date.now();
    return `${this.prefix}${agent}/${sessionId}/${timestamp}.ndjson`;
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

  private handleError(err: unknown): void {
    if (this.onError) {
      this.onError(err);
    }
  }
}
