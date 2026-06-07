import type { AgentConfig, OrchestratorSession, PlannedAgent, OrchestratorRun } from "../shared/types.ts";
import { resolveFsPath, runInTmux } from "./utils.ts";

const PLANNER_SYSTEM = `You are Hyperion Z's meta-planner. Given a goal from the user, decompose it into 2-4 focused sub-agent tasks.

Return ONLY valid JSON (no markdown fencing, no prose before/after) in this exact shape:
{
  "reasoning": "one sentence on how you broke this down",
  "pipeline": "sequential",
  "agents": [
    {
      "role": "Short Role Title",
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "task": "Precise instruction for this agent. Include exactly what to produce.",
      "tools": ["fs_read", "fs_write", "fs_list", "tmux_run"],
      "dependsOn": []
    }
  ]
}

Rules:
- pipeline is always "sequential" unless the tasks are truly independent
- dependsOn lists indices of agents this agent needs output from ([] for the first agent)
- tools should only include what the agent genuinely needs
- Each task should be self-contained and produce a clear artifact
- provider must be "anthropic" or "openai" or "mock"
- For code tasks use "fs_read", "fs_write", "fs_list"
- For running tests/builds use "tmux_run"
- IMPORTANT: All file paths must be RELATIVE (e.g. "analysis.md", "tmp/notes.md"). Never use absolute paths like "/tmp/...".
- When an early agent needs to pass data to a later agent, write it to a relative path like "tmp/handoff.md" and reference that path in the later agent's task.
- Do NOT include any text before or after the JSON`;

const TOOL_SYSTEM_SUFFIX = (workDir: string, tmuxSession: string | null, priorContext: string) => `

Working directory: ${workDir}
${tmuxSession ? `tmux session for shell commands: ${tmuxSession}` : "No tmux session available — skip shell tool use."}

You have access to these tools. Use them to complete your task:

fs_read: Read a file. Input: {"path": "relative/path"}
fs_write: Write or create a file. Input: {"path": "relative/path", "content": "..."}
fs_list: List a directory. Input: {"path": "relative/path or ."}
tmux_run: Run a shell command. Input: {"session": "${tmuxSession ?? "none"}", "command": "cmd"}

${priorContext ? `Context from previous agents:\n${priorContext}\n` : ""}

Complete your task fully. Make all necessary file writes. When done, summarize what you produced.`;

export type OrchestratorEvent =
  | { type: "plan"; plan: { reasoning: string; agents: PlannedAgent[] } }
  | { type: "agent_start"; runId: string; role: string; index: number; total: number }
  | { type: "agent_delta"; runId: string; delta: string }
  | { type: "agent_done"; runId: string; output: string; filesWritten: string[] }
  | { type: "agent_error"; runId: string; error: string }
  | { type: "tool_call"; runId: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; runId: string; tool: string; result: string }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string }
  | { type: "paused"; runId: string }
  | { type: "resumed"; runId: string };

type PauseControl = {
  isPaused: boolean;
  resolve: (() => void) | null;
  modifiedTask: string | null;
};

// Per-orchestrator-session pause controls
const pauseControls = new Map<string, PauseControl>();

export function pauseOrchestratorRun(sessionId: string, runId: string): boolean {
  const ctrl = pauseControls.get(`${sessionId}:${runId}`);
  if (!ctrl) return false;
  ctrl.isPaused = true;
  return true;
}

export function resumeOrchestratorRun(
  sessionId: string,
  runId: string,
  modifiedTask?: string
): boolean {
  const ctrl = pauseControls.get(`${sessionId}:${runId}`);
  if (!ctrl) return false;
  ctrl.modifiedTask = modifiedTask ?? null;
  ctrl.isPaused = false;
  ctrl.resolve?.();
  ctrl.resolve = null;
  return true;
}

export async function* orchestrate(
  session: OrchestratorSession,
  workDir: string,
  tmuxSession: string | null,
  anthropicKey: string,
  openaiKey: string,
  signal: AbortSignal
): AsyncGenerator<OrchestratorEvent> {
  // Step 1: Plan
  let plan: { reasoning: string; pipeline: string; agents: PlannedAgent[] };
  try {
    plan = await generatePlan(session.goal, anthropicKey, openaiKey, signal);
  } catch (e) {
    yield { type: "error", message: `Planning failed: ${e instanceof Error ? e.message : String(e)}` };
    return;
  }

  yield { type: "plan", plan };
  session.plan = plan;
  session.planStatus = "running";

  // Step 2: Execute agents
  const runs = plan.agents.map((a, i): OrchestratorRun => ({
    id: crypto.randomUUID(),
    index: i,
    role: a.role,
    task: a.task,
    provider: a.provider,
    model: a.model,
    tools: a.tools,
    status: "queued",
    output: "",
  }));
  session.runs = runs;

  const outputs: string[] = new Array(runs.length).fill("");

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const planned = plan.agents[i];

    if (signal.aborted) break;

    // Wait if paused
    const pauseKey = `${session.id}:${run.id}`;
    const ctrl: PauseControl = { isPaused: false, resolve: null, modifiedTask: null };
    pauseControls.set(pauseKey, ctrl);

    if (ctrl.isPaused) {
      yield { type: "paused", runId: run.id };
      await new Promise<void>((resolve) => { ctrl.resolve = resolve; });
      yield { type: "resumed", runId: run.id };
      if (ctrl.modifiedTask) run.task = ctrl.modifiedTask;
    }

    run.status = "running";
    run.startedAt = new Date().toISOString();
    yield { type: "agent_start", runId: run.id, role: run.role, index: i, total: runs.length };

    // Build prior context from dependent runs
    const priorContext = (planned.dependsOn ?? [])
      .map((idx) => `[${runs[idx].role}]:\n${outputs[idx]}`)
      .join("\n\n---\n\n");

    const systemSuffix = TOOL_SYSTEM_SUFFIX(workDir, tmuxSession, priorContext);

    try {
      let fullOutput = "";
      const filesWritten: string[] = [];
      for await (const event of runAgentWithTools(
        run,
        systemSuffix,
        workDir,
        tmuxSession,
        anthropicKey,
        openaiKey,
        signal
      )) {
        if (event.type === "delta") {
          run.output += event.data;
          fullOutput += event.data;
          yield { type: "agent_delta", runId: run.id, delta: event.data };
        } else if (event.type === "tool_call") {
          yield { type: "tool_call", runId: run.id, tool: event.tool, args: event.args };
          if (event.tool === "fs_write" && typeof event.args.path === "string") {
            const p = event.args.path as string;
            if (!filesWritten.includes(p)) filesWritten.push(p);
          }
        } else if (event.type === "tool_result") {
          yield { type: "tool_result", runId: run.id, tool: event.tool, result: event.result };
        }
      }
      outputs[i] = fullOutput;
      run.status = "completed";
      run.filesWritten = filesWritten;
      run.completedAt = new Date().toISOString();
      yield { type: "agent_done", runId: run.id, output: fullOutput, filesWritten };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      run.status = "failed";
      run.error = msg;
      run.completedAt = new Date().toISOString();
      yield { type: "agent_error", runId: run.id, error: msg };
      if (signal.aborted) break;
    } finally {
      pauseControls.delete(pauseKey);
    }
  }

  session.status = signal.aborted ? "cancelled" : "completed";
  session.completedAt = new Date().toISOString();
  session.planStatus = "done";
  yield { type: "done", sessionId: session.id };
}

async function generatePlan(
  goal: string,
  anthropicKey: string,
  openaiKey: string,
  signal: AbortSignal
): Promise<{ reasoning: string; pipeline: string; agents: PlannedAgent[] }> {
  if (anthropicKey) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: PLANNER_SYSTEM,
        messages: [{ role: "user", content: goal }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Anthropic planning failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const text = data.content?.[0]?.text ?? "";
    return JSON.parse(text);
  }

  if (openaiKey) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openaiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: PLANNER_SYSTEM },
          { role: "user", content: goal },
        ],
        response_format: { type: "json_object" },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`OpenAI planning failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  }

  // Mock plan
  return {
    reasoning: "Mock plan — no API keys configured",
    pipeline: "sequential",
    agents: [
      {
        role: "Analyst",
        provider: "mock",
        model: "local-sim",
        task: `Analyse the goal: "${goal}"`,
        tools: [],
        dependsOn: [],
      },
      {
        role: "Implementer",
        provider: "mock",
        model: "local-sim",
        task: "Implement the plan from the analyst's output.",
        tools: ["fs_read", "fs_write"],
        dependsOn: [0],
      },
    ],
  };
}

type ToolEvent =
  | { type: "delta"; data: string }
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: string };

async function* runAgentWithTools(
  run: OrchestratorRun,
  systemSuffix: string,
  workDir: string,
  tmuxSession: string | null,
  anthropicKey: string,
  openaiKey: string,
  signal: AbortSignal
): AsyncGenerator<ToolEvent> {
  if (run.provider === "anthropic" && anthropicKey) {
    yield* anthropicToolLoop(run, systemSuffix, workDir, tmuxSession, anthropicKey, signal);
    return;
  }
  if (run.provider === "openai" && openaiKey) {
    yield* openaiToolLoop(run, systemSuffix, workDir, tmuxSession, openaiKey, signal);
    return;
  }
  yield* mockAgentWithTools(run, systemSuffix);
}

const TOOLS_SCHEMA_ANTHROPIC = [
  {
    name: "fs_read",
    description: "Read the content of a file in the working directory",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path relative to working dir" } },
      required: ["path"],
    },
  },
  {
    name: "fs_write",
    description: "Write content to a file (creates directories as needed)",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to working dir" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "fs_list",
    description: "List files and directories at a path",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path (. for working dir root)" } },
      required: ["path"],
    },
  },
  {
    name: "tmux_run",
    description: "Run a shell command in the tmux session and capture output",
    input_schema: {
      type: "object",
      properties: {
        session: { type: "string" },
        command: { type: "string", description: "Shell command to execute" },
        wait_ms: { type: "number", description: "Ms to wait before reading output (default 3000)" },
      },
      required: ["session", "command"],
    },
  },
];

async function* anthropicToolLoop(
  run: OrchestratorRun,
  systemSuffix: string,
  workDir: string,
  tmuxSession: string | null,
  anthropicKey: string,
  signal: AbortSignal
): AsyncGenerator<ToolEvent> {
  const systemPrompt = buildSystemPrompt(run) + systemSuffix;
  const messages: Record<string, unknown>[] = [
    { role: "user", content: run.task },
  ];
  const tools = run.tools.length > 0
    ? TOOLS_SCHEMA_ANTHROPIC.filter((t) => run.tools.includes(t.name))
    : [];

  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    if (signal.aborted) break;

    const body: Record<string, unknown> = {
      model: run.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
    };
    if (tools.length > 0) body.tools = tools;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();

    if (data.stop_reason === "max_tokens") {
      yield { type: "delta", data: "\n\n[Warning: response hit token limit — some content may be truncated]\n" };
    }

    const textBlocks: string[] = [];
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of data.content ?? []) {
      if (block.type === "text") {
        textBlocks.push(block.text);
        yield { type: "delta", data: block.text };
      } else if (block.type === "tool_use") {
        toolUseBlocks.push({ id: block.id, name: block.name, input: block.input ?? {} });
      }
    }

    if (toolUseBlocks.length === 0 || data.stop_reason === "end_turn") {
      break;
    }

    // Add assistant message
    messages.push({ role: "assistant", content: data.content });

    // Execute tool calls
    const toolResults: Record<string, unknown>[] = [];
    for (const toolCall of toolUseBlocks) {
      yield { type: "tool_call", tool: toolCall.name, args: toolCall.input };
      const result = await executeTool(toolCall.name, toolCall.input, workDir, tmuxSession);
      yield { type: "tool_result", tool: toolCall.name, result };
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

const TOOLS_SCHEMA_OPENAI = [
  {
    type: "function",
    function: {
      name: "fs_read",
      description: "Read the content of a file in the working directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_write",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_list",
      description: "List directory contents",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tmux_run",
      description: "Run a shell command in tmux",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string" },
          command: { type: "string" },
          wait_ms: { type: "number" },
        },
        required: ["session", "command"],
      },
    },
  },
];

async function* openaiToolLoop(
  run: OrchestratorRun,
  systemSuffix: string,
  workDir: string,
  tmuxSession: string | null,
  openaiKey: string,
  signal: AbortSignal
): AsyncGenerator<ToolEvent> {
  const systemPrompt = buildSystemPrompt(run) + systemSuffix;
  const messages: Record<string, unknown>[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: run.task },
  ];
  const tools = run.tools.length > 0
    ? TOOLS_SCHEMA_OPENAI.filter((t) => run.tools.includes((t.function as { name: string }).name))
    : [];

  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    if (signal.aborted) break;

    const body: Record<string, unknown> = {
      model: run.model,
      messages,
    };
    if (tools.length > 0) body.tools = tools;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openaiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;

    if (msg?.content) {
      yield { type: "delta", data: msg.content };
    }

    if (!msg?.tool_calls || msg.tool_calls.length === 0) break;

    messages.push(msg);

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments ?? "{}");
      yield { type: "tool_call", tool: name, args };
      const result = await executeTool(name, args, workDir, tmuxSession);
      yield { type: "tool_result", tool: name, result };
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
}

async function* mockAgentWithTools(
  run: OrchestratorRun,
  _systemSuffix: string
): AsyncGenerator<ToolEvent> {
  const chunks = [
    `[Mock] ${run.role} starting task: ${run.task.slice(0, 80)}\n\n`,
    "Analysing the goal...\n",
    "Based on my analysis, here is my output:\n",
    "1. Reviewed the codebase structure\n",
    "2. Identified key areas for improvement\n",
    "3. Prepared implementation plan\n",
    "\nTask complete.\n",
  ];
  for (const chunk of chunks) {
    await new Promise((r) => setTimeout(r, 120));
    yield { type: "delta", data: chunk };
  }
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workDir: string,
  tmuxSession: string | null
): Promise<string> {
  try {
    if (name === "fs_read") {
      const path = String(args.path ?? "");
      const safe = resolveFsPath(path, workDir);
      if (!safe) return "[Error: path outside working directory]";
      const content = await Deno.readTextFile(safe);
      return content.length > 20_000
        ? content.slice(0, 20_000) + "\n[truncated — file exceeds 20 KB preview]"
        : content;
    }

    if (name === "fs_write") {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!path) return "[Error: fs_write requires a 'path' argument]";
      if (content.length === 0) return "[Error: fs_write received empty content — make sure you pass the full file text in the 'content' argument]";
      const safe = resolveFsPath(path, workDir);
      if (!safe) return "[Error: path outside working directory]";
      const dir = safe.split("/").slice(0, -1).join("/");
      if (dir) await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(safe, content);
      return `Written ${content.length} bytes to ${path}`;
    }

    if (name === "fs_list") {
      const path = String(args.path ?? ".");
      const safe = resolveFsPath(path, workDir);
      if (!safe) return "[Error: path outside working directory]";
      const skip = new Set(["node_modules", ".git", "__pycache__", ".venv", "dist", "deno.lock"]);
      const entries: string[] = [];
      for await (const e of Deno.readDir(safe)) {
        if (skip.has(e.name)) continue;
        entries.push(`${e.isDirectory ? "d" : "f"} ${e.name}`);
      }
      return entries.sort().join("\n") || "(empty directory)";
    }

    if (name === "tmux_run") {
      const session = String(args.session ?? tmuxSession ?? "");
      const command = String(args.command ?? "");
      const waitMs = Number(args.wait_ms ?? 3000);
      if (!session) return "[Error: no tmux session specified]";
      if (!command) return "[Error: no command specified]";
      const result = await runInTmux(session, command, waitMs);
      return result.ok
        ? (result.output || "(no output)")
        : `[Exit error: ${result.err}]`;
    }

    return `[Unknown tool: ${name}]`;
  } catch (e) {
    return `[Tool error: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

function buildSystemPrompt(run: OrchestratorRun): string {
  const rolePrompts: Record<string, string> = {
    "Analyst": "You are a precise code analyst. Read relevant files, understand the structure, and produce a clear analysis.",
    "Developer": "You are a focused software developer. Write clean, working code. Use fs_write to create or modify files.",
    "Test Engineer": "You are a thorough test engineer. Write comprehensive unit and acceptance tests.",
    "Reviewer": "You are a careful code reviewer. Read the files, identify issues, and provide specific actionable feedback.",
  };
  return rolePrompts[run.role] ?? `You are ${run.role}. Complete the assigned task thoroughly and precisely.`;
}
