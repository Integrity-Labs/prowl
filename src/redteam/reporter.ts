import fs from 'node:fs';
import path from 'node:path';
import { AlertDispatcher } from '../alerter.js';
import { S3Shipper } from '../shipper.js';
import type { ProwlConfig, AttackResult, RedTeamReport, Alert } from '../types.js';

export class RedTeamReporter {
  private reportPath: string;
  private dispatcher: AlertDispatcher;
  private shipper: S3Shipper | null;
  private s3Prefix: string;

  constructor(config: ProwlConfig) {
    this.reportPath = config.redteam.report_path;
    this.dispatcher = new AlertDispatcher(config);
    this.s3Prefix = config.s3.redteam.prefix;

    this.shipper = config.s3.redteam.enabled && config.s3.redteam.bucket
      ? new S3Shipper({
          bucket: config.s3.redteam.bucket,
          region: config.s3.redteam.region,
          prefix: config.s3.redteam.prefix,
          endpoint: config.s3.redteam.endpoint,
          publicKeyPath: config.s3.redteam.public_key,
        })
      : null;
  }

  recordResult(result: AttackResult): void {
    this.ensureReportDir();
    const line = JSON.stringify({ type: 'attack_result', ...result }) + '\n';
    fs.appendFileSync(this.reportPath, line);

    if (result.verdict.success) {
      const alert: Alert = {
        timestamp: result.timestamp,
        file: `redteam:${result.session_id}`,
        verdict: {
          suspicious: true,
          severity: result.verdict.severity,
          summary: `Red-team breach: ${result.technique} (${result.category})`,
          indicators: result.verdict.indicators,
          session_id: result.session_id,
          category: result.category,
        },
      };
      this.dispatcher.dispatch(alert).catch(() => {});
    }
  }

  recordSummary(report: RedTeamReport): void {
    this.ensureReportDir();
    const line = JSON.stringify({ type: 'run_summary', ...report }) + '\n';
    fs.appendFileSync(this.reportPath, line);

    if (this.shipper) {
      const key = `${this.s3Prefix}redteam/${report.run_id}.jsonl`;
      this.shipper.shipAs(this.reportPath, key).catch(() => {});
    }
  }

  getResults(since?: Date): AttackResult[] {
    if (!fs.existsSync(this.reportPath)) return [];

    const lines = fs.readFileSync(this.reportPath, 'utf-8').trim().split('\n').filter(Boolean);
    const results: AttackResult[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'attack_result') continue;
        if (since && new Date(entry.timestamp) < since) continue;
        results.push(entry as AttackResult);
      } catch {
        // skip malformed lines
      }
    }

    return results;
  }

  private ensureReportDir(): void {
    const dir = path.dirname(this.reportPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
