import type { ProwlConfig } from './types.js';
import { loadConfig } from './config.js';
import { startWatchdog } from './watchdog.js';

// Entry point for background watchdog process
let config: ProwlConfig;
try {
  config = process.env.PROWL_CONFIG
    ? JSON.parse(process.env.PROWL_CONFIG)
    : loadConfig();
} catch (err) {
  console.error('Watchdog: failed to parse config:', err);
  process.exit(1);
}

startWatchdog(config);
