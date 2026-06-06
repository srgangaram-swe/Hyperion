export type ProviderId = "openai" | "anthropic" | "mock";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type SessionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type EventLevel = "info" | "success" | "warning" | "error";

export type ToolId = "chat" | "tmux" | "email" | "files";

export interface AgentConfig {
  id: string;
  name: string;
  provider: ProviderId;
  model: string;
  systemPrompt: string;
  description: string;
  accent: string;
  tools: string[];
}

export interface ProviderHealth {
  provider: ProviderId;
  label: string;
  configured: boolean;
  detail: string;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  provider: ProviderId;
  model: string;
  prompt: string;
  status: RunStatus;
  output: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AgentSession {
  id: string;
  title: string;
  prompt: string;
  status: SessionStatus;
  createdAt: string;
  completedAt?: string;
  runs: AgentRun[];
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  runId?: string;
  agentId?: string;
  level: EventLevel;
  type: "session" | "run" | "delta" | "connector" | "tmux" | "email";
  message: string;
  delta?: string;
  createdAt: string;
}

export interface ConnectorStatus {
  id: string;
  name: string;
  kind: "email" | "calendar" | "chat" | "tasks" | "shell";
  status: "ready" | "needs_env" | "mock";
  detail: string;
  envVars: string[];
}

export interface CreateSessionRequest {
  title?: string;
  prompt: string;
  agentIds: string[];
}

export interface RunDeltaPayload {
  sessionId: string;
  runId: string;
  delta: string;
}

// ── tmux ────────────────────────────────────────────────────────────────────

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
}

export interface TmuxOutput {
  session: string;
  output: string;
  capturedAt: string;
}

// ── File context ─────────────────────────────────────────────────────────────

export interface FileContext {
  id: string;
  name: string;
  content: string;
  size: number;
}

// ── Email ────────────────────────────────────────────────────────────────────

export interface EmailDraftRequest {
  context: string;
  to?: string;
  subject?: string;
  tone?: "professional" | "casual" | "concise";
}
