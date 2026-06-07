import { getBuiltinAgents } from "./agents.ts";
import { listCustomAgents, addCustomAgent, editCustomAgent, deleteCustomAgent } from "./agentStore.ts";
import { getConnectors } from "./connectors.ts";
import { providerConfigured, streamAgentResponse } from "./providers.ts";
import {
  listSessions as tmuxList,
  capturePane,
  sendKeys,
  newSession as tmuxNew,
  killSession
} from "./tmux.ts";
import {
  listMemories,
  addMemory,
  editMemory,
  deleteMemory,
  searchMemory
} from "./memory.ts";
import {
  listSshConnections,
  getSshConnection,
  addSshConnection,
  editSshConnection,
  deleteSshConnection,
  runSshCommand,
  testSshConnection,
  openSshInTmux,
} from "./ssh.ts";
import { orchestrate, pauseOrchestratorRun, resumeOrchestratorRun } from "./orchestrator.ts";
import { resolveFsPath } from "./utils.ts";
import type {
  AgentRun,
  AgentSession,
  AgentConfig,
  CreateSessionRequest,
  EmailDraftRequest,
  ProviderHealth,
  RunDeltaPayload,
  SessionEvent,
  SessionStatus,
  OrchestratorSession,
  WorkspaceConfig,
} from "../shared/types.ts";

await loadEnvFile();

const port = Number(Deno.env.get("PORT") || 8787);
const vectorUrl = Deno.env.get("VECTOR_MEMORY_URL")?.replace(/\/$/, "") || "";

let agents: AgentConfig[] = [];

async function refreshAgents() {
  const custom = await listCustomAgents();
  agents = [...getBuiltinAgents(), ...custom];
}

await refreshAgents();

function findAgent(id: string): AgentConfig | undefined {
  return agents.find((a) => a.id === id);
}
const clients = new Set<WebSocket>();
const sessions = new Map<string, AgentSession>();
const orchestratorSessions = new Map<string, OrchestratorSession>();
const events: SessionEvent[] = [];
const runControllers = new Map<string, AbortController>();

// Workspace config (in-memory, persisted separately)
let workspace: WorkspaceConfig = {
  rootDir: Deno.env.get("FS_ROOT") || Deno.cwd(),
  tmuxSession: null,
};

// tmux WebSocket clients: sessionName → Set of open sockets
const tmuxClients = new Map<string, Set<WebSocket>>();

Deno.serve({ hostname: "127.0.0.1", port }, handleRequest);
console.log(`\x1b[31m[HYPERION]\x1b[0m Server running at http://127.0.0.1:${port}`);
if (vectorUrl) console.log(`\x1b[31m[HYPERION]\x1b[0m Vector memory → ${vectorUrl}`);

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // CORS pre-flight (for local dev)
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (url.pathname === "/ws") {
    const { socket, response } = Deno.upgradeWebSocket(request);

    socket.addEventListener("open", () => {
      clients.add(socket);
      send(socket, "sessions:snapshot", listSessionsSorted());
      send(socket, "events:snapshot", events.slice(-250));
    });

    socket.addEventListener("close", () => {
      clients.delete(socket);
    });

    return response;
  }

  // tmux live-stream WebSocket (/api/tmux/ws/:sessionName)
  const tmuxWsMatch = url.pathname.match(/^\/api\/tmux\/ws\/([^/]+)$/);
  if (tmuxWsMatch) {
    const sessionName = decodeURIComponent(tmuxWsMatch[1]);
    const { socket, response } = Deno.upgradeWebSocket(request);

    socket.addEventListener("open", async () => {
      if (!tmuxClients.has(sessionName)) tmuxClients.set(sessionName, new Set());
      tmuxClients.get(sessionName)!.add(socket);

      // Send full initial snapshot
      const initial = await capturePane(sessionName);
      send(socket, "output", { data: initial.output ?? "", full: true });

      // Poll at 500 ms; push only when output changes
      let lastOutput = initial.output ?? "";
      const timer = setInterval(async () => {
        if (socket.readyState !== WebSocket.OPEN) { clearInterval(timer); return; }
        const result = await capturePane(sessionName);
        const current = result.output ?? "";
        if (current !== lastOutput) {
          lastOutput = current;
          send(socket, "output", { data: current, full: true });
        }
      }, 500);

      socket.addEventListener("close", () => {
        clearInterval(timer);
        tmuxClients.get(sessionName)?.delete(socket);
      });
    });

    return response;
  }

  if (url.pathname.startsWith("/api/")) {
    const apiResponse = await handleApi(request, url);
    const headers = new Headers(apiResponse.headers);
    corsHeaders(headers);
    return new Response(apiResponse.body, { status: apiResponse.status, headers });
  }

  return serveStatic(url);
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  // Health
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, providers: getProviderHealth(), name: "Hyperion Z" });
  }

  // Agents
  if (url.pathname === "/api/agents" && request.method === "GET") {
    return json({ agents, providers: getProviderHealth() });
  }

  if (url.pathname === "/api/agents" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Expected JSON" }, 400);
    const { name, provider, model, systemPrompt, description, accent, tools } = body as Record<string, unknown>;
    if (!name || !provider || !model || !systemPrompt) {
      return json({ error: "name, provider, model, systemPrompt required" }, 400);
    }
    const agent = await addCustomAgent({
      name: String(name), provider: provider as AgentConfig["provider"],
      model: String(model), systemPrompt: String(systemPrompt),
      description: String(description ?? ""), accent: String(accent ?? "#cc1111"),
      tools: Array.isArray(tools) ? tools as string[] : [],
    });
    await refreshAgents();
    addEvent({ sessionId: "system", type: "session", level: "success", message: `Agent created: ${agent.name}` });
    return json({ agent }, 201);
  }

  const agentIdMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);

  if (agentIdMatch && request.method === "PATCH") {
    const updated = await editCustomAgent(agentIdMatch[1], await request.json().catch(() => ({})));
    if (!updated) return json({ error: "Not found or built-in agent" }, 404);
    await refreshAgents();
    return json({ agent: updated });
  }

  if (agentIdMatch && request.method === "DELETE") {
    const ok = await deleteCustomAgent(agentIdMatch[1]);
    if (!ok) return json({ error: "Not found or built-in agent" }, 404);
    await refreshAgents();
    addEvent({ sessionId: "system", type: "session", level: "warning", message: `Agent deleted: ${agentIdMatch[1]}` });
    return json({ ok: true });
  }

  // Git diff
  if (url.pathname === "/api/git/diff" && request.method === "GET") {
    const filePath = url.searchParams.get("path") ?? "";
    try {
      const args = filePath ? ["diff", "HEAD", "--", filePath] : ["diff", "HEAD"];
      const cmd = new Deno.Command("git", { args, stdout: "piped", stderr: "piped" });
      const { stdout } = await cmd.output();
      const diff = new TextDecoder().decode(stdout);
      return json({ diff });
    } catch {
      return json({ diff: "" });
    }
  }

  // Filesystem browser
  if (url.pathname === "/api/fs" && request.method === "GET") {
    const userPath = url.searchParams.get("path") ?? ".";
    const safe = resolveFsPath(userPath, workspace.rootDir);
    if (!safe) return json({ error: "Forbidden" }, 403);
    try {
      const stat = await Deno.stat(safe);
      if (stat.isDirectory) {
        const skip = new Set(["node_modules", ".git", "__pycache__", ".venv", "dist", "dist-server", "deno.lock"]);
        const entries: { name: string; type: string; path: string }[] = [];
        for await (const e of Deno.readDir(safe)) {
          if (e.name.startsWith(".") || skip.has(e.name)) continue;
          entries.push({
            name: e.name,
            type: e.isDirectory ? "dir" : "file",
            path: (userPath === "." || userPath === "/") ? e.name : `${userPath}/${e.name}`,
          });
        }
        entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
        return json({ type: "dir", path: userPath, entries });
      } else {
        const content = await Deno.readTextFile(safe);
        return json({ type: "file", path: userPath, content });
      }
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Read error" }, 500);
    }
  }

  if (url.pathname === "/api/fs" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.path !== "string" || typeof body.content !== "string") {
      return json({ error: "path and content required" }, 400);
    }
    const safe = resolveFsPath(body.path, workspace.rootDir);
    if (!safe) return json({ error: "Forbidden" }, 403);
    try {
      await Deno.writeTextFile(safe, body.content);
      addEvent({ sessionId: "system", type: "session", level: "info", message: `Saved: ${body.path}` });
      return json({ ok: true });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Write error" }, 500);
    }
  }

  // Connectors
  if (url.pathname === "/api/connectors" && request.method === "GET") {
    return json({ connectors: getConnectors() });
  }

  // Events
  if (url.pathname === "/api/events" && request.method === "GET") {
    return json({ events: events.slice(-250) });
  }

  // Sessions
  if (url.pathname === "/api/sessions" && request.method === "GET") {
    return json({ sessions: listSessionsSorted() });
  }

  if (url.pathname === "/api/sessions" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const parsed = parseCreateSession(body);

    if (!parsed.ok) return json({ error: parsed.error }, 400);

    const session = createSession(parsed.value);
    sessions.set(session.id, session);
    addEvent({ sessionId: session.id, type: "session", level: "info", message: `Queued ${session.runs.length} run(s)` });
    emitSessions();
    runSession(session.id);
    return json({ session }, 201);
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "GET") {
    const session = sessions.get(sessionMatch[1]);
    return session ? json({ session }) : json({ error: "Not found" }, 404);
  }

  const abortMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
  if (abortMatch && request.method === "POST") {
    const session = sessions.get(abortMatch[1]);
    if (!session) return json({ error: "Not found" }, 404);

    for (const run of session.runs) {
      if (run.status === "queued" || run.status === "running") {
        runControllers.get(run.id)?.abort();
        run.status = "cancelled";
        run.completedAt = new Date().toISOString();
      }
    }
    session.status = "cancelled";
    session.completedAt = new Date().toISOString();
    addEvent({ sessionId: session.id, type: "session", level: "warning", message: "Session cancelled" });
    emitSession(session);
    emitSessions();
    return json({ session });
  }

  // tmux API

  if (url.pathname === "/api/tmux/sessions" && request.method === "GET") {
    const sessions = await tmuxList();
    return json({ sessions });
  }

  if (url.pathname === "/api/tmux/sessions" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : `hx-${Date.now()}`;
    const result = await tmuxNew(name);
    if (result.ok) {
      addEvent({ sessionId: "system", type: "tmux", level: "success", message: `tmux session created: ${name}` });
    }
    return json(result, result.ok ? 201 : 500);
  }

  const tmuxSessionMatch = url.pathname.match(/^\/api\/tmux\/sessions\/([^/]+)$/);

  if (tmuxSessionMatch && request.method === "DELETE") {
    const sessionName = decodeURIComponent(tmuxSessionMatch[1]);
    const result = await killSession(sessionName);
    if (result.ok) {
      addEvent({ sessionId: "system", type: "tmux", level: "warning", message: `tmux session killed: ${sessionName}` });
    }
    return json(result);
  }

  const tmuxOutputMatch = url.pathname.match(/^\/api\/tmux\/sessions\/([^/]+)\/output$/);

  if (tmuxOutputMatch && request.method === "GET") {
    const sessionName = decodeURIComponent(tmuxOutputMatch[1]);
    const output = await capturePane(sessionName);
    return json(output);
  }

  const tmuxSendMatch = url.pathname.match(/^\/api\/tmux\/sessions\/([^/]+)\/send$/);

  if (tmuxSendMatch && request.method === "POST") {
    const sessionName = decodeURIComponent(tmuxSendMatch[1]);
    const body = await request.json().catch(() => ({}));
    const keys = typeof body?.keys === "string" ? body.keys : "";
    if (!keys) return json({ error: "keys required" }, 400);
    const result = await sendKeys(sessionName, keys);
    if (result.ok) {
      addEvent({
        sessionId: "system", type: "tmux", level: "info",
        message: `→ [${sessionName}] ${keys.slice(0, 60)}${keys.length > 60 ? "…" : ""}`
      });
    }
    return json(result);
  }

  // Email draft (SSE)

  if (url.pathname === "/api/draft-email" && request.method === "POST") {
    const body: EmailDraftRequest = await request.json().catch(() => ({ context: "" }));
    const { context = "", to = "", subject = "", tone = "professional" } = body;

    if (!providerConfigured("anthropic")) {
      return json({ error: "ANTHROPIC_API_KEY not configured" }, 503);
    }

    const toneMap: Record<string, string> = {
      professional: "formal, clear, and professional",
      casual: "warm, friendly, and conversational",
      concise: "concise, bullet-pointed where useful, and direct"
    };

    const prompt = [
      to && `To: ${to}`,
      subject && `Subject: ${subject}`,
      `Tone: ${toneMap[tone] ?? toneMap.professional}`,
      context && `\nEmail thread / context:\n"""\n${context}\n"""`,
      "\nWrite the email reply body only. No subject line, no headers, no sign-off placeholder."
    ]
      .filter(Boolean)
      .join("\n");

    const draftAgent: AgentConfig = {
      id: "email-drafter",
      name: "Email Drafter",
      provider: "anthropic",
      model: Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-4-6",
      systemPrompt:
        "You are an expert email writer. Craft replies that are clear, appropriately toned, and end with a natural call to action or closing. Write only the email body.",
      description: "Agentic email drafting",
      accent: "#cc1111",
      tools: ["email"]
    };

    const controller = new AbortController();

    const stream = new ReadableStream({
      async start(ctrl) {
        const enc = new TextEncoder();
        addEvent({ sessionId: "system", type: "email", level: "info", message: "Email draft started" });
        try {
          for await (const delta of streamAgentResponse(draftAgent, prompt, controller.signal)) {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ delta })}\n\n`));
          }
          ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
          addEvent({ sessionId: "system", type: "email", level: "success", message: "Email draft complete" });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
          addEvent({ sessionId: "system", type: "email", level: "error", message: `Draft failed: ${msg}` });
        }
        ctrl.close();
      },
      cancel() {
        controller.abort();
      }
    });

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }
    });
  }

  // Email webhook (from Python email poller)

  if (url.pathname === "/api/webhooks/email" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Expected JSON" }, 400);

    const { subject = "(no subject)", from = "", date = "", body: emailBody = "", autoTriage = false } = body as Record<string, unknown>;
    const preview = String(emailBody).slice(0, 120).replace(/\s+/g, " ");

    addEvent({
      sessionId: "system",
      type: "email",
      level: "info",
      message: `📬 ${String(from)} — ${String(subject)} ${preview ? `· ${preview}…` : ""}`,
    });

    // Optional: auto-start a triage session with Claude
    if (autoTriage && providerConfigured("anthropic")) {
      const triageAgent = agents.find((a) => a.provider === "anthropic");
      if (triageAgent) {
        const prompt = [
          `New email received:`,
          `From: ${String(from)}`,
          `Subject: ${String(subject)}`,
          `Date: ${String(date)}`,
          `\nBody:\n${String(emailBody).slice(0, 3000)}`,
          `\nTasks:`,
          `1. Classify urgency (high / medium / low) with one sentence reason.`,
          `2. Draft a concise reply (3–5 sentences). Be direct.`,
        ].join("\n");

        const session = createSession({ prompt, agentIds: [triageAgent.id], title: `Triage: ${String(subject).slice(0, 50)}` });
        sessions.set(session.id, session);
        addEvent({ sessionId: session.id, type: "session", level: "info", message: `Auto-triage started for: ${String(subject)}` });
        emitSessions();
        runSession(session.id);
      }
    }

    return json({ ok: true });
  }

  // Memory API

  if (url.pathname === "/api/memory" && request.method === "GET") {
    const category = url.searchParams.get("category") as any ?? undefined;
    const q        = url.searchParams.get("q") ?? "";
    const agentId  = url.searchParams.get("agentId") ?? undefined;
    const limit    = Number(url.searchParams.get("limit") || 50);

    if (q && vectorUrl) {
      // Proxy semantic search to the Python vector memory service
      try {
        const params = new URLSearchParams({ q, limit: String(limit) });
        if (category) params.set("category", category);
        const res = await fetch(`${vectorUrl}/search?${params}`);
        if (res.ok) {
          const data = await res.json();
          // Map vector results back to MemoryEntry shape (score added as extra field)
          return json({ entries: data.results, source: "vector" });
        }
      } catch {
        // fall through to keyword search
      }
    }

    const entries = q
      ? await searchMemory(q, { limit })
      : await listMemories({ category, agentId, limit });
    return json({ entries, source: "keyword" });
  }

  if (url.pathname === "/api/memory" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { category = "fact", text = "", tags = [], agentId, sessionId } = body;
    if (!text.trim()) return json({ error: "text is required" }, 400);
    const entry = await addMemory({ category, text, tags, agentId, sessionId });

    // Mirror to vector service (non-blocking — fire and forget)
    if (vectorUrl) {
      fetch(`${vectorUrl}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id, category: entry.category, text: entry.text, tags: entry.tags, agent_id: entry.agentId ?? null }),
      }).catch(() => {});
    }

    return json({ entry }, 201);
  }

  const memoryMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/);

  if (memoryMatch && request.method === "PATCH") {
    const body    = await request.json().catch(() => ({}));
    const updated = await editMemory(memoryMatch[1], body);
    return updated ? json({ entry: updated }) : json({ error: "Not found" }, 404);
  }

  if (memoryMatch && request.method === "DELETE") {
    const ok = await deleteMemory(memoryMatch[1]);

    // Mirror deletion to vector service (non-blocking)
    if (ok && vectorUrl) {
      fetch(`${vectorUrl}/embed/${memoryMatch[1]}`, { method: "DELETE" }).catch(() => {});
    }

    return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }

  // Workspace config
  if (url.pathname === "/api/workspace" && request.method === "GET") {
    return json({ workspace });
  }

  if (url.pathname === "/api/workspace" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (typeof body.rootDir === "string") workspace.rootDir = body.rootDir;
    if ("tmuxSession" in body) workspace.tmuxSession = body.tmuxSession ?? null;
    addEvent({ sessionId: "system", type: "session", level: "info", message: `Workspace: ${workspace.rootDir}` });
    return json({ workspace });
  }

  // SSH connections
  if (url.pathname === "/api/ssh" && request.method === "GET") {
    return json({ connections: await listSshConnections() });
  }

  if (url.pathname === "/api/ssh" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { label, host, user, port, keyPath, description } = body;
    if (!label || !host || !user) return json({ error: "label, host, user required" }, 400);
    const conn = await addSshConnection({ label, host, user, port, keyPath, description });
    addEvent({ sessionId: "system", type: "ssh", level: "success", message: `SSH connection added: ${conn.label}` });
    return json({ connection: conn }, 201);
  }

  const sshIdMatch = url.pathname.match(/^\/api\/ssh\/([^/]+)$/);

  if (sshIdMatch && request.method === "PATCH") {
    const body = await request.json().catch(() => ({}));
    const updated = await editSshConnection(sshIdMatch[1], body);
    return updated ? json({ connection: updated }) : json({ error: "Not found" }, 404);
  }

  if (sshIdMatch && request.method === "DELETE") {
    const ok = await deleteSshConnection(sshIdMatch[1]);
    return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }

  const sshTestMatch = url.pathname.match(/^\/api\/ssh\/([^/]+)\/test$/);
  if (sshTestMatch && request.method === "POST") {
    const conn = await getSshConnection(sshTestMatch[1]);
    if (!conn) return json({ error: "Not found" }, 404);
    const result = await testSshConnection(conn);
    addEvent({ sessionId: "system", type: "ssh", level: result.ok ? "success" : "error", message: `SSH test ${conn.label}: ${result.ok ? "OK" : result.stderr}` });
    return json(result);
  }

  const sshRunMatch = url.pathname.match(/^\/api\/ssh\/([^/]+)\/run$/);
  if (sshRunMatch && request.method === "POST") {
    const conn = await getSshConnection(sshRunMatch[1]);
    if (!conn) return json({ error: "Not found" }, 404);
    const body = await request.json().catch(() => ({}));
    const command = typeof body.command === "string" ? body.command : "";
    if (!command) return json({ error: "command required" }, 400);
    const result = await runSshCommand(conn, command);
    addEvent({ sessionId: "system", type: "ssh", level: "info", message: `SSH [${conn.label}] $ ${command.slice(0, 60)}` });
    return json(result);
  }

  const sshTmuxMatch = url.pathname.match(/^\/api\/ssh\/([^/]+)\/tmux$/);
  if (sshTmuxMatch && request.method === "POST") {
    const conn = await getSshConnection(sshTmuxMatch[1]);
    if (!conn) return json({ error: "Not found" }, 404);
    const body = await request.json().catch(() => ({}));
    const tmuxSession = typeof body.tmuxSession === "string" ? body.tmuxSession : workspace.tmuxSession;
    if (!tmuxSession) return json({ error: "tmuxSession required" }, 400);
    const result = await openSshInTmux(conn, tmuxSession);
    if (result.ok) addEvent({ sessionId: "system", type: "ssh", level: "success", message: `SSH ${conn.label} opened in tmux:${tmuxSession}` });
    return json(result);
  }

  // Orchestrator (Autopilot)
  if (url.pathname === "/api/orchestrate" && request.method === "GET") {
    return json({ sessions: Array.from(orchestratorSessions.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }

  if (url.pathname === "/api/orchestrate" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (!goal) return json({ error: "goal required" }, 400);

    const workDir = typeof body.workDir === "string" ? body.workDir : workspace.rootDir;
    const tmuxSession = typeof body.tmuxSession === "string" ? body.tmuxSession : workspace.tmuxSession;

    const session: OrchestratorSession = {
      id: crypto.randomUUID(),
      goal,
      workDir,
      tmuxSession,
      status: "planning",
      planStatus: "planning",
      plan: null,
      runs: [],
      createdAt: new Date().toISOString(),
    };
    orchestratorSessions.set(session.id, session);
    addEvent({ sessionId: session.id, type: "orchestrator", level: "info", message: `Autopilot: ${goal.slice(0, 80)}` });
    broadcast("orchestrator:snapshot", Array.from(orchestratorSessions.values()));

    const controller = new AbortController();
    runControllers.set(session.id, controller);

    (async () => {
      try {
        for await (const event of orchestrate(
          session,
          workDir,
          tmuxSession,
          Deno.env.get("ANTHROPIC_API_KEY") ?? "",
          Deno.env.get("OPENAI_API_KEY") ?? "",
          controller.signal
        )) {
          broadcast("orchestrator:event", { sessionId: session.id, event });
          broadcast("orchestrator:snapshot", Array.from(orchestratorSessions.values()));
          if (event.type === "agent_start") {
            addEvent({ sessionId: session.id, type: "orchestrator", level: "info", message: `[${event.index + 1}/${event.total}] ${event.role} started` });
          } else if (event.type === "agent_done") {
            const run = session.runs.find((r) => r.id === event.runId);
            if (run && event.filesWritten?.length) run.filesWritten = event.filesWritten;
            const fileMsg = event.filesWritten?.length ? ` · wrote ${event.filesWritten.length} file(s)` : "";
            addEvent({ sessionId: session.id, type: "orchestrator", level: "success", message: `${run?.role ?? "Agent"} done${fileMsg}` });
          } else if (event.type === "agent_error") {
            addEvent({ sessionId: session.id, type: "orchestrator", level: "error", message: `Agent error: ${event.error.slice(0, 80)}` });
          } else if (event.type === "tool_call") {
            addEvent({ sessionId: session.id, type: "orchestrator", level: "info", message: `Tool: ${event.tool}(${JSON.stringify(event.args).slice(0, 60)})` });
          } else if (event.type === "done") {
            addEvent({ sessionId: session.id, type: "orchestrator", level: "success", message: "Autopilot complete" });
          }
        }
      } finally {
        runControllers.delete(session.id);
        broadcast("orchestrator:snapshot", Array.from(orchestratorSessions.values()));
      }
    })();

    return json({ session }, 201);
  }

  const orchestrateIdMatch = url.pathname.match(/^\/api\/orchestrate\/([^/]+)$/);
  if (orchestrateIdMatch && request.method === "DELETE") {
    const id = orchestrateIdMatch[1];
    const s = orchestratorSessions.get(id);
    if (!s) return json({ error: "Not found" }, 404);
    if (s.status === "running" || s.status === "planning") {
      runControllers.get(id)?.abort();
      s.status = "cancelled";
    }
    orchestratorSessions.delete(id);
    broadcast("orchestrator:snapshot", Array.from(orchestratorSessions.values()));
    return json({ ok: true });
  }

  const orchestrateAbortMatch = url.pathname.match(/^\/api\/orchestrate\/([^/]+)\/abort$/);
  if (orchestrateAbortMatch && request.method === "POST") {
    const s = orchestratorSessions.get(orchestrateAbortMatch[1]);
    if (!s) return json({ error: "Not found" }, 404);
    runControllers.get(s.id)?.abort();
    s.status = "cancelled";
    broadcast("orchestrator:snapshot", Array.from(orchestratorSessions.values()));
    return json({ ok: true });
  }

  const orchestratePauseMatch = url.pathname.match(/^\/api\/orchestrate\/([^/]+)\/pause\/([^/]+)$/);
  if (orchestratePauseMatch && request.method === "POST") {
    const ok = pauseOrchestratorRun(orchestratePauseMatch[1], orchestratePauseMatch[2]);
    return json({ ok });
  }

  const orchestrateResumeMatch = url.pathname.match(/^\/api\/orchestrate\/([^/]+)\/resume\/([^/]+)$/);
  if (orchestrateResumeMatch && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const ok = resumeOrchestratorRun(orchestrateResumeMatch[1], orchestrateResumeMatch[2], body.modifiedTask);
    return json({ ok });
  }

  const orchestrateDiffMatch = url.pathname.match(/^\/api\/orchestrate\/([^/]+)\/diff$/);
  if (orchestrateDiffMatch && request.method === "GET") {
    const sess = orchestratorSessions.get(orchestrateDiffMatch[1]);
    if (!sess) return json({ error: "Not found" }, 404);
    const allFiles = sess.runs.flatMap((r) => r.filesWritten ?? []);
    const unique = [...new Set(allFiles)];
    if (unique.length === 0) return json({ diff: "(no files were written in this session)" });
    try {
      const proc = new Deno.Command("git", {
        args: ["diff", "HEAD", "--", ...unique],
        cwd: sess.workDir,
        stdout: "piped",
        stderr: "piped",
      });
      const { stdout, stderr } = await proc.output();
      const diff = new TextDecoder().decode(stdout).trim() || new TextDecoder().decode(stderr).trim();
      return json({ diff: diff || "(no uncommitted changes to these files)", files: unique });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
}

// Session orchestration

function createSession(request: CreateSessionRequest): AgentSession {
  const selectedAgents = request.agentIds
    .map((id) => findAgent(id))
    .filter((a): a is AgentConfig => Boolean(a));
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();

  return {
    id: sessionId,
    title: request.title?.trim() || titleFromPrompt(request.prompt),
    prompt: request.prompt,
    status: "queued",
    createdAt: now,
    runs: selectedAgents.map((agent) => ({
      id: crypto.randomUUID(),
      sessionId,
      agentId: agent.id,
      agentName: agent.name,
      provider: agent.provider,
      model: agent.model,
      prompt: request.prompt,
      status: "queued",
      output: ""
    }))
  };
}

async function runSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.status = "running";
  emitSession(session);
  addEvent({ sessionId, type: "session", level: "info", message: "Session started" });

  await Promise.all(session.runs.map((run) => runAgent(session, run)));

  const finalStatus = summarizeStatus(session.runs.map((r) => r.status));
  session.status = finalStatus;
  session.completedAt = new Date().toISOString();
  addEvent({
    sessionId,
    type: "session",
    level: finalStatus === "completed" ? "success" : finalStatus === "failed" ? "error" : "warning",
    message: `Session ${finalStatus}`
  });
  emitSession(session);
  emitSessions();
}

async function runAgent(session: AgentSession, run: AgentRun) {
  const agent = findAgent(run.agentId);
  if (!agent) { markRunFailed(session, run, "Agent not found"); return; }

  const controller = new AbortController();
  runControllers.set(run.id, controller);
  run.status = "running";
  run.startedAt = new Date().toISOString();
  emitSession(session);
  addEvent({
    sessionId: session.id, runId: run.id, agentId: run.agentId,
    type: "run", level: "info",
    message: `${run.agentName} started${providerConfigured(run.provider) ? "" : " (mock)"}`
  });

  try {
    for await (const delta of streamAgentResponse(agent, run.prompt, controller.signal)) {
      run.output += delta;
      const payload: RunDeltaPayload = { sessionId: session.id, runId: run.id, delta };
      broadcast("run:delta", payload);
    }
    run.status = "completed";
    run.completedAt = new Date().toISOString();
    addEvent({ sessionId: session.id, runId: run.id, agentId: run.agentId, type: "run", level: "success", message: `${run.agentName} done` });
  } catch (error) {
    if (controller.signal.aborted) {
      run.status = "cancelled";
      run.completedAt = new Date().toISOString();
      addEvent({ sessionId: session.id, runId: run.id, agentId: run.agentId, type: "run", level: "warning", message: `${run.agentName} cancelled` });
    } else {
      markRunFailed(session, run, error instanceof Error ? error.message : "Unknown error");
    }
  } finally {
    runControllers.delete(run.id);
    emitSession(session);
    emitSessions();
  }
}

function markRunFailed(session: AgentSession, run: AgentRun, message: string) {
  run.status = "failed";
  run.error = message;
  run.completedAt = new Date().toISOString();
  addEvent({ sessionId: session.id, runId: run.id, agentId: run.agentId, type: "run", level: "error", message: `${run.agentName} failed: ${message}` });
}

function summarizeStatus(statuses: AgentRun["status"][]): SessionStatus {
  if (statuses.every((s) => s === "completed")) return "completed";
  if (statuses.every((s) => s === "cancelled")) return "cancelled";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "cancelled")) return "cancelled";
  return "completed";
}

function getProviderHealth(): ProviderHealth[] {
  return [
    {
      provider: "openai",
      label: "OpenAI",
      configured: providerConfigured("openai"),
      detail: providerConfigured("openai") ? "Responses API ready" : "OPENAI_API_KEY missing — mock mode"
    },
    {
      provider: "anthropic",
      label: "Anthropic Claude",
      configured: providerConfigured("anthropic"),
      detail: providerConfigured("anthropic") ? "Messages API ready" : "ANTHROPIC_API_KEY missing — mock mode"
    },
    {
      provider: "mock",
      label: "Local mock",
      configured: true,
      detail: "Deterministic streaming simulator"
    }
  ];
}

function parseCreateSession(body: unknown): { ok: true; value: CreateSessionRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected JSON object" };
  const c = body as Record<string, unknown>;
  const prompt = typeof c.prompt === "string" ? c.prompt.trim() : "";
  const title = typeof c.title === "string" ? c.title.trim() : undefined;
  const agentIds = Array.isArray(c.agentIds)
    ? c.agentIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  if (!prompt) return { ok: false, error: "Prompt is required" };
  if (agentIds.length === 0) return { ok: false, error: "At least one agent is required" };
  return { ok: true, value: { title, prompt, agentIds } };
}

function titleFromPrompt(prompt: string) {
  const compact = prompt.trim().replace(/\s+/g, " ");
  return compact.length > 56 ? `${compact.slice(0, 56)}…` : compact;
}

// WebSocket helpers

function listSessionsSorted() {
  return Array.from(sessions.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function emitSession(session: AgentSession) { broadcast("session:updated", session); }
function emitSessions() { broadcast("sessions:snapshot", listSessionsSorted()); }

function addEvent(event: Omit<SessionEvent, "id" | "createdAt">) {
  const e: SessionEvent = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...event };
  events.push(e);
  if (events.length > 500) events.splice(0, events.length - 500);
  broadcast("session:event", e);
}

function broadcast(type: string, payload: unknown) {
  const msg = JSON.stringify({ type, payload });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function send(client: WebSocket, type: string, payload: unknown) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type, payload }));
}

// HTTP helpers

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function corsHeaders(headers = new Headers()): Headers {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return headers;
}


async function serveStatic(url: URL) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = pathname.replace(/^\/+/, "").replaceAll("..", "");
  const fileUrl = new URL(`../public/${safePath}`, import.meta.url);

  try {
    const body = await Deno.readFile(fileUrl);
    return new Response(body, { headers: { "content-type": contentType(fileUrl.pathname) } });
  } catch {
    const body = await Deno.readFile(new URL("../public/index.html", import.meta.url));
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

function contentType(pathname: string) {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

// .env loader

async function loadEnvFile() {
  try {
    const text = await Deno.readTextFile(".env");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const sep = line.indexOf("=");
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim();
      const value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, "");
      if (key && Deno.env.get(key) === undefined) Deno.env.set(key, value);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(`Could not load .env: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
