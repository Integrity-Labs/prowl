import crypto from 'node:crypto';
import type { ProwlConfig, AttackResult, RedTeamReport, AttackCategoryId } from '../types.js';
import { RedTeamGenerator } from './generator.js';
import { OpenClawExecutor } from './executor.js';
import { RedTeamJudge } from './judge.js';
import { RedTeamReporter } from './reporter.js';
import { ATTACK_CATEGORIES, getCategoryById } from './vectors.js';

export interface RunnerOptions {
  verbose?: boolean;
  json?: boolean;
  categories?: AttackCategoryId[];
  attacksPerCategory?: number;
  targetAgent?: string;
  delayBetweenAttacks?: number;
  openclawTimeout?: number;
  localMode?: boolean;
}

export class RedTeamRunner {
  private config: ProwlConfig;
  private generator: RedTeamGenerator;
  private executor: OpenClawExecutor;
  private judge: RedTeamJudge;
  private reporter: RedTeamReporter;
  private verbose: boolean;
  private json: boolean;
  private categories: AttackCategoryId[];
  private attacksPerCategory: number;
  private targetAgent: string;
  private delayMs: number;
  private stopped = false;

  constructor(config: ProwlConfig, opts: RunnerOptions = {}) {
    this.config = config;
    this.verbose = opts.verbose ?? false;
    this.json = opts.json ?? false;
    this.categories = opts.categories ?? config.redteam.categories;
    this.attacksPerCategory = opts.attacksPerCategory ?? config.redteam.attacks_per_category;
    this.targetAgent = opts.targetAgent ?? config.redteam.target_agent;
    this.delayMs = (opts.delayBetweenAttacks ?? config.redteam.delay_between_attacks_s) * 1000;

    const localMode = opts.localMode ?? config.redteam.local_mode;
    const timeoutS = opts.openclawTimeout ?? config.redteam.openclaw_timeout_s;

    this.generator = new RedTeamGenerator(config.ollama.host, config.model);
    this.executor = new OpenClawExecutor(timeoutS, localMode);
    this.judge = new RedTeamJudge(config.ollama.host, config.model);
    this.reporter = new RedTeamReporter(config);
  }

  async runOnce(): Promise<RedTeamReport> {
    const runId = `rt-${crypto.randomUUID()}`;
    const runStart = Date.now();
    const results: AttackResult[] = [];
    let errors = 0;

    this.log(`\nRed-team run ${runId}`);
    this.log(`Target agent: ${this.targetAgent}`);
    this.log(`Categories: ${this.categories.join(', ')}`);
    this.log(`Attacks per category: ${this.attacksPerCategory}\n`);

    for (const categoryId of this.categories) {
      if (this.stopped) break;

      const category = getCategoryById(categoryId);
      if (!category) {
        this.log(`Skipping unknown category: ${categoryId}`);
        continue;
      }

      this.log(`--- ${category.name} ---`);

      for (let i = 0; i < this.attacksPerCategory; i++) {
        if (this.stopped) break;

        const attackId = `${runId}-${categoryId}-${i}`;
        const sessionId = `rt-${crypto.randomUUID()}`;
        const attackStart = Date.now();

        try {
          // Generate attack
          this.log(`  [${i + 1}/${this.attacksPerCategory}] Generating attack...`);
          const generated = await this.generator.generateAttack(category);
          this.log(`  Technique: ${generated.technique}`);
          if (this.verbose) {
            this.log(`  Prompt: ${generated.attack_prompt.slice(0, 100)}...`);
          }

          // Execute via openclaw CLI
          this.log(`  Sending to agent "${this.targetAgent}" (session ${sessionId.slice(0, 12)}...)...`);
          const execResult = await this.executor.sendMessage(sessionId, this.targetAgent, generated.attack_prompt);

          let agentResponse = '';
          if (execResult.parsed && typeof execResult.parsed === 'object') {
            const p = execResult.parsed as Record<string, unknown>;
            agentResponse = typeof p.response === 'string' ? p.response
              : typeof p.output === 'string' ? p.output
              : execResult.stdout;
          } else {
            agentResponse = execResult.stdout;
          }

          if (!execResult.success) {
            this.log(`  Execution error: ${execResult.error}`);
          }

          // Judge the response
          this.log(`  Judging response...`);
          const verdict = await this.judge.evaluate(
            generated.attack_prompt,
            agentResponse || '(no response)',
            category,
          );

          const result: AttackResult = {
            id: attackId,
            timestamp: new Date().toISOString(),
            category: categoryId,
            technique: generated.technique,
            attack_prompt: generated.attack_prompt,
            agent_response: agentResponse || '(no response)',
            session_id: sessionId,
            target_agent: this.targetAgent,
            verdict,
            duration_ms: Date.now() - attackStart,
            error: execResult.success ? undefined : execResult.error,
          };

          results.push(result);
          this.reporter.recordResult(result);

          const status = verdict.success ? '\x1b[31mBREACH\x1b[0m' : '\x1b[32mDEFENDED\x1b[0m';
          this.log(`  Result: ${status} (confidence: ${(verdict.confidence * 100).toFixed(0)}%)`);
          if (this.verbose && verdict.reasoning) {
            this.log(`  Reasoning: ${verdict.reasoning.slice(0, 150)}`);
          }
        } catch (err) {
          errors++;
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`  Error: ${errMsg}`);

          results.push({
            id: attackId,
            timestamp: new Date().toISOString(),
            category: categoryId,
            technique: 'error',
            attack_prompt: '',
            agent_response: '',
            session_id: sessionId,
            target_agent: this.targetAgent,
            verdict: {
              success: false,
              confidence: 0,
              reasoning: `Error during attack: ${errMsg}`,
              severity: 'low',
              indicators: [],
            },
            duration_ms: Date.now() - attackStart,
            error: errMsg,
          });
        }

        // Delay between attacks
        if (this.delayMs > 0 && !this.stopped) {
          await this.sleep(this.delayMs);
        }
      }
    }

    const successfulAttacks = results.filter((r) => r.verdict.success).length;
    const failedDefenses = results.filter((r) => r.error).length;
    const totalAttacks = results.length;
    const defenseScore = totalAttacks > 0
      ? Math.round(((totalAttacks - successfulAttacks) / totalAttacks) * 100)
      : 100;

    const report: RedTeamReport = {
      run_id: runId,
      timestamp: new Date().toISOString(),
      target_agent: this.targetAgent,
      model: this.config.model,
      total_attacks: totalAttacks,
      successful_attacks: successfulAttacks,
      failed_attacks: totalAttacks - successfulAttacks - failedDefenses,
      errors,
      defense_score: defenseScore,
      results,
      duration_ms: Date.now() - runStart,
    };

    this.reporter.recordSummary(report);
    return report;
  }

  async runDaemon(intervalMinutes: number): Promise<void> {
    this.log(`Starting red-team daemon (interval: ${intervalMinutes}m)`);
    this.log(`Press Ctrl+C to stop.\n`);

    const onSignal = () => {
      this.log('\nShutting down red-team daemon...');
      this.stopped = true;
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    while (!this.stopped) {
      const report = await this.runOnce();
      this.printSummary(report);

      if (this.stopped) break;

      this.log(`\nNext run in ${intervalMinutes} minutes...\n`);
      await this.sleep(intervalMinutes * 60 * 1000);
    }

    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  printSummary(report: RedTeamReport): void {
    if (this.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const scoreColor = report.defense_score >= 80
      ? '\x1b[32m' // green
      : report.defense_score >= 50
        ? '\x1b[33m' // yellow
        : '\x1b[31m'; // red
    const reset = '\x1b[0m';

    console.log('\n' + '='.repeat(60));
    console.log('  RED-TEAM REPORT');
    console.log('='.repeat(60));
    console.log(`  Run ID:       ${report.run_id}`);
    console.log(`  Target:       ${report.target_agent}`);
    console.log(`  Model:        ${report.model}`);
    console.log(`  Duration:     ${(report.duration_ms / 1000).toFixed(1)}s`);
    console.log('');
    console.log(`  Total attacks:      ${report.total_attacks}`);
    console.log(`  Breaches:           ${report.successful_attacks > 0 ? '\x1b[31m' : '\x1b[32m'}${report.successful_attacks}${reset}`);
    console.log(`  Defended:           ${report.failed_attacks}`);
    console.log(`  Errors:             ${report.errors}`);
    console.log(`  Defense score:      ${scoreColor}${report.defense_score}%${reset}`);
    console.log('='.repeat(60));

    if (report.successful_attacks > 0) {
      console.log('\n  Successful breaches:');
      for (const r of report.results.filter((r) => r.verdict.success)) {
        console.log(`\n  \x1b[31m[BREACH]\x1b[0m ${r.category} — ${r.technique}`);
        console.log(`    Confidence: ${(r.verdict.confidence * 100).toFixed(0)}%`);
        console.log(`    Severity: ${r.verdict.severity}`);
        console.log(`    Reasoning: ${r.verdict.reasoning.slice(0, 200)}`);
      }
    }

    console.log('');
  }

  private log(msg: string): void {
    if (!this.json) {
      console.log(msg);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Allow the sleep to be interrupted by stop
      const check = setInterval(() => {
        if (this.stopped) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }
}
