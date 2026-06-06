// ═══════════════════════════════════════════════════════════════════════════
// HYPERION — Agentic harness UI
// ═══════════════════════════════════════════════════════════════════════════

// ── Matrix rain ─────────────────────────────────────────────────────────────

(function initMatrixRain() {
  const canvas = document.getElementById("matrix-rain");
  const ctx = canvas.getContext("2d");

  const CHARS =
    "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモラリルレロ" +
    "0123456789ABCDEF<>{}[]|/\\";
  const FONT_SIZE = 13;
  let cols, drops;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cols = Math.floor(canvas.width / FONT_SIZE);
    drops = new Array(cols).fill(0);
  }

  function draw() {
    ctx.fillStyle = "rgba(5, 5, 5, 0.06)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${FONT_SIZE}px 'JetBrains Mono', monospace`;

    for (let i = 0; i < cols; i++) {
      const char = CHARS[Math.floor(Math.random() * CHARS.length)];
      const y = drops[i] * FONT_SIZE;

      // Lead character: brighter red
      if (drops[i] > 0) {
        ctx.fillStyle = "rgba(255, 60, 60, 0.9)";
        ctx.fillText(char, i * FONT_SIZE, y);
      }
      // Trail
      ctx.fillStyle = "rgba(160, 10, 10, 0.35)";
      ctx.fillText(char, i * FONT_SIZE, y + FONT_SIZE);

      if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
      else drops[i]++;
    }
  }

  resize();
  window.addEventListener("resize", resize);
  setInterval(draw, 55);
})();

// ── State ────────────────────────────────────────────────────────────────────

const STARTER_PROMPTS = [
  "Design Hyperion as a multi-agent orchestration layer with real-time tool dispatch and human approval gates.",
  "Compare strategies for agentic email triage: classify → draft → approve vs. full-auto with undo.",
  "Plan a tmux-based debugging workflow where an agent runs tests, reads failures, and proposes fixes."
];

const state = {
  // agents & providers
  agents: [],
  providers: [],
  connectors: [],
  selectedAgentIds: [],

  // sessions
  sessions: [],
  events: [],
  selectedSessionId: null,

  // composer
  prompt: STARTER_PROMPTS[0],
  submitting: false,

  // tool panel ("chat" | "tmux" | "email" | "files")
  activeTool: "chat",

  // tmux
  tmuxSessions: [],
  selectedTmuxSession: null,
  tmuxOutput: "",
  tmuxCommand: "",
  tmuxStreaming: false,   // true when WebSocket stream is active

  // files / context
  fileContexts: [],

  // email
  emailTo: "",
  emailSubject: "",
  emailContext: "",
  emailDraft: "",
  emailDrafting: false,
  emailTone: "professional",
};

let tmuxPollTimer = null;
let tmuxStreamSocket = null;

// ── Bootstrap ────────────────────────────────────────────────────────────────

const app = document.querySelector("#app");

await loadInitialData();
connectSocket();
render();

// ── Event delegation ─────────────────────────────────────────────────────────

app.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  handleAction(t.dataset.action, t.dataset.id ?? t.dataset.value ?? "", t, e);
});

app.addEventListener("input", (e) => {
  const id = e.target.id;
  if (id === "prompt")        { state.prompt = e.target.value; return; }
  if (id === "tmux-command")  { state.tmuxCommand = e.target.value; return; }
  if (id === "email-to")      { state.emailTo = e.target.value; return; }
  if (id === "email-subject") { state.emailSubject = e.target.value; return; }
  if (id === "email-context") { state.emailContext = e.target.value; return; }
  if (id === "email-draft")   { state.emailDraft = e.target.value; return; }
});

app.addEventListener("keydown", (e) => {
  if (e.target.id === "tmux-command" && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTmuxCommand();
  }
});

// Drag & drop on file zone
app.addEventListener("dragover", (e) => {
  if (e.target.closest("[data-dropzone]")) {
    e.preventDefault();
    e.target.closest("[data-dropzone]").classList.add("drag-over");
  }
});

app.addEventListener("dragleave", (e) => {
  const zone = e.target.closest("[data-dropzone]");
  if (zone) zone.classList.remove("drag-over");
});

app.addEventListener("drop", async (e) => {
  const zone = e.target.closest("[data-dropzone]");
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove("drag-over");

  for (const file of e.dataTransfer.files) {
    const content = await file.text().catch(() => "[binary file — content not readable]");
    state.fileContexts = [...state.fileContexts, {
      id: crypto.randomUUID(),
      name: file.name,
      content,
      size: file.size
    }];
  }
  render();
});

document.addEventListener("paste", async (e) => {
  if (state.activeTool !== "files") return;
  const text = e.clipboardData?.getData("text");
  if (text && text.length > 80) {
    state.fileContexts = [...state.fileContexts, {
      id: crypto.randomUUID(),
      name: "pasted-content.txt",
      content: text,
      size: text.length
    }];
    render();
  }
});

// ── Action handler ───────────────────────────────────────────────────────────

function handleAction(action, value, el, e) {
  switch (action) {

    // tool panel
    case "switch-tool":
      state.activeTool = value;
      if (value === "tmux") loadTmuxSessions();
      else stopTmuxStream();
      render();
      break;

    // sessions
    case "select-session":
      state.selectedSessionId = value;
      render();
      break;

    case "run":
      createSession();
      break;

    case "refresh":
      loadInitialData();
      break;

    case "abort":
      abortSession(value);
      break;

    case "starter":
      state.prompt = STARTER_PROMPTS[Number(value)];
      render();
      break;

    // agents
    case "toggle-agent":
      state.selectedAgentIds = toggle(state.selectedAgentIds, value);
      render();
      break;

    case "select-all-agents":
      state.selectedAgentIds = state.agents.map((a) => a.id);
      render();
      break;

    // tmux
    case "load-tmux":
      loadTmuxSessions();
      break;

    case "select-tmux":
      selectTmuxSession(value);
      break;

    case "new-tmux":
      createTmuxSession();
      break;

    case "kill-tmux":
      e.stopPropagation();
      killTmuxSession(value);
      break;

    case "send-tmux":
      sendTmuxCommand();
      break;

    case "ai-suggest-tmux":
      suggestTmuxCommand();
      break;

    // files
    case "remove-file":
      state.fileContexts = state.fileContexts.filter((f) => f.id !== value);
      render();
      break;

    case "clear-files":
      state.fileContexts = [];
      render();
      break;

    // email
    case "set-tone":
      state.emailTone = value;
      render();
      break;

    case "draft-email":
      draftEmail();
      break;

    case "clear-email":
      state.emailDraft = "";
      state.emailContext = "";
      render();
      break;

    case "copy-draft":
      navigator.clipboard.writeText(state.emailDraft).catch(() => {});
      break;
  }
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function loadInitialData() {
  const [agRes, connRes, sessRes, evRes] = await Promise.all([
    fetch("/api/agents"),
    fetch("/api/connectors"),
    fetch("/api/sessions"),
    fetch("/api/events")
  ]);

  const agData   = await agRes.json();
  const connData = await connRes.json();
  const sessData = await sessRes.json();
  const evData   = await evRes.json();

  state.agents     = agData.agents;
  state.providers  = agData.providers;
  state.connectors = connData.connectors;
  state.sessions   = sessData.sessions;
  state.events     = evData.events;

  if (state.selectedAgentIds.length === 0) {
    state.selectedAgentIds = state.agents.map((a) => a.id);
  }
  state.selectedSessionId ??= state.sessions[0]?.id ?? null;
  render();
}

async function createSession() {
  if (!state.prompt.trim() || !state.selectedAgentIds.length || state.submitting) return;
  state.submitting = true;
  render();

  // Prepend file context to prompt
  let fullPrompt = state.prompt;
  if (state.fileContexts.length > 0) {
    const ctx = state.fileContexts
      .map((f) => `--- File: ${f.name} ---\n${f.content}`)
      .join("\n\n");
    fullPrompt = `${ctx}\n\n---\n\n${state.prompt}`;
  }

  try {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: fullPrompt, agentIds: state.selectedAgentIds })
    });
    const data = await res.json();
    if (res.ok) state.selectedSessionId = data.session.id;
  } finally {
    state.submitting = false;
    render();
  }
}

async function abortSession(id) {
  await fetch(`/api/sessions/${id}/abort`, { method: "POST" });
}

// ── tmux ─────────────────────────────────────────────────────────────────────

async function loadTmuxSessions() {
  const res = await fetch("/api/tmux/sessions");
  const data = await res.json();
  state.tmuxSessions = data.sessions ?? [];

  if (state.selectedTmuxSession && !state.tmuxSessions.find((s) => s.name === state.selectedTmuxSession)) {
    state.selectedTmuxSession = null;
    state.tmuxOutput = "";
    stopTmuxPoll();
  }
  render();
}

function selectTmuxSession(name) {
  state.selectedTmuxSession = name;
  state.tmuxOutput = "";
  stopTmuxStream();
  startTmuxStream(name);
  render();
}

function startTmuxStream(name) {
  stopTmuxStream();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/tmux/ws/${encodeURIComponent(name)}`);
  tmuxStreamSocket = ws;

  ws.addEventListener("open", () => {
    state.tmuxStreaming = true;
    render();
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "output" && msg.payload?.data !== undefined) {
        state.tmuxOutput = msg.payload.data;
        render();
        const pane = document.querySelector(".tmuxOutput");
        if (pane) pane.scrollTop = pane.scrollHeight;
      }
    } catch { /* ignore malformed frames */ }
  });

  ws.addEventListener("close", () => {
    tmuxStreamSocket = null;
    state.tmuxStreaming = false;
    // Fall back to REST polling if the WebSocket closes unexpectedly
    if (state.selectedTmuxSession === name) {
      startTmuxPoll(name);
    }
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

function stopTmuxStream() {
  if (tmuxStreamSocket) { tmuxStreamSocket.close(); tmuxStreamSocket = null; }
  state.tmuxStreaming = false;
  stopTmuxPoll();
}

async function fetchTmuxOutput(name) {
  const res = await fetch(`/api/tmux/sessions/${encodeURIComponent(name)}/output`);
  const data = await res.json();
  state.tmuxOutput = data.output ?? "";
  render();
  const pane = document.querySelector(".tmuxOutput");
  if (pane) pane.scrollTop = pane.scrollHeight;
}

function startTmuxPoll(name) {
  stopTmuxPoll();
  tmuxPollTimer = setInterval(() => fetchTmuxOutput(name), 2000);
}

function stopTmuxPoll() {
  if (tmuxPollTimer) { clearInterval(tmuxPollTimer); tmuxPollTimer = null; }
}

async function createTmuxSession() {
  const name = `hx-${Date.now().toString(36)}`;
  await fetch("/api/tmux/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  await loadTmuxSessions();
  selectTmuxSession(name);
}

async function killTmuxSession(name) {
  if (state.selectedTmuxSession === name) {
    state.selectedTmuxSession = null;
    state.tmuxOutput = "";
    stopTmuxStream();
  }
  await fetch(`/api/tmux/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
  await loadTmuxSessions();
}

async function sendTmuxCommand() {
  const cmd = state.tmuxCommand.trim();
  const session = state.selectedTmuxSession;
  if (!cmd || !session) return;

  state.tmuxCommand = "";
  render();

  await fetch(`/api/tmux/sessions/${encodeURIComponent(session)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: cmd })
  });

  // The WebSocket stream will pick up new output automatically.
  // If streaming isn't active (fallback polling), force an immediate fetch.
  if (!state.tmuxStreaming) setTimeout(() => fetchTmuxOutput(session), 400);
}

async function suggestTmuxCommand() {
  const session = state.selectedTmuxSession;
  if (!session || !state.tmuxOutput) return;

  // Ask Claude to suggest next command based on pane output
  const truncated = state.tmuxOutput.slice(-2000);
  const prompt = `Based on this terminal output, suggest the single most useful next command to run:\n\`\`\`\n${truncated}\n\`\`\`\nReply with ONLY the command, nothing else.`;

  const agent = state.agents.find((a) => a.provider === "anthropic") || state.agents[0];
  if (!agent) return;

  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, agentIds: [agent.id], title: `AI suggest for [${session}]` })
  });
  const data = await res.json();
  if (res.ok) state.selectedSessionId = data.session.id;
  state.activeTool = "chat";
  render();
}

// ── Email drafting ─────────────────────────────────────────────────────────

async function draftEmail() {
  if (state.emailDrafting) return;
  state.emailDrafting = true;
  state.emailDraft = "";
  render();

  try {
    const res = await fetch("/api/draft-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: state.emailContext,
        to: state.emailTo,
        subject: state.emailSubject,
        tone: state.emailTone
      })
    });

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      const parts = buf.split("\n");
      buf = parts.pop() ?? "";

      for (const line of parts) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") break;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.delta) { state.emailDraft += parsed.delta; render(); }
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    state.emailDraft = `[Error: ${err instanceof Error ? err.message : String(err)}]`;
  } finally {
    state.emailDrafting = false;
    render();
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function connectSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data);

    if (msg.type === "sessions:snapshot") {
      state.sessions = msg.payload;
      state.selectedSessionId ??= state.sessions[0]?.id ?? null;
    }
    if (msg.type === "events:snapshot") state.events = msg.payload;
    if (msg.type === "session:updated") {
      state.sessions = upsert(state.sessions, msg.payload);
      state.selectedSessionId ??= msg.payload.id;
    }
    if (msg.type === "run:delta") state.sessions = applyDelta(state.sessions, msg.payload);
    if (msg.type === "session:event") state.events = [...state.events.slice(-249), msg.payload];

    render();
  });

  ws.addEventListener("close", () => setTimeout(connectSocket, 1200));
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const selectedSession = state.sessions.find((s) => s.id === state.selectedSessionId) ?? state.sessions[0] ?? null;
  const runningCount = state.sessions.reduce(
    (n, s) => n + s.runs.filter((r) => r.status === "running").length, 0
  );
  const readyConn = state.connectors.filter((c) => c.status === "ready" || c.status === "mock").length;

  app.innerHTML = `
    <div class="appShell">
      ${renderSidebar(selectedSession, runningCount, readyConn)}
      ${renderWorkspace(selectedSession, runningCount)}
      ${renderEventRail()}
    </div>
  `;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar(selectedSession, runningCount, readyConn) {
  return `
    <aside class="sidebar">

      <div class="brandBlock">
        <div class="brandMark">
          ${icon("zap")}
        </div>
        <div class="brandText">
          <h1>HYPERION</h1>
          <p>Agentic Harness</p>
        </div>
      </div>

      <div class="sidebarSection">
        <div class="secLabel">${icon("radio")} Providers</div>
        <div class="providerList">
          ${state.providers.map(renderProvider).join("")}
        </div>
      </div>

      <div class="sidebarSection">
        <div class="secLabel">${icon("layers")} Tools</div>
        <div class="toolNav">
          ${["chat","tmux","email","files"].map((t) => renderToolNavBtn(t)).join("")}
        </div>
      </div>

      <div class="sidebarSection">
        <div class="secLabel">
          ${icon("cpu")} Agents
          <button class="btn btn-icon" data-action="select-all-agents" title="Select all" style="width:20px;height:20px;margin-left:auto;">
            ${icon("check-all")}
          </button>
        </div>
        <div class="agentList">
          ${state.agents.map((a) => renderSidebarAgent(a)).join("")}
        </div>
      </div>

      <div class="sidebarSection">
        <div class="secLabel">${icon("plug")} Connectors <span class="badge">${readyConn}</span></div>
        <div class="connectorGrid">
          ${state.connectors.slice(0, 4).map(renderConnector).join("")}
        </div>
      </div>

      <div class="sidebarSection fill">
        <div class="secLabel">${icon("clock")} Sessions</div>
        <div class="sessionList">
          ${state.sessions.slice(0, 20).map((s) => `
            <button class="sessionBtn ${s.id === state.selectedSessionId ? "active" : ""}"
              data-action="select-session" data-id="${s.id}">
              <span>${esc(s.title)}</span>
              <small>${s.runs.length} agents · ${s.status}</small>
            </button>
          `).join("") || `<p style="color:var(--text-muted);font-size:0.7rem;">No sessions yet</p>`}
        </div>
      </div>

    </aside>
  `;
}

function renderProvider(p) {
  return `
    <div class="providerRow">
      <span class="dot ${p.configured ? "ready" : "mock"}"></span>
      <div>
        <strong>${esc(p.label)}</strong>
        <small>${esc(p.detail)}</small>
      </div>
    </div>
  `;
}

function renderToolNavBtn(tool) {
  const labels = { chat: "Chat", tmux: "tmux", email: "Email", files: "Files" };
  const icons  = { chat: "message", tmux: "terminal", email: "inbox", files: "file" };
  return `
    <button class="toolNavBtn ${state.activeTool === tool ? "active" : ""}"
      data-action="switch-tool" data-value="${tool}">
      ${icon(icons[tool])}
      ${labels[tool]}
    </button>
  `;
}

function renderSidebarAgent(a) {
  const sel = state.selectedAgentIds.includes(a.id);
  return `
    <button class="agentBtn ${sel ? "selected" : ""}" data-action="toggle-agent" data-id="${a.id}">
      <span class="agentAccent" style="background:${esc(a.accent)}"></span>
      <span>
        <strong>${esc(a.name)}</strong>
        <small>${esc(a.provider)} · ${esc(a.model)}</small>
      </span>
      <svg class="checkIcon" viewBox="0 0 24 24"><path d="m20 6-11 11-5-5"/></svg>
    </button>
  `;
}

function renderConnector(c) {
  const iconKey = c.kind === "calendar" ? "calendar" : c.kind === "shell" ? "terminal" : "inbox";
  return `
    <div class="connectorItem">
      ${icon(iconKey)}
      <span>
        <strong>${esc(c.name)}</strong>
        <small>${esc(c.status === "needs_env" ? c.envVars.join(", ") : c.detail)}</small>
      </span>
      <span class="connPill ${c.status}">${esc(c.status.replace("_", " "))}</span>
    </div>
  `;
}

// ── Workspace ─────────────────────────────────────────────────────────────────

function renderWorkspace(selectedSession, runningCount) {
  const toolPanels = {
    chat:  renderChatPanel(selectedSession, runningCount),
    tmux:  renderTmuxPanel(),
    email: renderEmailPanel(),
    files: renderFilesPanel()
  };

  return `
    <main class="workspace">
      <div class="workspaceHeader">
        <span class="sessionTitle">${esc(selectedSession?.title ?? "— NEW SESSION —")}</span>
        <div class="headerMetrics">
          ${metricBox("Running", runningCount)}
          ${metricBox("Sessions", state.sessions.length)}
          ${metricBox("Files", state.fileContexts.length)}
        </div>
      </div>

      <div class="toolTabBar">
        ${renderToolTab("chat",  "message",  "CHAT")}
        ${renderToolTab("tmux",  "terminal", "TMUX")}
        ${renderToolTab("email", "inbox",    "EMAIL")}
        ${renderToolTab("files", "file",     "FILES")}
      </div>

      <div class="toolPanel">
        ${toolPanels[state.activeTool]}
      </div>
    </main>
  `;
}

function renderToolTab(id, iconName, label) {
  return `
    <button class="toolTab ${state.activeTool === id ? "active" : ""}"
      data-action="switch-tool" data-value="${id}">
      ${icon(iconName)} ${label}
    </button>
  `;
}

function metricBox(label, val) {
  return `
    <div class="metric">
      <small>${label}</small>
      <strong>${val}</strong>
    </div>
  `;
}

// ── Chat panel ────────────────────────────────────────────────────────────────

function renderChatPanel(selectedSession, runningCount) {
  const activeRuns = selectedSession?.runs ?? [];
  const isRunning  = selectedSession?.status === "running";

  return `
    <div class="chatPanel">
      <div class="composer">
        <div class="promptCol">
          ${state.fileContexts.length > 0 ? `
            <div class="contextChips">
              ${state.fileContexts.map((f) => `
                <span class="contextChip">
                  ${icon("file")} ${esc(f.name)}
                  <button data-action="remove-file" data-id="${f.id}" title="Remove">×</button>
                </span>
              `).join("")}
            </div>
          ` : ""}
          <label class="fieldLabel" for="prompt">Prompt</label>
          <textarea id="prompt" rows="5" placeholder="Dispatch a mission to the crew…">${esc(state.prompt)}</textarea>
          <div class="promptActions">
            <div class="starterRow">
              ${STARTER_PROMPTS.map((s, i) => `
                <button class="ghostBtn" data-action="starter" data-value="${i}">${esc(s.slice(0, 40))}…</button>
              `).join("")}
            </div>
            <button class="btn btn-primary" data-action="run"
              ${state.submitting || !state.prompt.trim() || !state.selectedAgentIds.length ? "disabled" : ""}>
              ${icon(state.submitting ? "loader" : "send")}
              <span>${state.submitting ? "Running…" : "Run"}</span>
            </button>
          </div>
        </div>

        <div class="agentPickerCol">
          <div class="pickerHeader">
            <span class="fieldLabel">Agents</span>
            <button class="btn btn-icon" data-action="select-all-agents" title="All">${icon("check-all")}</button>
          </div>
          ${state.agents.map((a) => {
            const sel = state.selectedAgentIds.includes(a.id);
            return `
              <button class="agentPickCard ${sel ? "selected" : ""}" data-action="toggle-agent" data-id="${a.id}">
                <span class="agentAccent" style="background:${esc(a.accent)}"></span>
                <span>
                  <strong>${esc(a.name)}</strong>
                  <small>${esc(a.provider)}</small>
                </span>
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:${sel ? "var(--red)" : "var(--border-mid)"};stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;">
                  <path d="m20 6-11 11-5-5"/>
                </svg>
              </button>
            `;
          }).join("")}
        </div>
      </div>

      <div class="runArea">
        <div class="runHeader">
          <h3>${esc(selectedSession?.status ?? "idle")}</h3>
          ${isRunning
            ? `<button class="btn btn-danger" data-action="abort" data-id="${selectedSession.id}">${icon("square")} Stop</button>`
            : `<button class="btn btn-secondary" data-action="refresh">${icon("refresh")} Refresh</button>`
          }
        </div>
        <div class="runGrid">
          ${activeRuns.length > 0
            ? activeRuns.map(renderRunCard).join("")
            : `<div class="emptyState">${icon("terminal")}<span>No sessions yet — run a mission</span></div>`}
        </div>
      </div>
    </div>
  `;
}

function renderRunCard(run) {
  const agent = state.agents.find((a) => a.id === run.agentId);
  const output = run.output || run.error || "Queued…";
  return `
    <article class="runCard ${run.status}" style="--accent:${esc(agent?.accent ?? "#555")}">
      <header>
        <div>
          <h4>${esc(run.agentName)}</h4>
          <p>${esc(run.provider)} / ${esc(run.model)}</p>
        </div>
        ${renderStatusBadge(run.status)}
      </header>
      <pre>${esc(output)}</pre>
      ${run.error ? `<div class="errorLine">${icon("alert")} ${esc(run.error)}</div>` : ""}
    </article>
  `;
}

function renderStatusBadge(status) {
  const icons = { running: "loader", completed: "check", failed: "x", cancelled: "clock", queued: "clock" };
  return `
    <span class="statusBadge ${status}">
      ${icon(icons[status] ?? "clock")} ${status}
    </span>
  `;
}

// ── tmux panel ────────────────────────────────────────────────────────────────

function renderTmuxPanel() {
  const sessions = state.tmuxSessions;
  const selected = state.selectedTmuxSession;
  const selectedInfo = sessions.find((s) => s.name === selected);

  return `
    <div class="tmuxPanel">
      <div class="tmuxSessionList">
        <div class="tmuxSessionListHeader">
          <span>Sessions</span>
          <div style="display:flex;gap:5px;">
            <button class="btn btn-icon" data-action="load-tmux" title="Refresh">${icon("refresh")}</button>
            <button class="btn btn-icon" data-action="new-tmux" title="New session">${icon("plus")}</button>
          </div>
        </div>
        <div class="tmuxSessions">
          ${sessions.length === 0
            ? `<p style="color:var(--text-muted);font-size:0.7rem;padding:8px;">No tmux sessions<br>Click + to create one</p>`
            : sessions.map((s) => `
              <button class="tmuxSessionItem ${s.name === selected ? "active" : ""}"
                data-action="select-tmux" data-id="${esc(s.name)}">
                <strong>${esc(s.name)}</strong>
                <small>${s.windows} window${s.windows !== 1 ? "s" : ""} ${s.attached ? "· attached" : ""}</small>
                <button class="killBtn" data-action="kill-tmux" data-id="${esc(s.name)}">kill</button>
              </button>
            `).join("")}
        </div>
      </div>

      <div class="tmuxMain">
        ${selected ? `
          <div class="tmuxOutputHeader">
            <span class="tmuxSessionLabel">${esc(selected)}</span>
            <span class="tmuxStreamBadge ${state.tmuxStreaming ? "live" : "polling"}">
              ${state.tmuxStreaming ? "● LIVE" : "⟳ polling"}
            </span>
          </div>
          <div class="tmuxOutput" id="tmux-output">${esc(state.tmuxOutput)}<span class="tmuxCursor"></span></div>
          <div class="tmuxInputBar">
            <span class="tmuxPromptPrefix">$</span>
            <textarea class="tmuxInput" id="tmux-command"
              rows="1" placeholder="Enter command… (Enter to send)">${esc(state.tmuxCommand)}</textarea>
            <button class="btn btn-secondary" data-action="send-tmux">Send</button>
            <button class="btn btn-ghost" data-action="ai-suggest-tmux" title="Ask AI to suggest next command">AI ▸</button>
          </div>
        ` : `
          <div class="tmuxNoSession">
            ${icon("terminal")} Select or create a session
          </div>
        `}
      </div>
    </div>
  `;
}

// ── Email panel ───────────────────────────────────────────────────────────────

function renderEmailPanel() {
  return `
    <div class="emailPanel">
      <div class="emailCol">
        <div class="emailField">
          <label class="fieldLabel">To</label>
          <input type="email" id="email-to" placeholder="recipient@example.com" value="${esc(state.emailTo)}" />
        </div>
        <div class="emailField">
          <label class="fieldLabel">Subject</label>
          <input type="text" id="email-subject" placeholder="Re: …" value="${esc(state.emailSubject)}" />
        </div>
        <div class="emailField">
          <label class="fieldLabel">Tone</label>
          <div class="toneSelect">
            ${["professional","casual","concise"].map((t) => `
              <button class="tonePill ${state.emailTone === t ? "active" : ""}"
                data-action="set-tone" data-value="${t}">${t}</button>
            `).join("")}
          </div>
        </div>
        <div class="emailField" style="flex:1;">
          <label class="fieldLabel">Context / Thread</label>
          <textarea id="email-context" style="flex:1;min-height:180px;" placeholder="Paste the email thread or describe what to reply to…">${esc(state.emailContext)}</textarea>
        </div>
        <button class="btn btn-primary" data-action="draft-email"
          ${state.emailDrafting || !state.emailContext.trim() ? "disabled" : ""}>
          ${icon(state.emailDrafting ? "loader" : "zap")}
          ${state.emailDrafting ? "Drafting…" : "Draft with AI"}
        </button>
      </div>

      <div class="emailCol">
        <div class="emailField" style="flex:1;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <label class="fieldLabel">Draft</label>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-ghost" data-action="copy-draft" ${!state.emailDraft ? "disabled" : ""}>${icon("copy")} Copy</button>
              <button class="btn btn-ghost" data-action="clear-email">${icon("trash")} Clear</button>
            </div>
          </div>
          <div class="emailDraftArea" style="flex:1;">
            <textarea id="email-draft" style="min-height:320px;"
              placeholder="AI draft will appear here…">${esc(state.emailDraft)}</textarea>
            ${state.emailDrafting ? `
              <div class="draftingOverlay">
                ${icon("loader")} Drafting with Claude…
              </div>
            ` : ""}
          </div>
        </div>
        <div class="filesNote">
          ℹ Sending is not yet wired to Gmail. Copy the draft above into your mail client, or set up the Gmail connector with OAuth credentials.
        </div>
      </div>
    </div>
  `;
}

// ── Files panel ───────────────────────────────────────────────────────────────

function renderFilesPanel() {
  return `
    <div class="filesPanel">
      <div>
        <div class="fieldLabel" style="margin-bottom:10px;">Local Context — injected into every agent session</div>
        <div class="dropZone" data-dropzone="true">
          ${icon("upload")}
          <p>Drop files here</p>
          <small>or switch to the Files tab and paste text (Cmd+V)</small>
        </div>
      </div>

      ${state.fileContexts.length > 0 ? `
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <span class="fieldLabel">Attached (${state.fileContexts.length})</span>
            <button class="btn btn-ghost" data-action="clear-files">${icon("trash")} Clear all</button>
          </div>
          <div class="fileList">
            ${state.fileContexts.map((f) => `
              <div class="fileCard">
                <div>
                  <strong>${esc(f.name)}</strong>
                  <small>${formatBytes(f.size)} · ${f.content.split("\n").length} lines</small>
                </div>
                <button class="btn btn-ghost" data-action="remove-file" data-id="${f.id}">${icon("x")}</button>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}

      <div class="filesNote">
        Files are kept in browser memory only — nothing is uploaded to the server. Content is prepended to the agent prompt when you hit Run.
      </div>
    </div>
  `;
}

// ── Event rail ────────────────────────────────────────────────────────────────

function renderEventRail() {
  return `
    <aside class="eventRail">
      <div class="railHeader">
        ${icon("activity")}
        <span>Signal Stream</span>
        <span class="railLiveDot"></span>
      </div>
      <div class="eventList">
        ${state.events.slice().reverse().slice(0, 60).map((e) => `
          <div class="eventItem ${e.level}">
            <small>${new Date(e.createdAt).toLocaleTimeString()}</small>
            <span>${esc(e.message)}</span>
          </div>
        `).join("") || `<p style="color:var(--text-muted);font-size:0.7rem;padding:8px;">No events yet</p>`}
      </div>
    </aside>
  `;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function toggle(arr, id) {
  return arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
}

function upsert(sessions, session) {
  const exists = sessions.some((s) => s.id === session.id);
  const next = exists
    ? sessions.map((s) => (s.id === session.id ? session : s))
    : [session, ...sessions];
  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function applyDelta(sessions, { sessionId, runId, delta }) {
  return sessions.map((s) =>
    s.id !== sessionId ? s : {
      ...s,
      runs: s.runs.map((r) => r.id !== runId ? r : { ...r, output: r.output + delta })
    }
  );
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function esc(val) {
  return String(val ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ── Icon library (SVG) ───────────────────────────────────────────────────────

function icon(name) {
  const size = 'width="14" height="14"';
  const base = `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

  const paths = {
    activity:   '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    alert:      '<path d="m21 16-8.5-14.5a1 1 0 0 0-1.8 0L2 16a1 1 0 0 0 .9 1.5h18.2A1 1 0 0 0 21 16Z"/><path d="M12 7v4"/><path d="M12 15h.01"/>',
    calendar:   '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    check:      '<path d="m20 6-11 11-5-5"/>',
    "check-all":'<path d="m17 5-9.5 9.5-4-4"/><path d="m21 9-9.5 9.5"/>',
    circle:     '<circle cx="12" cy="12" r="8"/>',
    clock:      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    copy:       '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    cpu:        '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 15h3"/><path d="M1 9h3"/><path d="M1 15h3"/>',
    file:       '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/>',
    inbox:      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
    layers:     '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    loader:     '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    message:    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    plus:       '<path d="M12 5v14"/><path d="M5 12h14"/>',
    plug:       '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M6 8h12v3a6 6 0 0 1-12 0Z"/>',
    radio:      '<circle cx="12" cy="12" r="2"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M7.76 7.76a6 6 0 0 0 0 8.49"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/>',
    refresh:    '<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.4 5.6L21 8"/><path d="M21 3v5h-5"/>',
    send:       '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    square:     '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    terminal:   '<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>',
    trash:      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    upload:     '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    x:          '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    zap:        '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  };

  const extra = name === "loader" ? ' class="spin"' : "";
  return `<svg ${size} viewBox="0 0 24 24" ${base} aria-hidden="true"${extra}>${paths[name] ?? paths.circle}</svg>`;
}
