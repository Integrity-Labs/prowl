import fs from 'node:fs';
import path from 'node:path';
import type { SessionEvent, UsageStats } from './types.js';

export function readNewLines(filePath: string, offset: number): { lines: string[]; newOffset: number } {
  const stat = fs.statSync(filePath);
  if (stat.size <= offset) {
    return { lines: [], newOffset: offset };
  }

  const fd = fs.openSync(filePath, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.toString('utf-8');
  const rawLines = text.split('\n').filter((l) => l.trim().length > 0);

  return { lines: rawLines, newOffset: stat.size };
}

export function parseEvents(lines: string[]): SessionEvent[] {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as SessionEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is SessionEvent => e !== null);
}

export function extractRelevantContent(events: SessionEvent[]): string {
  const parts: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'session':
        parts.push(`[SESSION START] id=${event.id} cwd=${event.cwd}`);
        break;

      case 'model_change':
        parts.push(`[MODEL CHANGE] provider=${event.provider} model=${event.modelId}`);
        break;

      case 'message': {
        const msg = event.message;
        if (!msg) break;
        const role = msg.role.toUpperCase();
        const textParts = msg.content
          ?.filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');

        const toolParts = msg.content
          ?.filter((c) => c.type === 'tool_use' || c.type === 'tool_result' || c.type === 'toolCall' || c.type === 'toolResult')
          .map((c) => {
            if (c.type === 'tool_use' || c.type === 'toolCall') return `[TOOL CALL] ${c.name}(${JSON.stringify(c.input ?? c.arguments ?? '').slice(0, 500)})`;
            if (c.type === 'tool_result' || c.type === 'toolResult') return `[TOOL RESULT] ${String(c.content ?? c.text ?? '').slice(0, 500)}`;
            return '';
          })
          .join('\n');

        if (msg.role === 'toolResult') {
          const resultText = msg.content
            ?.map((c) => c.text ?? '')
            .filter(Boolean)
            .join('\n')
            .slice(0, 1000);
          if (resultText) parts.push(`[TOOL RESULT: ${msg.toolName ?? 'unknown'}] ${resultText}`);
          break;
        }

        if (textParts) parts.push(`[${role}] ${textParts}`);
        if (toolParts) parts.push(toolParts);
        break;
      }

      case 'custom':
        if (event.customType && event.customType !== 'model-snapshot' && event.customType !== 'cache-ttl') {
          parts.push(`[CUSTOM:${event.customType}] ${JSON.stringify(event.data).slice(0, 300)}`);
        }
        break;
    }
  }

  return parts.join('\n');
}

export function extractUsage(events: SessionEvent[]): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; requests: number } {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, requests: 0 };
  for (const event of events) {
    if (event.type !== 'message') continue;
    const usage = event.message?.usage;
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.totalTokens += usage.totalTokens ?? 0;
    totals.cost += usage.cost?.total ?? 0;
    totals.requests++;
  }
  return totals;
}

export function extractSessionId(filePath: string, lines: string[]): string {
  // Try to get from first session event
  for (const line of lines.slice(0, 5)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'session' && event.id) return event.id;
    } catch { /* skip */ }
  }

  // Fall back to filename
  return path.basename(filePath, '.jsonl');
}

export function batchLines(lines: string[], batchSize: number): string[][] {
  if (batchSize < 1) batchSize = 20;
  const batches: string[][] = [];
  for (let i = 0; i < lines.length; i += batchSize) {
    batches.push(lines.slice(i, i + batchSize));
  }
  return batches;
}
