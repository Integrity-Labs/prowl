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
    logs: {
      enabled: boolean;
      bucket: string | null;
      region: string;
      prefix: string;
      endpoint: string | null;
      flush_interval_s: number;
      flush_max_bytes: number;
    };
    redteam: {
      enabled: boolean;
      bucket: string | null;
      region: string;
      prefix: string;
      endpoint: string | null;
    };
  };
  redteam: RedTeamConfig;
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

// --- Red-Team types ---

export type AttackCategoryId =
  | 'prompt_injection'
  | 'information_extraction'
  | 'social_engineering'
  | 'jailbreaking'
  | 'data_exfiltration';

export interface AttackCategory {
  id: AttackCategoryId;
  name: string;
  description: string;
  goal: string;
  examples: string[];
}

export interface RedTeamConfig {
  categories: AttackCategoryId[];
  attacks_per_category: number;
  target_agent: string;
  openclaw_timeout_s: number;
  delay_between_attacks_s: number;
  report_path: string;
  daemon_interval_m: number;
  local_mode: boolean;
}

export interface GeneratedAttack {
  attack_prompt: string;
  technique: string;
  expected_behavior: string;
}

export interface JudgeVerdict {
  success: boolean;
  confidence: number;
  reasoning: string;
  severity: Severity;
  indicators: string[];
}

export interface AttackResult {
  id: string;
  timestamp: string;
  category: AttackCategoryId;
  technique: string;
  attack_prompt: string;
  agent_response: string;
  session_id: string;
  target_agent: string;
  verdict: JudgeVerdict;
  duration_ms: number;
  error?: string;
}

export interface RedTeamReport {
  run_id: string;
  timestamp: string;
  target_agent: string;
  model: string;
  total_attacks: number;
  successful_attacks: number;
  failed_attacks: number;
  errors: number;
  defense_score: number;
  results: AttackResult[];
  duration_ms: number;
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  filesWatched?: number;
  alertsToday?: number;
  uptime?: number;
}
