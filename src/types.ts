export interface ProwlConfig {
  model: string;
  ollama: { host: string };
  watch: {
    agents: string;
    include_deleted: boolean;
    debounce_ms: number;
  };
  notify: {
    channels: NotifyChannel[];
    min_severity: Severity;
    webhook: { url: string | null };
  };
  scan: {
    batch_lines: number;
    include_logs: boolean;
  };
  s3: {
    enabled: boolean;
    bucket: string | null;
    region: string;
    prefix: string;
    endpoint: string | null;
  };
  state_dir: string;
}

export type NotifyChannel = 'stdout' | 'macos' | 'openclaw' | 'webhook';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface AnalysisVerdict {
  suspicious: boolean;
  severity: Severity;
  summary: string;
  indicators: string[];
  session_id: string;
  category: string;
}

export interface Alert {
  timestamp: string;
  file: string;
  verdict: AnalysisVerdict;
}

export interface SessionEvent {
  type: 'session' | 'model_change' | 'thinking_level_change' | 'custom' | 'message';
  id?: string;
  parentId?: string | null;
  timestamp: string;
  // session fields
  version?: number;
  cwd?: string;
  // model_change fields
  provider?: string;
  modelId?: string;
  // thinking_level_change
  thinkingLevel?: string;
  // custom fields
  customType?: string;
  data?: Record<string, unknown>;
  // message fields
  message?: {
    role: 'user' | 'assistant' | 'toolResult';
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    toolName?: string;
    toolCallId?: string;
    timestamp?: number;
    provider?: string;
    model?: string;
    stopReason?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      };
    };
  };
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  requests: number;
}

export interface UsageRecord {
  [sessionId: string]: UsageStats;
}

export interface UsageEvent {
  timestamp: string;
  sessionId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface FileOffsets {
  [filePath: string]: number;
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  filesWatched?: number;
  alertsToday?: number;
  uptime?: number;
}
