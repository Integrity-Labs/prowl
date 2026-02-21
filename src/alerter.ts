import { execFile } from 'node:child_process';
import type { Alert, ProwlConfig, NotifyChannel, Severity } from './types.js';
import { SEVERITY_ORDER } from './types.js';

export type AlertCallback = (alert: Alert) => void;

export class AlertDispatcher {
  private channels: NotifyChannel[];
  private minSeverity: Severity;
  private webhookUrl: string | null;
  private tailListeners: Set<AlertCallback> = new Set();

  constructor(config: ProwlConfig) {
    this.channels = config.notify.channels;
    this.minSeverity = config.notify.min_severity;
    this.webhookUrl = config.notify.webhook.url;
  }

  onTail(cb: AlertCallback): () => void {
    this.tailListeners.add(cb);
    return () => this.tailListeners.delete(cb);
  }

  async dispatch(alert: Alert): Promise<void> {
    if (SEVERITY_ORDER[alert.verdict.severity] < SEVERITY_ORDER[this.minSeverity]) {
      return;
    }

    const promises: Promise<void>[] = [];

    for (const channel of this.channels) {
      switch (channel) {
        case 'stdout':
          promises.push(this.notifyStdout(alert));
          break;
        case 'macos':
          promises.push(this.notifyMacOS(alert));
          break;
        case 'openclaw':
          promises.push(this.notifyOpenClaw(alert));
          break;
        case 'webhook':
          promises.push(this.notifyWebhook(alert));
          break;
      }
    }

    // Notify tail listeners
    for (const listener of this.tailListeners) {
      listener(alert);
    }

    await Promise.allSettled(promises);
  }

  private async notifyStdout(alert: Alert): Promise<void> {
    const sev = alert.verdict.severity.toUpperCase();
    const cat = alert.verdict.category;
    console.log(
      `\n🚨 [${sev}] ${alert.verdict.summary}\n` +
      `   Session: ${alert.verdict.session_id}\n` +
      `   Category: ${cat}\n` +
      `   File: ${alert.file}\n` +
      `   Indicators: ${alert.verdict.indicators.join(', ')}\n` +
      `   Time: ${alert.timestamp}\n`,
    );
  }

  private async notifyMacOS(alert: Alert): Promise<void> {
    const title = `Prowl [${alert.verdict.severity.toUpperCase()}]`;
    const message = alert.verdict.summary;
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Sosumi"`;

    return new Promise<void>((resolve) => {
      execFile('osascript', ['-e', script], () => resolve());
    });
  }

  private async notifyOpenClaw(_alert: Alert): Promise<void> {
    console.warn('openclaw notification channel is not yet implemented');
  }

  private async notifyWebhook(alert: Alert): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
      });
    } catch (err) {
      console.error(`Webhook delivery failed: ${err}`);
    }
  }
}

export function formatAlertForDisplay(alert: Alert): string {
  const severityColors: Record<Severity, string> = {
    low: '\x1b[33m',
    medium: '\x1b[33m',
    high: '\x1b[31m',
    critical: '\x1b[35m',
  };
  const reset = '\x1b[0m';
  const color = severityColors[alert.verdict.severity];

  return (
    `${color}[${alert.verdict.severity.toUpperCase()}]${reset} ${alert.verdict.summary}\n` +
    `  Session: ${alert.verdict.session_id} | Category: ${alert.verdict.category}\n` +
    `  File: ${alert.file}\n` +
    `  Indicators: ${alert.verdict.indicators.join(', ')}\n` +
    `  Time: ${alert.timestamp}`
  );
}
