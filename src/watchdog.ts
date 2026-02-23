import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ProwlConfig } from './types.js';
import { StateManager } from './state.js';

export function startWatchdog(config: ProwlConfig): void {
  const state = new StateManager(config.state_dir);
  state.writeWatchdogPid(process.pid);
  state.log(`Watchdog started (pid=${process.pid})`);

  const {
    staleness_threshold_s,
    poll_interval_s,
    max_respawns,
    crash_window_s,
  } = config.watchdog;

  const respawnTimestamps: number[] = [];

  const pollTimer = setInterval(() => {
    // 1. Check stop sentinel
    if (state.hasStopSentinel()) {
      state.log('Watchdog: stop sentinel detected, exiting');
      cleanup();
      return;
    }

    // 2. Read heartbeat
    const heartbeat = state.readHeartbeat();
    const now = Date.now();

    // 3. If heartbeat is fresh, nothing to do
    if (heartbeat !== null && (now - heartbeat) < staleness_threshold_s * 1000) {
      return;
    }

    // 4. Stale or missing heartbeat — daemon may be dead or hung
    state.log(`Watchdog: stale heartbeat detected (age=${heartbeat ? Math.round((now - heartbeat) / 1000) + 's' : 'missing'})`);

    // 4a. If PID still alive, it's hung — SIGKILL it
    const daemonPid = state.readPid();
    if (daemonPid !== null) {
      try {
        process.kill(daemonPid, 0); // test if alive
        state.log(`Watchdog: daemon pid=${daemonPid} still alive but heartbeat stale, sending SIGKILL`);
        try { process.kill(daemonPid, 'SIGKILL'); } catch { /* already dead */ }
      } catch {
        // Process already dead
      }
      state.removePid();
    }

    // 4b. Clean up stale heartbeat
    state.removeHeartbeat();

    // 4c. Crash-loop protection
    const cutoff = now - crash_window_s * 1000;
    // Prune old timestamps
    while (respawnTimestamps.length > 0 && respawnTimestamps[0] < cutoff) {
      respawnTimestamps.shift();
    }

    if (respawnTimestamps.length >= max_respawns) {
      state.log(`Watchdog: crash-loop detected (${respawnTimestamps.length} respawns in ${crash_window_s}s), giving up`);
      state.writeCrashLoopMarker();
      cleanup();
      return;
    }

    // 4d. Re-check stop sentinel before respawning (race condition guard)
    if (state.hasStopSentinel()) {
      state.log('Watchdog: stop sentinel detected before respawn, exiting');
      cleanup();
      return;
    }

    // 4e. Respawn daemon (without re-spawning watchdog)
    respawnTimestamps.push(now);
    state.log('Watchdog: respawning daemon');
    respawnDaemon(config, state);
  }, poll_interval_s * 1000);

  function cleanup(): void {
    clearInterval(pollTimer);
    state.removeWatchdogPid();
    process.exit(0);
  }

  // Signal handlers
  process.on('SIGTERM', () => {
    state.log('Watchdog: received SIGTERM, exiting');
    cleanup();
  });
  process.on('SIGINT', () => {
    state.log('Watchdog: received SIGINT, exiting');
    cleanup();
  });
}

function respawnDaemon(config: ProwlConfig, state: StateManager): void {
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

  if (child.pid) {
    state.log(`Watchdog: daemon respawned (pid=${child.pid})`);
  } else {
    state.log('Watchdog: failed to respawn daemon');
  }
}
