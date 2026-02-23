import { execFile } from 'node:child_process';

export interface ExecutorResult {
  success: boolean;
  stdout: string;
  stderr: string;
  parsed: unknown | null;
  error?: string;
}

export class OpenClawExecutor {
  private timeoutMs: number;
  private localMode: boolean;

  constructor(timeoutS: number = 120, localMode: boolean = true) {
    this.timeoutMs = timeoutS * 1000;
    this.localMode = localMode;
  }

  sendMessage(sessionId: string, agent: string, message: string): Promise<ExecutorResult> {
    const args = [
      'agent',
      '--agent', agent,
      '--session-id', sessionId,
      '--message', message,
      '--json',
    ];

    if (this.localMode) {
      args.push('--local');
    }

    return new Promise<ExecutorResult>((resolve) => {
      execFile('openclaw', args, { timeout: this.timeoutMs }, (error, stdout, stderr) => {
        let parsed: unknown | null = null;
        try {
          if (stdout.trim()) {
            parsed = JSON.parse(stdout.trim());
          }
        } catch {
          // stdout wasn't valid JSON
        }

        if (error) {
          resolve({
            success: false,
            stdout,
            stderr,
            parsed,
            error: error.message,
          });
        } else {
          resolve({
            success: true,
            stdout,
            stderr,
            parsed,
          });
        }
      });
    });
  }
}
