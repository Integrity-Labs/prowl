import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ProwlConfig, Alert } from './types.js';
import { StateManager } from './state.js';
import { Watcher } from './watcher.js';
import { Analyzer } from './analyzer.js';
import { AlertDispatcher } from './alerter.js';
import { readNewLines, parseEvents, extractRelevantContent, extractUsage, batchLines, extractSessionId } from './processor.js';
import { S3Shipper } from './shipper.js';

export class Daemon {
  private config: ProwlConfig;
  private state: StateManager;
  private watcher: Watcher | null = null;
  private analyzer: Analyzer;
  private alerter: AlertDispatcher;
  private processing: boolean = false;
  private queue: string[] = [];
  private verbose: boolean;
  private shipper: S3Shipper | null = null;

  constructor(config: ProwlConfig, opts?: { verbose?: boolean }) {
    this.config = config;
    this.verbose = opts?.verbose ?? false;
    this.state = new StateManager(config.state_dir);
    this.analyzer = new Analyzer(config.ollama.host, config.model);
    this.alerter = new AlertDispatcher(config);

    if (config.s3.enabled && config.s3.bucket) {
      this.shipper = new S3Shipper({
        bucket: config.s3.bucket,
        region: config.s3.region,
        prefix: config.s3.prefix,
        endpoint: config.s3.endpoint,
        flush_interval_s: config.s3.flush_interval_s,
        flush_max_bytes: config.s3.flush_max_bytes,
        onError: (err) => this.state.log(`S3 flush error: ${err}`),
      });
    }
  }

  async run(): Promise<void> {
    this.state.loadOffsets();
    this.state.loadUsage();
    this.seedOffsetsForExistingFiles();
    this.state.writePid(process.pid);
    this.state.log(`Daemon started (pid=${process.pid}, model=${this.config.model})`);

    // Check Ollama health
    const healthy = await this.analyzer.checkHealth();
    if (!healthy) {
      this.state.log('WARNING: Ollama is not reachable. Alerts will fail until Ollama is available.');
      console.warn('⚠️  Ollama is not reachable at', this.config.ollama.host);
      console.warn('   Prowl will still watch files but analysis will fail.');
      console.warn('   Start Ollama and ensure the model is available.\n');
    }

    this.watcher = new Watcher(this.config, (fp) => this.enqueueFile(fp));
    this.watcher.start();

    if (this.shipper) {
      this.shipper.startFlushing();
    }

    console.log(`Prowl daemon running (pid=${process.pid})`);
    console.log(`  Model: ${this.config.model}`);
    console.log(`  Ollama: ${this.config.ollama.host}`);
    console.log(`  Notify: ${this.config.notify.channels.join(', ')}`);
    console.log(`  Min severity: ${this.config.notify.min_severity}`);
    if (this.shipper) {
      console.log(`  S3: ${this.config.s3.bucket} (${this.config.s3.region})`);
    }
    console.log('');

    // Graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      this.state.log('Daemon shutting down');
      console.log('\nShutting down Prowl...');
      this.watcher?.stop();
      // Wait for in-flight processing to finish
      while (this.processing) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // Flush remaining S3 buffers before exit
      if (this.shipper) {
        this.shipper.stopFlushing();
        try {
          await this.shipper.flushAll();
        } catch (err) {
          this.state.log(`S3 final flush error: ${err}`);
        }
      }
      this.state.saveOffsets();
      this.state.removePid();
      process.exit(0);
    };

    process.on('SIGTERM', () => { shutdown(); });
    process.on('SIGINT', () => { shutdown(); });
  }

  private static readonly MAX_QUEUE_SIZE = 1000;

  private enqueueFile(filePath: string): void {
    if (!this.queue.includes(filePath)) {
      if (this.queue.length >= Daemon.MAX_QUEUE_SIZE) {
        this.state.log(`Queue full (${Daemon.MAX_QUEUE_SIZE}), dropping: ${filePath}`);
        return;
      }
      this.queue.push(filePath);
    }
    this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const filePath = this.queue.shift()!;
      await this.processFile(filePath);
    }

    this.processing = false;
  }

  private async processFile(filePath: string): Promise<void> {
    try {
      const offset = this.state.getOffset(filePath);
      const { lines, newOffset } = readNewLines(filePath, offset);

      if (lines.length === 0) return;

      // Buffer delta lines to S3 if configured
      if (this.shipper) {
        this.shipper.buffer(filePath, lines);
      }

      const name = path.basename(filePath);

      // Extract session ID from file name or first session event
      const sessionId = extractSessionId(filePath, lines);

      // Track usage across all lines
      const allEvents = parseEvents(lines);
      const usage = extractUsage(allEvents);
      if (usage.requests > 0) {
        this.state.addUsage(sessionId, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost);
        this.state.saveUsage();
        if (this.verbose && usage.cost > 0) {
          console.log(`📊 ${name} — ${usage.input} in / ${usage.output} out, $${usage.cost.toFixed(4)}`);
        }
      }

      // Batch and analyze
      const batches = batchLines(lines, this.config.scan.batch_lines);
      let suspicious = false;

      for (let i = 0; i < batches.length; i++) {
        const events = parseEvents(batches[i]);
        const content = extractRelevantContent(events);

        if (content.trim().length === 0) continue;

        try {
          const verdict = await this.analyzer.analyze(content, sessionId);

          if (verdict.suspicious) {
            suspicious = true;
            const alert: Alert = {
              timestamp: new Date().toISOString(),
              file: filePath,
              verdict,
            };
            this.state.appendAlert(alert);
            await this.alerter.dispatch(alert);

            if (this.verbose) {
              console.log(`⚠️  ${name} [${verdict.severity.toUpperCase()}] ${verdict.summary}`);
              if (verdict.indicators.length > 0) {
                console.log(`   Indicators: ${verdict.indicators.join(', ')}`);
              }
            }
          }
        } catch (err) {
          const msg = `Analysis error for ${name}: ${err}`;
          this.state.log(msg);
          if (this.verbose) {
            console.error(`✗  ${name} — ${err}`);
          }
        }
      }

      if (this.verbose && !suspicious) {
        console.log(`✓  ${name} — clean`);
      }

      this.state.setOffset(filePath, newOffset);
      this.state.saveOffsets();
    } catch (err) {
      this.state.log(`File processing error for ${filePath}: ${err}`);
    }
  }

  private seedOffsetsForExistingFiles(): void {
    const base = path.join(os.homedir(), '.openclaw', 'agents');
    if (!fs.existsSync(base)) return;

    const dirs: string[] = [];
    if (this.config.watch.agents === '*') {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const sessDir = path.join(base, entry.name, 'sessions');
          if (fs.existsSync(sessDir)) dirs.push(sessDir);
        }
      }
    } else {
      for (const agent of this.config.watch.agents.split(',').map((a) => a.trim())) {
        const sessDir = path.join(base, agent, 'sessions');
        if (fs.existsSync(sessDir)) dirs.push(sessDir);
      }
    }

    let seeded = 0;
    for (const dir of dirs) {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(dir, file);
        if (this.state.getOffset(filePath) === 0) {
          const stat = fs.statSync(filePath);
          this.state.setOffset(filePath, stat.size);
          seeded++;
        }
      }
    }

    if (seeded > 0) {
      this.state.saveOffsets();
      this.state.log(`Seeded offsets for ${seeded} existing files (skipping old content)`);
      if (this.verbose) {
        console.log(`Skipped ${seeded} existing file(s) — only new activity will be analyzed.\n`);
      }
    }
  }

  getAlerter(): AlertDispatcher {
    return this.alerter;
  }

  getState(): StateManager {
    return this.state;
  }

  getWatcher(): Watcher | null {
    return this.watcher;
  }
}

export async function startDaemonBackground(config: ProwlConfig): Promise<number> {
  const state = new StateManager(config.state_dir);

  if (state.isRunning()) {
    const pid = state.readPid();
    console.log(`Prowl is already running (pid=${pid})`);
    process.exit(1);
  }

  const thisFile = fileURLToPath(import.meta.url);
  const entryPoint = path.resolve(path.dirname(thisFile), 'daemon-entry.js');

  const logPath = state.getLogPath();
  const logFd = fs.openSync(logPath, 'a');

  let child;
  try {
    child = spawn(process.execPath, [entryPoint], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, PROWL_CONFIG: JSON.stringify(config) },
    });
  } finally {
    fs.closeSync(logFd);
  }

  child.unref();
  const pid = child.pid;

  if (!pid) {
    console.error('Failed to spawn daemon process.');
    process.exit(1);
  }

  // Wait briefly to verify startup
  await new Promise((r) => setTimeout(r, 500));

  if (state.isRunning()) {
    console.log(`Prowl daemon started (pid=${pid})`);
    console.log(`  Log: ${logPath}`);
  } else {
    console.error('Failed to start daemon. Check logs:', logPath);
    process.exit(1);
  }

  return pid;
}

export function stopDaemon(stateDir: string): void {
  const state = new StateManager(stateDir);
  const pid = state.readPid();

  if (pid === null || !state.isRunning()) {
    console.log('Prowl is not running.');
    state.removePid();
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to Prowl (pid=${pid})`);
    // Wait for clean shutdown
    let tries = 0;
    const check = setInterval(() => {
      tries++;
      if (!state.isRunning() || tries > 10) {
        clearInterval(check);
        if (state.isRunning()) {
          console.log('Force killing...');
          try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
        }
        state.removePid();
        console.log('Prowl stopped.');
      }
    }, 500);
  } catch {
    console.log('Prowl process not found. Cleaning up PID file.');
    state.removePid();
  }
}
