import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ProwlConfig } from './types.js';

export type FileChangeCallback = (filePath: string) => void;

export class Watcher {
  private config: ProwlConfig;
  private watcher: FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private onChange: FileChangeCallback;
  private watchedFiles: Set<string> = new Set();

  constructor(config: ProwlConfig, onChange: FileChangeCallback) {
    this.config = config;
    this.onChange = onChange;
  }

  start(): void {
    const dirs = this.getWatchDirs();

    if (dirs.length === 0) {
      console.warn('No watch directories found.');
      return;
    }

    console.log(`Watching ${dirs.length} directory(ies):`);
    for (const d of dirs) console.log(`  ${d}`);
    console.log('');

    this.watcher = chokidar.watch(dirs, {
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('add', (fp) => this.handleFile(fp));
    this.watcher.on('change', (fp) => this.handleFile(fp));
    this.watcher.on('ready', () => console.log('Watcher ready.\n'));
    this.watcher.on('error', (err) => console.error('Watcher error:', err));
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  getWatchedCount(): number {
    return this.watchedFiles.size;
  }

  private handleFile(filePath: string): void {
    // Only process .jsonl and .log files
    if (!filePath.endsWith('.jsonl') && !filePath.endsWith('.log')) return;
    // Skip .deleted files unless configured
    if (filePath.includes('.deleted') && !this.config.watch.include_deleted) return;

    this.watchedFiles.add(filePath);

    // Debounce to batch rapid writes
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.onChange(filePath);
    }, this.config.watch.debounce_ms);

    this.debounceTimers.set(filePath, timer);
  }

  private getWatchDirs(): string[] {
    const base = path.join(os.homedir(), '.openclaw', 'agents');
    const dirs: string[] = [];

    if (!fs.existsSync(base)) return dirs;

    if (this.config.watch.agents === '*') {
      // Find all agent directories that have a sessions/ subdirectory
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const sessDir = path.join(base, entry.name, 'sessions');
          if (fs.existsSync(sessDir)) {
            dirs.push(sessDir);
          }
        }
      }
    } else {
      const agents = this.config.watch.agents.split(',').map((a) => a.trim());
      for (const agent of agents) {
        const sessDir = path.join(base, agent, 'sessions');
        if (fs.existsSync(sessDir)) {
          dirs.push(sessDir);
        }
      }
    }

    // Also watch log files if configured
    if (this.config.scan.include_logs) {
      const logsDir = path.join(os.homedir(), '.openclaw', 'logs');
      if (fs.existsSync(logsDir)) {
        dirs.push(logsDir);
      }
    }

    return dirs;
  }
}
