import { findAgent, getAgents } from "./agents.ts";
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
import type {
  AgentRun,
  AgentSession,
  AgentConfig,
  CreateSessionRequest,
  EmailDraftRequest,
  ProviderHealth,
  RunDeltaPayload,
  SessionEvent,
  SessionStatus
} from "../shared/types.ts";

await loadEnvFile();

const port = Number(Deno.env.get("PORT") || 8787);
const agents = getAgents();
const clients = new Set<WebSocket>();
const sessions = new Map<string, AgentSession>();
const events: SessionEvent[] = [];
const runControllers = new Map<string, AbortController>();

Deno.serve({ hostname: "127.0.0.1", port }, handleRequest);
console.log(`\x1b[31m[HYPERION]\x1b[0m Server running at http://127.0.0.1:${port}`);

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // ── CORS pre-flight (for local dev) ──────────────────────────────────────
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

  if (url.pathname.startsWith("/api/")) {
    const apiResponse = await handleApi(request, url);
    const headers = new Headers(apiResponse.headers);
    corsHeaders(headers);
    return new Response(apiResponse.body, { status: apiResponse.status, headers });
  }

  return serveStatic(url);
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  // ── Health ────────────────────────────────────────────────────────────────
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, providers: getProviderHealth(), name: "Hyperion" });
  }

  // ── Agents ────────────────────────────────────────────────────────────────
  if (url.pathname === "/api/agents" && request.method === "GET") {
    return json({ agents, providers: getProviderHealth() });
  }

  // ── Connectors ────────────────────────────────────────────────────────────
  if (url.pathname === "/api/connectors" && request.method === "GET") {
    return json({ connectors: getConnectors() });
  }

  // ── Events ────────────────────────────────────────────────────────────────
  if (url.pathname === "/api/events" && request.method === "GET") {
    return json({ events: events.slice(-250) });
  }

  // ── Sessions ──────────────────────────────────────────────────────────────
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

  // ── tmux API ─────────────────────────────────────────────────────────────

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

  // ── Email draft (SSE) ─────────────────────────────────────────────────────

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

  // ── Memory API ──────────────────────────────────────────────────────────────

  if (url.pathname === "/api/memory" && request.method === "GET") {
    const category = url.searchParams.get("category") as any ?? undefined;
    const q        = url.searchParams.get("q") ?? "";
    const agentId  = url.searchParams.get("agentId") ?? undefined;
    const limit    = Number(url.searchParams.get("limit") || 50);

    const entries = q
      ? await searchMemory(q, { limit })
      : await listMemories({ category, agentId, limit });
    return json({ entries });
  }

  if (url.pathname === "/api/memory" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { category = "fact", text = "", tags = [], agentId, sessionId } = body;
    if (!text.trim()) return json({ error: "text is required" }, 400);
    const entry = await addMemory({ category, text, tags, agentId, sessionId });
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
    return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }

  return json({ error: "Not found" }, 404);
}

// ── Session orchestration ──────────────────────────────────────────────────

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

// ── WebSocket helpers ─────────────────────────────────────────────────────

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

// ── HTTP helpers ──────────────────────────────────────────────────────────

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function corsHeaders(headers = new Headers()): Headers {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
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

// ── .env loader ───────────────────────────────────────────────────────────

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
