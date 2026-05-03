import { findAgent, getAgents } from "./agents.ts";
import { getConnectors } from "./connectors.ts";
import { providerConfigured, streamAgentResponse } from "./providers.ts";
import type {
  AgentRun,
  AgentSession,
  AgentConfig,
  CreateSessionRequest,
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

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/ws") {
    const { socket, response } = Deno.upgradeWebSocket(request);

    socket.addEventListener("open", () => {
      clients.add(socket);
      send(socket, "sessions:snapshot", listSessions());
      send(socket, "events:snapshot", events.slice(-250));
    });

    socket.addEventListener("close", () => {
      clients.delete(socket);
    });

    return response;
  }

  if (url.pathname.startsWith("/api/")) {
    return handleApi(request, url);
  }

  return serveStatic(url);
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({
      ok: true,
      providers: getProviderHealth()
    });
  }

  if (url.pathname === "/api/agents" && request.method === "GET") {
    return json({
      agents,
      providers: getProviderHealth()
    });
  }

  if (url.pathname === "/api/connectors" && request.method === "GET") {
    return json({ connectors: getConnectors() });
  }

  if (url.pathname === "/api/events" && request.method === "GET") {
    return json({ events: events.slice(-250) });
  }

  if (url.pathname === "/api/sessions" && request.method === "GET") {
    return json({ sessions: listSessions() });
  }

  if (url.pathname === "/api/sessions" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const parsed = parseCreateSession(body);

    if (!parsed.ok) {
      return json({ error: parsed.error }, 400);
    }

    const session = createSession(parsed.value);
    sessions.set(session.id, session);
    addEvent({
      sessionId: session.id,
      type: "session",
      level: "info",
      message: `Queued ${session.runs.length} agent run${session.runs.length === 1 ? "" : "s"}`
    });
    emitSessions();
    runSession(session.id);

    return json({ session }, 201);
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);

  if (sessionMatch && request.method === "GET") {
    const session = sessions.get(sessionMatch[1]);

    if (!session) {
      return json({ error: "Session not found" }, 404);
    }

    return json({ session });
  }

  const abortMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);

  if (abortMatch && request.method === "POST") {
    const session = sessions.get(abortMatch[1]);

    if (!session) {
      return json({ error: "Session not found" }, 404);
    }

    for (const run of session.runs) {
      if (run.status === "queued" || run.status === "running") {
        runControllers.get(run.id)?.abort();
        run.status = "cancelled";
        run.completedAt = new Date().toISOString();
      }
    }

    session.status = "cancelled";
    session.completedAt = new Date().toISOString();
    addEvent({
      sessionId: session.id,
      type: "session",
      level: "warning",
      message: "Session cancelled"
    });
    emitSession(session);
    emitSessions();

    return json({ session });
  }

  return json({ error: "Not found" }, 404);
}

function createSession(request: CreateSessionRequest): AgentSession {
  const selectedAgents = request.agentIds
    .map((agentId) => findAgent(agentId))
    .filter((agent): agent is AgentConfig => Boolean(agent));
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

  if (!session) {
    return;
  }

  session.status = "running";
  emitSession(session);
  addEvent({
    sessionId,
    type: "session",
    level: "info",
    message: "Session started"
  });

  await Promise.all(session.runs.map((run) => runAgent(session, run)));

  const finalStatus = summarizeStatus(session.runs.map((run) => run.status));
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

  if (!agent) {
    markRunFailed(session, run, "Agent not found");
    return;
  }

  const controller = new AbortController();
  runControllers.set(run.id, controller);
  run.status = "running";
  run.startedAt = new Date().toISOString();
  emitSession(session);
  addEvent({
    sessionId: session.id,
    runId: run.id,
    agentId: run.agentId,
    type: "run",
    level: "info",
    message: `${run.agentName} started${providerConfigured(run.provider) ? "" : " in mock mode"}`
  });

  try {
    for await (const delta of streamAgentResponse(agent, run.prompt, controller.signal)) {
      run.output += delta;
      const payload: RunDeltaPayload = {
        sessionId: session.id,
        runId: run.id,
        delta
      };
      broadcast("run:delta", payload);
    }

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    addEvent({
      sessionId: session.id,
      runId: run.id,
      agentId: run.agentId,
      type: "run",
      level: "success",
      message: `${run.agentName} completed`
    });
  } catch (error) {
    if (controller.signal.aborted) {
      run.status = "cancelled";
      run.completedAt = new Date().toISOString();
      addEvent({
        sessionId: session.id,
        runId: run.id,
        agentId: run.agentId,
        type: "run",
        level: "warning",
        message: `${run.agentName} cancelled`
      });
    } else {
      markRunFailed(session, run, error instanceof Error ? error.message : "Unknown provider error");
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
  addEvent({
    sessionId: session.id,
    runId: run.id,
    agentId: run.agentId,
    type: "run",
    level: "error",
    message: `${run.agentName} failed: ${message}`
  });
}

function summarizeStatus(statuses: AgentRun["status"][]): SessionStatus {
  if (statuses.every((status) => status === "completed")) {
    return "completed";
  }

  if (statuses.every((status) => status === "cancelled")) {
    return "cancelled";
  }

  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }

  if (statuses.some((status) => status === "cancelled")) {
    return "cancelled";
  }

  return "completed";
}

function getProviderHealth(): ProviderHealth[] {
  return [
    {
      provider: "openai",
      label: "OpenAI",
      configured: providerConfigured("openai"),
      detail: providerConfigured("openai") ? "Responses API ready" : "OPENAI_API_KEY missing; mock mode active"
    },
    {
      provider: "anthropic",
      label: "Anthropic",
      configured: providerConfigured("anthropic"),
      detail: providerConfigured("anthropic") ? "Messages API ready" : "ANTHROPIC_API_KEY missing; mock mode active"
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
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Expected JSON object" };
  }

  const candidate = body as Record<string, unknown>;
  const prompt = typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
  const title = typeof candidate.title === "string" ? candidate.title.trim() : undefined;
  const agentIds = Array.isArray(candidate.agentIds)
    ? candidate.agentIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];

  if (!prompt) {
    return { ok: false, error: "Prompt is required" };
  }

  if (agentIds.length === 0) {
    return { ok: false, error: "At least one agent is required" };
  }

  return {
    ok: true,
    value: {
      title,
      prompt,
      agentIds
    }
  };
}

function titleFromPrompt(prompt: string) {
  const compact = prompt.trim().replace(/\s+/g, " ");
  return compact.length > 56 ? `${compact.slice(0, 56)}...` : compact;
}

function listSessions() {
  return Array.from(sessions.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function emitSession(session: AgentSession) {
  broadcast("session:updated", session);
}

function emitSessions() {
  broadcast("sessions:snapshot", listSessions());
}

function addEvent(event: Omit<SessionEvent, "id" | "createdAt">) {
  const completeEvent: SessionEvent = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...event
  };
  events.push(completeEvent);

  if (events.length > 500) {
    events.splice(0, events.length - 500);
  }

  broadcast("session:event", completeEvent);
}

function broadcast(type: string, payload: unknown) {
  const message = JSON.stringify({ type, payload });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function send(client: WebSocket, type: string, payload: unknown) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({ type, payload }));
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

async function serveStatic(url: URL) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = pathname.replace(/^\/+/, "").replaceAll("..", "");
  const fileUrl = new URL(`../public/${safePath}`, import.meta.url);

  try {
    const body = await Deno.readFile(fileUrl);
    return new Response(body, {
      headers: {
        "content-type": contentType(fileUrl.pathname)
      }
    });
  } catch {
    const body = await Deno.readFile(new URL("../public/index.html", import.meta.url));
    return new Response(body, {
      headers: {
        "content-type": "text/html; charset=utf-8"
      }
    });
  }
}

function contentType(pathname: string) {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function loadEnvFile() {
  try {
    const text = await Deno.readTextFile(".env");

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separator = line.indexOf("=");

      if (separator === -1) {
        continue;
      }

      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");

      if (key && Deno.env.get(key) === undefined) {
        Deno.env.set(key, value);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(`Could not load .env: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
