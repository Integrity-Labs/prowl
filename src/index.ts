import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { execSync, spawn as cpSpawn } from 'node:child_process';
import { loadConfig, setConfigValue, getConfigValue } from './config.js';
import { startDaemonBackground, stopDaemon, Daemon } from './daemon.js';
import { StateManager } from './state.js';
import { Analyzer } from './analyzer.js';
import { readNewLines, parseEvents, extractRelevantContent, batchLines, extractSessionId } from './processor.js';
import { formatAlertForDisplay } from './alerter.js';
import { S3Shipper } from './shipper.js';
import type { ProwlConfig } from './types.js';

const program = new Command();

program
  .name('prowl')
  .description('Security monitor for OpenClaw agent session logs')
  .version('0.1.0');

// --- start ---
program
  .command('start')
  .description('Start the Prowl daemon')
  .option('--model <model>', 'Ollama model to use')
  .option('--agents <agents>', 'Comma-separated agent names to watch')
  .option('--notify <channels>', 'Comma-separated notification channels')
  .option('--foreground', 'Run in foreground (do not daemonize)')
  .option('--s3-bucket <bucket>', 'Enable S3 shipping to this bucket')
  .action(async (opts) => {
    const config = loadConfig();

    if (opts.model) config.model = opts.model;
    if (opts.agents) config.watch.agents = opts.agents;
    if (opts.notify) config.notify.channels = opts.notify.split(',').map((s: string) => s.trim()) as ProwlConfig['notify']['channels'];
    if (opts.s3Bucket) {
      config.s3.enabled = true;
      config.s3.bucket = opts.s3Bucket;
    }

    if (opts.foreground) {
      const daemon = new Daemon(config, { verbose: true });
      await daemon.run();
    } else {
      await startDaemonBackground(config);
    }
  });

// --- setup ---
program
  .command('setup')
  .description('Install Ollama and pull the analysis model')
  .option('--model <model>', 'Model to pull (default: from config)')
  .action(async (opts) => {
    const config = loadConfig();
    const model = opts.model ?? config.model;

    // 1. Check if Ollama is installed
    let ollamaInstalled = false;
    try {
      execSync('which ollama', { stdio: 'ignore' });
      ollamaInstalled = true;
      console.log('✓ Ollama is installed');
    } catch {
      console.log('Ollama is not installed.');
      console.log('Installing via official script...\n');
      try {
        execSync('curl -fsSL https://ollama.com/install.sh | sh', { stdio: 'inherit' });
        ollamaInstalled = true;
        console.log('\n✓ Ollama installed');
      } catch (err) {
        console.error('\nFailed to install Ollama. Install manually from https://ollama.com');
        process.exit(1);
      }
    }

    // 2. Check if Ollama is running
    const analyzer = new Analyzer(config.ollama.host, model);
    let running = await analyzer.checkHealth();

    if (!running) {
      console.log('Ollama is not running. Starting...');
      const child = cpSpawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      // Wait for it to come up
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        running = await analyzer.checkHealth();
        if (running) break;
      }

      if (running) {
        console.log('✓ Ollama is running');
      } else {
        console.error('Could not start Ollama. Try running `ollama serve` manually.');
        process.exit(1);
      }
    } else {
      console.log('✓ Ollama is running');
    }

    // 3. Pull the model
    console.log(`\nPulling model: ${model}`);
    console.log('This may take a while on first run...\n');
    try {
      execSync(`ollama pull ${model}`, { stdio: 'inherit' });
      console.log(`\n✓ Model ${model} is ready`);
    } catch {
      console.error(`\nFailed to pull model ${model}.`);
      console.error('Check that the model name is correct: ollama pull <model>');
      process.exit(1);
    }

    console.log('\nSetup complete. Start monitoring with: prowl start');
  });

// --- stop ---
program
  .command('stop')
  .description('Stop the Prowl daemon')
  .action(() => {
    const config = loadConfig();
    stopDaemon(config.state_dir);
  });

// --- status ---
program
  .command('status')
  .description('Show daemon status')
  .action(() => {
    const config = loadConfig();
    const state = new StateManager(config.state_dir);
    const pid = state.readPid();
    const running = state.isRunning();
    const alertsToday = state.getTodayAlertCount();

    if (running) {
      console.log(`Prowl is running (pid=${pid})`);
      console.log(`  Model: ${config.model}`);
      console.log(`  Ollama: ${config.ollama.host}`);
      console.log(`  Notify: ${config.notify.channels.join(', ')}`);
      console.log(`  Min severity: ${config.notify.min_severity}`);
      console.log(`  Alerts today: ${alertsToday}`);
    } else {
      console.log('Prowl is not running.');
      if (alertsToday > 0) {
        console.log(`  Alerts today: ${alertsToday}`);
      }
    }
  });

// --- scan ---
program
  .command('scan <file>')
  .description('One-shot scan of a specific session file')
  .option('--model <model>', 'Ollama model to use')
  .action(async (file, opts) => {
    const config = loadConfig();
    if (opts.model) config.model = opts.model;

    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const analyzer = new Analyzer(config.ollama.host, config.model);

    const healthy = await analyzer.checkHealth();
    if (!healthy) {
      console.error(`Cannot reach Ollama at ${config.ollama.host}`);
      process.exit(1);
    }

    console.log(`Scanning ${filePath}...`);
    console.log(`  Model: ${config.model}\n`);

    const { lines } = readNewLines(filePath, 0);
    const batches = batchLines(lines, config.scan.batch_lines);

    const sessionId = extractSessionId(filePath, lines);

    let foundSuspicious = false;

    for (let i = 0; i < batches.length; i++) {
      const events = parseEvents(batches[i]);
      const content = extractRelevantContent(events);
      if (content.trim().length === 0) continue;

      console.log(`Analyzing batch ${i + 1}/${batches.length} (${batches[i].length} lines)...`);

      try {
        const verdict = await analyzer.analyze(content, sessionId);
        if (verdict.suspicious) {
          foundSuspicious = true;
          const alert = { timestamp: new Date().toISOString(), file: filePath, verdict };
          console.log('\n' + formatAlertForDisplay(alert) + '\n');
        } else {
          console.log(`  ✓ Batch ${i + 1}: Clean`);
        }
      } catch (err) {
        console.error(`  ✗ Batch ${i + 1}: Analysis error:`, err);
      }
    }

    if (!foundSuspicious) {
      console.log('\n✅ No suspicious activity detected.');
    }
  });

// --- ship ---
program
  .command('ship <file>')
  .description('One-shot upload of a session file to S3')
  .option('--bucket <bucket>', 'S3 bucket name')
  .option('--region <region>', 'AWS region')
  .option('--prefix <prefix>', 'S3 key prefix')
  .option('--endpoint <endpoint>', 'Custom S3 endpoint (R2, MinIO)')
  .action(async (file, opts) => {
    const config = loadConfig();

    const bucket = opts.bucket ?? config.s3.bucket;
    if (!bucket) {
      console.error('No bucket specified. Use --bucket or: prowl config set s3.bucket <name>');
      process.exit(1);
    }

    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const shipper = new S3Shipper({
      bucket,
      region: opts.region ?? config.s3.region,
      prefix: opts.prefix ?? config.s3.prefix,
      endpoint: opts.endpoint ?? config.s3.endpoint,
    });

    console.log(`Shipping ${filePath} to s3://${bucket}/...`);
    try {
      await shipper.ship(filePath);
      console.log('Upload complete.');
    } catch (err) {
      console.error('Upload failed:', err);
      process.exit(1);
    }
  });

// --- tail ---
program
  .command('tail')
  .description('Live stream of alerts to stdout')
  .action(() => {
    const config = loadConfig();
    const state = new StateManager(config.state_dir);

    if (!state.isRunning()) {
      console.log('Prowl is not running. Start it first with: prowl start');
      console.log('Tailing alert history file instead...\n');
    }

    // Tail the alerts file
    const alertsPath = state.getAlertsPath();

    if (!fs.existsSync(alertsPath)) {
      console.log('No alerts yet.');
    } else {
      // Print recent alerts
      const alerts = state.getAlerts();
      const recent = alerts.slice(-10);
      if (recent.length > 0) {
        console.log(`--- Last ${recent.length} alerts ---\n`);
        for (const alert of recent) {
          console.log(formatAlertForDisplay(alert) + '\n');
        }
      }
    }

    // Watch for new alerts
    console.log('Watching for new alerts... (Ctrl+C to stop)\n');

    let lastSize = fs.existsSync(alertsPath) ? fs.statSync(alertsPath).size : 0;

    const interval = setInterval(() => {
      if (!fs.existsSync(alertsPath)) return;
      const stat = fs.statSync(alertsPath);
      if (stat.size > lastSize) {
        const fd = fs.openSync(alertsPath, 'r');
        try {
          const buf = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          lastSize = stat.size;

          const newLines = buf.toString('utf-8').trim().split('\n').filter(Boolean);
          for (const line of newLines) {
            try {
              const alert = JSON.parse(line);
              console.log(formatAlertForDisplay(alert) + '\n');
            } catch { /* skip */ }
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    }, 1000);

    process.on('SIGINT', () => {
      clearInterval(interval);
      process.exit(0);
    });
  });

// --- history ---
program
  .command('history')
  .description('View past alerts')
  .option('--since <duration>', 'Duration (e.g., 1h, 24h, 7d)', '24h')
  .action((opts) => {
    const config = loadConfig();
    const state = new StateManager(config.state_dir);

    const since = parseDuration(opts.since);
    const alerts = state.getAlerts(since);

    if (alerts.length === 0) {
      console.log(`No alerts in the last ${opts.since}.`);
      return;
    }

    console.log(`Found ${alerts.length} alert(s) since ${since.toISOString()}:\n`);
    for (const alert of alerts) {
      console.log(formatAlertForDisplay(alert) + '\n');
    }
  });

// --- usage ---
program
  .command('usage')
  .description('Show token usage statistics')
  .option('--hourly', 'Show hourly breakdown')
  .option('--daily', 'Show daily breakdown')
  .option('--since <duration>', 'Time range (e.g., 1h, 24h, 7d)', '24h')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const config = loadConfig();
    const state = new StateManager(config.state_dir);
    state.loadUsage();

    const since = parseDuration(opts.since);

    if (opts.hourly || opts.daily) {
      const period = opts.hourly ? 'hour' as const : 'day' as const;
      const buckets = state.aggregateUsageByPeriod(since, period);

      if (buckets.size === 0) {
        console.log(`No usage data in the last ${opts.since}.`);
        return;
      }

      if (opts.json) {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of buckets) obj[k] = v;
        console.log(JSON.stringify(obj, null, 2));
        return;
      }

      const label = period === 'hour' ? 'Hourly' : 'Daily';
      console.log(`${label} usage (since ${opts.since} ago):\n`);
      console.log(`  ${'Period'.padEnd(20)} ${'Tokens'.padStart(10)} ${'In'.padStart(8)} ${'Out'.padStart(8)} ${'Cost'.padStart(10)} ${'Reqs'.padStart(6)}`);
      console.log(`  ${'─'.repeat(20)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(6)}`);

      let grandTotal = { tokens: 0, input: 0, output: 0, cost: 0, requests: 0 };
      for (const [key, s] of buckets) {
        console.log(`  ${key.padEnd(20)} ${s.totalTokens.toLocaleString().padStart(10)} ${s.input.toLocaleString().padStart(8)} ${s.output.toLocaleString().padStart(8)} ${('$' + s.cost.toFixed(4)).padStart(10)} ${String(s.requests).padStart(6)}`);
        grandTotal.tokens += s.totalTokens;
        grandTotal.input += s.input;
        grandTotal.output += s.output;
        grandTotal.cost += s.cost;
        grandTotal.requests += s.requests;
      }
      console.log(`  ${'─'.repeat(20)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(6)}`);
      console.log(`  ${'TOTAL'.padEnd(20)} ${grandTotal.tokens.toLocaleString().padStart(10)} ${grandTotal.input.toLocaleString().padStart(8)} ${grandTotal.output.toLocaleString().padStart(8)} ${('$' + grandTotal.cost.toFixed(4)).padStart(10)} ${String(grandTotal.requests).padStart(6)}`);
      return;
    }

    // Default: aggregate summary
    const usage = state.getUsage();
    const total = state.getTotalUsage();
    const sessions = Object.keys(usage);

    if (sessions.length === 0) {
      console.log('No usage data yet.');
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify({ sessions: usage, total }, null, 2));
      return;
    }

    console.log(`Token usage across ${sessions.length} session(s):\n`);
    console.log(`  Total input:      ${total.input.toLocaleString()} tokens`);
    console.log(`  Total output:     ${total.output.toLocaleString()} tokens`);
    console.log(`  Cache read:       ${total.cacheRead.toLocaleString()} tokens`);
    console.log(`  Cache write:      ${total.cacheWrite.toLocaleString()} tokens`);
    console.log(`  Total tokens:     ${total.totalTokens.toLocaleString()}`);
    console.log(`  Total cost:       $${total.cost.toFixed(4)}`);
    console.log(`  Total requests:   ${total.requests}`);

    // Top 5 sessions by cost
    const sorted = sessions
      .map((id) => ({ id, ...usage[id] }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5);

    if (sorted.length > 0 && sorted[0].cost > 0) {
      console.log(`\nTop sessions by cost:`);
      for (const s of sorted) {
        console.log(`  ${s.id.slice(0, 12)}…  $${s.cost.toFixed(4)}  (${s.totalTokens.toLocaleString()} tokens, ${s.requests} req)`);
      }
    }
  });

// --- config ---
const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key, value) => {
    setConfigValue(key, value);
    console.log(`Set ${key} = ${value}`);
  });

configCmd
  .command('get [key]')
  .description('Get a configuration value')
  .action((key) => {
    const value = getConfigValue(key);
    if (value === undefined) {
      console.log(`Key "${key}" not found.`);
    } else {
      console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    }
  });

// --- Helpers ---
function parseDuration(s: string): Date {
  const match = s.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    console.error(`Invalid duration: ${s}. Use format like 1h, 24h, 7d`);
    process.exit(1);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();

  switch (unit) {
    case 'm': now.setMinutes(now.getMinutes() - amount); break;
    case 'h': now.setHours(now.getHours() - amount); break;
    case 'd': now.setDate(now.getDate() - amount); break;
  }

  return now;
}

program.parse();
