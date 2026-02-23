import fs from 'node:fs';
import path from 'node:path';
import type { Alert, FileOffsets, UsageEvent, UsageRecord, UsageStats } from './types.js';

const EMPTY_USAGE: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, requests: 0 };

export class StateManager {
  private stateDir: string;
  private offsets: FileOffsets = {};
  private usage: UsageRecord = {};
  private offsetsPath: string;
  private alertsPath: string;
  private usagePath: string;
  private usageLogPath: string;
  private pidPath: string;
  private logPath: string;
  private heartbeatPath: string;
  private heartbeatTmpPath: string;
  private watchdogPidPath: string;
  private stopSentinelPath: string;
  private crashLoopPath: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.offsetsPath = path.join(stateDir, 'offsets.json');
    this.alertsPath = path.join(stateDir, 'alerts.jsonl');
    this.usagePath = path.join(stateDir, 'usage.json');
    this.usageLogPath = path.join(stateDir, 'usage.jsonl');
    this.pidPath = path.join(stateDir, 'prowl.pid');
    this.logPath = path.join(stateDir, 'prowl.log');
    this.heartbeatPath = path.join(stateDir, 'heartbeat');
    this.heartbeatTmpPath = path.join(stateDir, 'heartbeat.tmp');
    this.watchdogPidPath = path.join(stateDir, 'watchdog.pid');
    this.stopSentinelPath = path.join(stateDir, 'prowl.stopped');
    this.crashLoopPath = path.join(stateDir, 'prowl.crashloop');
    fs.mkdirSync(stateDir, { recursive: true });
  }

  loadOffsets(): FileOffsets {
    if (fs.existsSync(this.offsetsPath)) {
      try {
        this.offsets = JSON.parse(fs.readFileSync(this.offsetsPath, 'utf-8'));
      } catch {
        this.offsets = {};
      }
    }
    return this.offsets;
  }

  saveOffsets(): void {
    fs.writeFileSync(this.offsetsPath, JSON.stringify(this.offsets, null, 2));
  }

  getOffset(filePath: string): number {
    return this.offsets[filePath] ?? 0;
  }

  setOffset(filePath: string, offset: number): void {
    this.offsets[filePath] = offset;
  }

  appendAlert(alert: Alert): void {
    fs.appendFileSync(this.alertsPath, JSON.stringify(alert) + '\n');
  }

  getAlerts(since?: Date): Alert[] {
    if (!fs.existsSync(this.alertsPath)) return [];
    const lines = fs.readFileSync(this.alertsPath, 'utf-8').trim().split('\n').filter(Boolean);
    let alerts = lines.map((l) => {
      try { return JSON.parse(l) as Alert; } catch { return null; }
    }).filter((a): a is Alert => a !== null);

    if (since) {
      const sinceMs = since.getTime();
      alerts = alerts.filter((a) => new Date(a.timestamp).getTime() >= sinceMs);
    }
    return alerts;
  }

  writePid(pid: number): void {
    fs.writeFileSync(this.pidPath, String(pid));
  }

  readPid(): number | null {
    if (!fs.existsSync(this.pidPath)) return null;
    const pid = parseInt(fs.readFileSync(this.pidPath, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  }

  removePid(): void {
    if (fs.existsSync(this.pidPath)) fs.unlinkSync(this.pidPath);
  }

  isRunning(): boolean {
    const pid = this.readPid();
    if (pid === null) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  log(message: string): void {
    const ts = new Date().toISOString();
    fs.appendFileSync(this.logPath, `[${ts}] ${message}\n`);
  }

  getLogPath(): string {
    return this.logPath;
  }

  getAlertsPath(): string {
    return this.alertsPath;
  }

  getTodayAlertCount(): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.getAlerts(today).length;
  }

  loadUsage(): UsageRecord {
    if (fs.existsSync(this.usagePath)) {
      try {
        this.usage = JSON.parse(fs.readFileSync(this.usagePath, 'utf-8'));
      } catch {
        this.usage = {};
      }
    }
    return this.usage;
  }

  saveUsage(): void {
    fs.writeFileSync(this.usagePath, JSON.stringify(this.usage, null, 2));
  }

  addUsage(sessionId: string, input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number, cost: number): void {
    if (!this.usage[sessionId]) {
      this.usage[sessionId] = { ...EMPTY_USAGE };
    }
    const s = this.usage[sessionId];
    s.input += input;
    s.output += output;
    s.cacheRead += cacheRead;
    s.cacheWrite += cacheWrite;
    s.totalTokens += totalTokens;
    s.cost += cost;
    s.requests++;

    // Append to time-series log
    const event: UsageEvent = {
      timestamp: new Date().toISOString(),
      sessionId, input, output, cacheRead, cacheWrite, totalTokens, cost,
    };
    fs.appendFileSync(this.usageLogPath, JSON.stringify(event) + '\n');
  }

  getUsage(): UsageRecord {
    return this.usage;
  }

  getUsageEvents(since?: Date): UsageEvent[] {
    if (!fs.existsSync(this.usageLogPath)) return [];
    const lines = fs.readFileSync(this.usageLogPath, 'utf-8').trim().split('\n').filter(Boolean);
    let events = lines.map((l) => {
      try { return JSON.parse(l) as UsageEvent; } catch { return null; }
    }).filter((e): e is UsageEvent => e !== null);

    if (since) {
      const sinceMs = since.getTime();
      events = events.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
    }
    return events;
  }

  aggregateUsageByPeriod(since: Date, period: 'hour' | 'day'): Map<string, UsageStats> {
    const events = this.getUsageEvents(since);
    const buckets = new Map<string, UsageStats>();

    for (const e of events) {
      const d = new Date(e.timestamp);
      let key: string;
      if (period === 'hour') {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
      } else {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      if (!buckets.has(key)) {
        buckets.set(key, { ...EMPTY_USAGE });
      }
      const b = buckets.get(key)!;
      b.input += e.input;
      b.output += e.output;
      b.cacheRead += e.cacheRead;
      b.cacheWrite += e.cacheWrite;
      b.totalTokens += e.totalTokens;
      b.cost += e.cost;
      b.requests++;
    }

    return buckets;
  }

  getTotalUsage(): UsageStats {
    const total = { ...EMPTY_USAGE };
    for (const s of Object.values(this.usage)) {
      total.input += s.input;
      total.output += s.output;
      total.cacheRead += s.cacheRead;
      total.cacheWrite += s.cacheWrite;
      total.totalTokens += s.totalTokens;
      total.cost += s.cost;
      total.requests += s.requests;
    }
    return total;
  }

  // --- Heartbeat ---

  writeHeartbeat(): void {
    fs.writeFileSync(this.heartbeatTmpPath, String(Date.now()));
    fs.renameSync(this.heartbeatTmpPath, this.heartbeatPath);
  }

  readHeartbeat(): number | null {
    if (!fs.existsSync(this.heartbeatPath)) return null;
    try {
      const ts = parseInt(fs.readFileSync(this.heartbeatPath, 'utf-8').trim(), 10);
      return isNaN(ts) ? null : ts;
    } catch {
      return null;
    }
  }

  removeHeartbeat(): void {
    if (fs.existsSync(this.heartbeatPath)) fs.unlinkSync(this.heartbeatPath);
    if (fs.existsSync(this.heartbeatTmpPath)) fs.unlinkSync(this.heartbeatTmpPath);
  }

  // --- Watchdog PID ---

  writeWatchdogPid(pid: number): void {
    fs.writeFileSync(this.watchdogPidPath, String(pid));
  }

  readWatchdogPid(): number | null {
    if (!fs.existsSync(this.watchdogPidPath)) return null;
    const pid = parseInt(fs.readFileSync(this.watchdogPidPath, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  }

  removeWatchdogPid(): void {
    if (fs.existsSync(this.watchdogPidPath)) fs.unlinkSync(this.watchdogPidPath);
  }

  isWatchdogRunning(): boolean {
    const pid = this.readWatchdogPid();
    if (pid === null) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // --- Stop sentinel ---

  writeStopSentinel(): void {
    fs.writeFileSync(this.stopSentinelPath, String(Date.now()));
  }

  hasStopSentinel(): boolean {
    return fs.existsSync(this.stopSentinelPath);
  }

  removeStopSentinel(): void {
    if (fs.existsSync(this.stopSentinelPath)) fs.unlinkSync(this.stopSentinelPath);
  }

  // --- Crash-loop marker ---

  writeCrashLoopMarker(): void {
    fs.writeFileSync(this.crashLoopPath, new Date().toISOString());
  }

  hasCrashLoopMarker(): boolean {
    return fs.existsSync(this.crashLoopPath);
  }

  removeCrashLoopMarker(): void {
    if (fs.existsSync(this.crashLoopPath)) fs.unlinkSync(this.crashLoopPath);
  }
}
