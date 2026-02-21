import type { ProwlConfig } from './types.js';
import { loadConfig } from './config.js';
import { Daemon } from './daemon.js';

// Entry point for background daemon process
let config: ProwlConfig;
try {
  config = process.env.PROWL_CONFIG
    ? JSON.parse(process.env.PROWL_CONFIG)
    : loadConfig();
} catch (err) {
  console.error('Failed to parse config:', err);
  process.exit(1);
}

const daemon = new Daemon(config);
daemon.run().catch((err) => {
  console.error('Daemon fatal error:', err);
  // Clean up PID file on crash
  try { daemon.getState().removePid(); } catch { /* best effort */ }
  process.exit(1);
});
