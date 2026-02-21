import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProwlConfig } from './types.js';

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.prowl');

const DEFAULT_CONFIG: ProwlConfig = {
  model: 'gpt-oss-safeguard:20b',
  ollama: { host: 'http://localhost:11434' },
  watch: {
    agents: '*',
    include_deleted: false,
    debounce_ms: 2000,
  },
  notify: {
    channels: ['stdout'],
    min_severity: 'medium',
    webhook: { url: null },
  },
  scan: {
    batch_lines: 20,
    include_logs: true,
  },
  s3: {
    enabled: false,
    bucket: null,
    region: 'auto',
    prefix: 'prowl/',
    endpoint: null,
  },
  state_dir: DEFAULT_STATE_DIR,
};

export function getStateDir(config?: Partial<ProwlConfig>): string {
  return config?.state_dir ?? DEFAULT_STATE_DIR;
}

export function configPath(stateDir?: string): string {
  return path.join(stateDir ?? DEFAULT_STATE_DIR, 'config.json');
}

export function loadConfig(stateDir?: string): ProwlConfig {
  const dir = stateDir ?? DEFAULT_STATE_DIR;
  const cfgPath = configPath(dir);
  let fileConfig: Partial<ProwlConfig> = {};

  if (fs.existsSync(cfgPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (err) {
      console.warn(`Warning: could not parse ${cfgPath}, using defaults:`, err instanceof Error ? err.message : err);
    }
  }

  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    fileConfig as unknown as Record<string, unknown>,
  ) as unknown as ProwlConfig;

  return validateConfig(merged);
}

export function saveConfig(config: ProwlConfig): void {
  const dir = config.state_dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(dir), JSON.stringify(config, null, 2) + '\n');
}

export function setConfigValue(key: string, value: string): void {
  const config = loadConfig();
  const parts = key.split('.');
  let obj: Record<string, unknown> = config as unknown as Record<string, unknown>;

  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) {
      obj[parts[i]] = {};
    }
    obj = obj[parts[i]] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];

  // Try to parse as JSON for arrays/numbers/booleans
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value);
  } catch {
    // keep as string
  }

  obj[lastKey] = parsed;
  saveConfig(config);
}

export function getConfigValue(key?: string): unknown {
  const config = loadConfig();
  if (!key) return config;

  const parts = key.split('.');
  let obj: unknown = config;

  for (const part of parts) {
    if (typeof obj !== 'object' || obj === null) return undefined;
    obj = (obj as Record<string, unknown>)[part];
  }

  return obj;
}

function validateConfig(config: ProwlConfig): ProwlConfig {
  if (config.scan.batch_lines < 1) config.scan.batch_lines = 20;
  if (config.watch.debounce_ms < 0) config.watch.debounce_ms = 0;
  const validSeverities = ['low', 'medium', 'high', 'critical'];
  if (!validSeverities.includes(config.notify.min_severity)) {
    config.notify.min_severity = 'medium';
  }
  return config;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
