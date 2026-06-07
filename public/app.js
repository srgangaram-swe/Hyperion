// HYPERION Agentic Harness — Frontend

// Matrix rain
(function initMatrixRain() {
  const canvas = document.getElementById("matrix-rain");
  const ctx = canvas.getContext("2d");
  const CHARS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモラリルレロ0123456789ABCDEF<>{}[]|/\\";
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
      if (drops[i] > 0) { ctx.fillStyle = "rgba(255, 60, 60, 0.9)"; ctx.fillText(char, i * FONT_SIZE, y); }
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

// State
const STARTER_PROMPTS = [
  "Analyse the Hyperion codebase and propose 3 specific improvements to the orchestrator's tool-use loop.",
  "Build a unit test suite for server/orchestrator.ts using Deno's built-in test runner.",
  "Add a dark-mode toggle to Hyperion's UI — read styles.css, propose changes, and write them.",
];

const state = {
  agents: [], providers: [], connectors: [],
  selectedAgentIds: [],
  sessions: [], events: [], selectedSessionId: null,
  prompt: STARTER_PROMPTS[0],
  submitting: false,
  activeTool: "chat",

  // tmux
  tmuxSessions: [], selectedTmuxSession: null, tmuxOutput: "", tmuxCommand: "", tmuxStreaming: false,

  // files
  fileContexts: [],

  // email
  emailTo: "", emailSubject: "", emailContext: "", emailDraft: "", emailDrafting: false, emailTone: "professional",

  // agents panel
  agentFormOpen: false, agentFormId: null,
  agentForm: { name: "", provider: "anthropic", model: "claude-sonnet-4-6", description: "", accent: "#cc1111", systemPrompt: "", tools: [] },

  // code panel
  codeFile: null, codeContent: "", codeExpanded: {}, codeDirContents: {}, codeSaved: true, codeDiff: null,
  runDiffMode: {},

  // SSH panel
  sshConnections: [],
  sshFormOpen: false,
  sshForm: { label: "", host: "", user: "", port: 22, keyPath: "", description: "" },
  sshSelectedId: null,
  sshOutput: "",
  sshCommand: "",
  sshRunning: false,

  // Autopilot panel
  autopilotSessions: [],
  autopilotGoal: "",
  autopilotRunning: false,
  autopilotSelectedId: null,
  autopilotPausedRunId: null,
  autopilotModifyTask: "",
  autopilotRunCollapsed: {},

  // Workspace
  workspace: { rootDir: ".", tmuxSession: null },
};

let tmuxPollTimer = null;
let tmuxStreamSocket = null;

// Monaco setup
const monacoContainer = document.createElement("div");
monacoContainer.style.cssText = "width:100%;height:100%;";
let monacoEditor = null;
let monacoReady = false;
let monacoInitStarted = false;

function initMonaco() {
  if (monacoInitStarted) return;
  monacoInitStarted = true;
  window.require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs" } });
  window.require(["vs/editor/editor.main"], () => {
    window.monaco.editor.defineTheme("hyperion", {
      base: "vs-dark", inherit: true,
      rules: [
        { token: "comment", foreground: "555555", fontStyle: "italic" },
        { token: "keyword", foreground: "cc2222", fontWeight: "bold" },
        { token: "string", foreground: "bb4444" },
        { token: "number", foreground: "ff6666" },
      ],
      colors: {
        "editor.background": "#080808", "editor.foreground": "#e8e8e8",
        "editorLineNumber.foreground": "#333333", "editorCursor.foreground": "#cc1111",
        "editor.selectionBackground": "#cc111133", "editor.lineHighlightBackground": "#111111",
        "scrollbarSlider.background": "#330808", "scrollbarSlider.hoverBackground": "#550a0a",
        "editorWidget.background": "#0c0c0c", "input.background": "#090909",
      }
    });
    monacoReady = true;
    if (state.activeTool === "code") mountMonaco();
  });
}

function mountMonaco() {
  const slot = document.getElementById("monaco-slot");
  if (!slot) return;
  if (!monacoReady) {
    initMonaco();
    slot.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.76rem;letter-spacing:0.1em;text-transform:uppercase;">Loading editor…</div>`;
    return;
  }
  slot.innerHTML = "";
  slot.appendChild(monacoContainer);
  if (!monacoEditor) {
    monacoEditor = window.monaco.editor.create(monacoContainer, {
      value: state.codeContent || "// Select a file from the tree",
      language: inferLanguage(state.codeFile),
      theme: "hyperion", fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      minimap: { enabled: false }, scrollBeyondLastLine: false,
      lineNumbers: "on", wordWrap: "off", renderWhitespace: "none",
      padding: { top: 12, bottom: 12 }, smoothScrolling: true,
    });
    monacoEditor.onDidChangeModelContent(() => {
      state.codeContent = monacoEditor.getValue();
      if (state.codeFile && state.codeSaved) {
        state.codeSaved = false;
        const btn = document.getElementById("code-save-btn");
        if (btn) btn.innerHTML = `${icon("circle")} Save`;
      }
    });
  } else {
    monacoEditor.layout();
  }
}

// Bootstrap
const app = document.querySelector("#app");
await loadInitialData();
connectSocket();
connectAutopilotSocket();
render();
setTimeout(initMonaco, 1500);

// Event delegation
app.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  handleAction(t.dataset.action, t.dataset.id ?? t.dataset.value ?? "", t, e);
});

app.addEventListener("input", (e) => {
  const id = e.target.id;
  if (id === "prompt")               { state.prompt = e.target.value; return; }
  if (id === "tmux-command")         { state.tmuxCommand = e.target.value; return; }
  if (id === "email-to")             { state.emailTo = e.target.value; return; }
  if (id === "email-subject")        { state.emailSubject = e.target.value; return; }
  if (id === "email-context")        { state.emailContext = e.target.value; return; }
  if (id === "email-draft")          { state.emailDraft = e.target.value; return; }
  if (id === "agent-name")           { state.agentForm.name = e.target.value; return; }
  if (id === "agent-model")          { state.agentForm.model = e.target.value; return; }
  if (id === "agent-description")    { state.agentForm.description = e.target.value; return; }
  if (id === "agent-system-prompt")  { state.agentForm.systemPrompt = e.target.value; return; }
  if (id === "agent-accent") {
    state.agentForm.accent = e.target.value;
    const t = document.getElementById("agent-accent-text");
    if (t) t.value = e.target.value;
    return;
  }
  if (id === "agent-accent-text") {
    state.agentForm.accent = e.target.value;
    const c = document.getElementById("agent-accent");
    if (c && /^#[0-9a-fA-F]{6}$/.test(e.target.value)) c.value = e.target.value;
    return;
  }
  if (id === "ssh-label")       { state.sshForm.label = e.target.value; return; }
  if (id === "ssh-host")        { state.sshForm.host = e.target.value; return; }
  if (id === "ssh-user")        { state.sshForm.user = e.target.value; return; }
  if (id === "ssh-port")        { state.sshForm.port = Number(e.target.value); return; }
  if (id === "ssh-key")         { state.sshForm.keyPath = e.target.value; return; }
  if (id === "ssh-description") { state.sshForm.description = e.target.value; return; }
  if (id === "ssh-command")     { state.sshCommand = e.target.value; return; }
  if (id === "autopilot-goal")  { state.autopilotGoal = e.target.value; return; }
  if (id === "autopilot-modify-task") { state.autopilotModifyTask = e.target.value; return; }
  if (id === "workspace-dir")   { state.workspace.rootDir = e.target.value; return; }
});

app.addEventListener("change", (e) => {
  if (e.target.id === "agent-provider") {
    state.agentForm.provider = e.target.value;
    state.agentForm.model = defaultModel(e.target.value);
    render();
  }
  if (e.target.id === "workspace-tmux") {
    state.workspace.tmuxSession = e.target.value || null;
    return;
  }
});

app.addEventListener("keydown", (e) => {
  if (e.target.id === "tmux-command" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTmuxCommand(); }
  if (e.target.id === "prompt" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); createSession(); }
  if (e.target.id === "ssh-command" && e.key === "Enter") { e.preventDefault(); runSshCommandUI(); }
  if (e.target.id === "autopilot-goal" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); launchAutopilot(); }
});

app.addEventListener("dragover", (e) => {
  if (e.target.closest("[data-dropzone]")) { e.preventDefault(); e.target.closest("[data-dropzone]").classList.add("drag-over"); }
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
    const content = await file.text().catch(() => "[binary]");
    state.fileContexts = [...state.fileContexts, { id: crypto.randomUUID(), name: file.name, content, size: file.size }];
  }
  render();
});
document.addEventListener("paste", async (e) => {
  if (state.activeTool !== "files") return;
  const text = e.clipboardData?.getData("text");
  if (text && text.length > 80) {
    state.fileContexts = [...state.fileContexts, { id: crypto.randomUUID(), name: "pasted.txt", content: text, size: text.length }];
    render();
  }
});

// Action handler
function handleAction(action, value, el, e) {
  switch (action) {
    case "switch-tool":
      state.activeTool = value;
      if (value === "tmux") loadTmuxSessions();
      else stopTmuxStream();
      if (value === "code") { if (!state.codeDirContents["."]) loadFsDir("."); if (!monacoInitStarted) initMonaco(); }
      if (value === "ssh") loadSshConnections();
      if (value === "autopilot") loadAutopilotSessions();
      render();
      break;

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

    case "toggle-agent":
      state.selectedAgentIds = toggle(state.selectedAgentIds, value);
      render();
      break;

    case "select-all-agents":
      state.selectedAgentIds = state.agents.map((a) => a.id);
      render();
      break;

    case "load-tmux": loadTmuxSessions(); break;
    case "select-tmux": selectTmuxSession(value); break;
    case "new-tmux": createTmuxSession(); break;
    case "kill-tmux": e.stopPropagation(); killTmuxSession(value); break;
    case "send-tmux": sendTmuxCommand(); break;
    case "ai-suggest-tmux": suggestTmuxCommand(); break;

    case "remove-file":
      state.fileContexts = state.fileContexts.filter((f) => f.id !== value);
      render();
      break;
    case "clear-files":
      state.fileContexts = [];
      render();
      break;

    case "set-tone": state.emailTone = value; render(); break;
    case "draft-email": draftEmail(); break;
    case "clear-email": state.emailDraft = ""; state.emailContext = ""; render(); break;
    case "copy-draft": navigator.clipboard.writeText(state.emailDraft).catch(() => {}); break;

    case "open-agent-form":
      state.agentFormOpen = true;
      state.agentFormId = null;
      state.agentForm = { name: "", provider: "anthropic", model: "claude-sonnet-4-6", description: "", accent: "#cc1111", systemPrompt: "", tools: [] };
      render();
      break;

    case "edit-agent": {
      const ag = state.agents.find((a) => a.id === value);
      if (ag && ag.id.startsWith("custom-")) {
        state.agentFormOpen = true;
        state.agentFormId = value;
        state.agentForm = { name: ag.name, provider: ag.provider, model: ag.model, description: ag.description || "", accent: ag.accent || "#cc1111", systemPrompt: ag.systemPrompt || "", tools: ag.tools || [] };
        render();
      }
      break;
    }

    case "delete-agent": {
      const ag = state.agents.find((a) => a.id === value);
      if (ag && window.confirm(`Delete agent "${ag.name}"?`)) deleteAgent(value);
      break;
    }

    case "cancel-agent-form":
      state.agentFormOpen = false;
      state.agentFormId = null;
      render();
      break;

    case "save-agent":
      saveAgent();
      break;

    case "load-fs-dir": loadFsDir(value || "."); break;
    case "toggle-fs-dir":
      state.codeExpanded[value] = !state.codeExpanded[value];
      if (state.codeExpanded[value] && !state.codeDirContents[value]) loadFsDir(value);
      else render();
      break;
    case "open-fs-file": openFsFile(value); break;
    case "save-fs-file": saveFsFile(); break;
    case "code-to-chat": codeToChat(); break;
    case "toggle-run-diff":
      state.runDiffMode[value] = state.runDiffMode[value] === false ? undefined : false;
      render();
      break;
    case "show-git-diff": fetchGitDiff(); break;
    case "hide-git-diff": state.codeDiff = null; render(); requestAnimationFrame(mountMonaco); break;

    // SSH
    case "open-ssh-form":
      state.sshFormOpen = true;
      state.sshForm = { label: "", host: "", user: "", port: 22, keyPath: "", description: "" };
      render();
      break;
    case "cancel-ssh-form":
      state.sshFormOpen = false;
      render();
      break;
    case "save-ssh":
      saveSshConnection();
      break;
    case "delete-ssh":
      if (window.confirm(`Delete SSH connection?`)) deleteSshConnection(value);
      break;
    case "test-ssh":
      testSsh(value);
      break;
    case "select-ssh":
      state.sshSelectedId = value;
      state.sshOutput = "";
      render();
      break;
    case "run-ssh":
      runSshCommandUI();
      break;
    case "ssh-in-tmux":
      openSshInTmuxUI(value);
      break;

    // Autopilot
    case "launch-autopilot":
      launchAutopilot();
      break;
    case "abort-autopilot":
      abortAutopilot(value);
      break;
    case "select-autopilot":
      state.autopilotSelectedId = value;
      render();
      break;
    case "delete-autopilot":
      e.stopPropagation();
      deleteAutopilotSession(value);
      break;
    case "clear-autopilot-done":
      clearDoneAutopilotSessions();
      break;
    case "toggle-run-collapse":
      state.autopilotRunCollapsed[value] = !state.autopilotRunCollapsed[value];
      render();
      break;
    case "pause-run":
      pauseAutopilotRun(value);
      break;
    case "resume-run":
      resumeAutopilotRun(value);
      break;
    case "cancel-modify":
      state.autopilotPausedRunId = null;
      state.autopilotModifyTask = "";
      render();
      break;

    // Workspace
    case "save-workspace":
      saveWorkspace();
      break;
    case "use-cwd":
      state.workspace.rootDir = ".";
      saveWorkspace();
      break;
  }
}

// API helpers
async function loadInitialData() {
  const [agRes, connRes, sessRes, evRes, wsRes, sshRes, apRes] = await Promise.all([
    fetch("/api/agents"),
    fetch("/api/connectors"),
    fetch("/api/sessions"),
    fetch("/api/events"),
    fetch("/api/workspace"),
    fetch("/api/ssh"),
    fetch("/api/orchestrate"),
  ]);
  const agData   = await agRes.json();
  const connData = await connRes.json();
  const sessData = await sessRes.json();
  const evData   = await evRes.json();
  const wsData   = await wsRes.json();
  const sshData  = await sshRes.json();
  const apData   = await apRes.json();

  state.agents        = agData.agents;
  state.providers     = agData.providers;
  state.connectors    = connData.connectors;
  state.sessions      = sessData.sessions;
  state.events        = evData.events;
  state.workspace     = wsData.workspace ?? state.workspace;
  state.sshConnections = sshData.connections ?? [];
  state.autopilotSessions = apData.sessions ?? [];

  if (state.selectedAgentIds.length === 0) state.selectedAgentIds = state.agents.map((a) => a.id);
  state.selectedSessionId ??= state.sessions[0]?.id ?? null;
  render();
}

async function createSession() {
  if (!state.prompt.trim() || !state.selectedAgentIds.length || state.submitting) return;
  state.submitting = true;
  render();

  let fullPrompt = state.prompt;
  if (state.fileContexts.length > 0) {
    const ctx = state.fileContexts.map((f) => `--- File: ${f.name} ---\n${f.content}`).join("\n\n");
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

// tmux
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
  ws.addEventListener("open", () => { state.tmuxStreaming = true; render(); });
  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "output" && msg.payload?.data !== undefined) {
        state.tmuxOutput = msg.payload.data;
        render();
        const pane = document.querySelector(".tmuxOutput");
        if (pane) pane.scrollTop = pane.scrollHeight;
      }
    } catch { /* skip */ }
  });
  ws.addEventListener("close", () => {
    tmuxStreamSocket = null;
    state.tmuxStreaming = false;
    if (state.selectedTmuxSession === name) startTmuxPoll(name);
  });
  ws.addEventListener("error", () => { ws.close(); });
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
  await fetch("/api/tmux/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  await loadTmuxSessions();
  selectTmuxSession(name);
}

async function killTmuxSession(name) {
  if (state.selectedTmuxSession === name) { state.selectedTmuxSession = null; state.tmuxOutput = ""; stopTmuxStream(); }
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
  if (!state.tmuxStreaming) setTimeout(() => fetchTmuxOutput(session), 400);
}

async function suggestTmuxCommand() {
  const session = state.selectedTmuxSession;
  if (!session || !state.tmuxOutput) return;
  const truncated = state.tmuxOutput.slice(-2000);
  const prompt = `Based on this terminal output, suggest the single most useful next command:\n\`\`\`\n${truncated}\n\`\`\`\nReply with ONLY the command.`;
  const agent = state.agents.find((a) => a.provider === "anthropic") || state.agents[0];
  if (!agent) return;
  const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, agentIds: [agent.id], title: `AI suggest [${session}]` }) });
  const data = await res.json();
  if (res.ok) state.selectedSessionId = data.session.id;
  state.activeTool = "chat";
  render();
}

// Email
async function draftEmail() {
  if (state.emailDrafting) return;
  state.emailDrafting = true;
  state.emailDraft = "";
  render();
  try {
    const res = await fetch("/api/draft-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: state.emailContext, to: state.emailTo, subject: state.emailSubject, tone: state.emailTone })
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
        try { const p = JSON.parse(raw); if (p.delta) { state.emailDraft += p.delta; render(); } } catch { /* skip */ }
      }
    }
  } catch (err) {
    state.emailDraft = `[Error: ${err instanceof Error ? err.message : String(err)}]`;
  } finally {
    state.emailDrafting = false;
    render();
  }
}

// Agent CRUD
async function saveAgent() {
  const f = state.agentForm;
  if (!f.name.trim() || !f.systemPrompt.trim()) return;
  if (state.agentFormId) {
    await fetch(`/api/agents/${state.agentFormId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
  } else {
    await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
  }
  state.agentFormOpen = false;
  state.agentFormId = null;
  await loadInitialData();
}

async function deleteAgent(id) {
  await fetch(`/api/agents/${id}`, { method: "DELETE" });
  state.selectedAgentIds = state.selectedAgentIds.filter((x) => x !== id);
  await loadInitialData();
}

// Filesystem
async function loadFsDir(path) {
  const res = await fetch(`/api/fs?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  if (data.entries) state.codeDirContents[path] = data.entries;
  render();
}

async function openFsFile(path) {
  const res = await fetch(`/api/fs?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  if (data.content !== undefined) {
    state.codeFile = path;
    state.codeContent = data.content;
    state.codeSaved = true;
    if (monacoEditor) {
      window.monaco.editor.setModelLanguage(monacoEditor.getModel(), inferLanguage(path));
      monacoEditor.setValue(data.content);
    }
  }
  render();
}

async function saveFsFile() {
  if (!state.codeFile) return;
  const content = monacoEditor ? monacoEditor.getValue() : state.codeContent;
  await fetch("/api/fs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: state.codeFile, content }) });
  state.codeSaved = true;
  render();
}

function codeToChat() {
  let text = "";
  if (monacoEditor) {
    const sel = monacoEditor.getSelection();
    text = monacoEditor.getModel().getValueInRange(sel);
    if (!text.trim()) text = monacoEditor.getValue();
  } else {
    text = state.codeContent;
  }
  if (!text.trim()) return;
  const fileName = state.codeFile?.split("/").pop() || "snippet.txt";
  state.fileContexts = [...state.fileContexts, { id: crypto.randomUUID(), name: fileName, content: text, size: text.length }];
  state.activeTool = "chat";
  render();
}

async function fetchGitDiff() {
  if (!state.codeFile) return;
  const res = await fetch(`/api/git/diff?path=${encodeURIComponent(state.codeFile)}`);
  const data = await res.json();
  state.codeDiff = data.diff || "(no changes — file matches HEAD)";
  render();
}

// SSH
async function loadSshConnections() {
  const res = await fetch("/api/ssh");
  const data = await res.json();
  state.sshConnections = data.connections ?? [];
  render();
}

async function saveSshConnection() {
  const f = state.sshForm;
  if (!f.label || !f.host || !f.user) return;
  const res = await fetch("/api/ssh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
  if (res.ok) {
    state.sshFormOpen = false;
    await loadSshConnections();
  }
}

async function deleteSshConnection(id) {
  await fetch(`/api/ssh/${id}`, { method: "DELETE" });
  if (state.sshSelectedId === id) { state.sshSelectedId = null; state.sshOutput = ""; }
  await loadSshConnections();
}

async function testSsh(id) {
  const res = await fetch(`/api/ssh/${id}/test`, { method: "POST" });
  const data = await res.json();
  state.sshOutput = data.ok ? `OK\n${data.stdout}` : `FAILED\n${data.stderr}`;
  render();
}

async function runSshCommandUI() {
  const id = state.sshSelectedId;
  const cmd = state.sshCommand.trim();
  if (!id || !cmd || state.sshRunning) return;
  state.sshRunning = true;
  state.sshOutput = "";
  render();
  try {
    const res = await fetch(`/api/ssh/${id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) });
    const data = await res.json();
    state.sshOutput = data.stdout || data.stderr || (data.ok ? "(no output)" : "failed");
  } finally {
    state.sshRunning = false;
    render();
  }
}

async function openSshInTmuxUI(connId) {
  const tmuxSess = state.workspace.tmuxSession || state.tmuxSessions[0]?.name;
  if (!tmuxSess) { alert("No tmux session selected. Create one in the tmux panel first."); return; }
  const res = await fetch(`/api/ssh/${connId}/tmux`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tmuxSession: tmuxSess }) });
  const data = await res.json();
  if (data.ok) { state.activeTool = "tmux"; selectTmuxSession(tmuxSess); render(); }
  else alert(`SSH open failed: ${data.err}`);
}

// Autopilot (Orchestrator)
async function loadAutopilotSessions() {
  const res = await fetch("/api/orchestrate");
  const data = await res.json();
  state.autopilotSessions = data.sessions ?? [];
  if (!state.autopilotSelectedId && state.autopilotSessions[0]) state.autopilotSelectedId = state.autopilotSessions[0].id;
  render();
}

async function launchAutopilot() {
  const goal = state.autopilotGoal.trim();
  if (!goal || state.autopilotRunning) return;
  state.autopilotRunning = true;
  render();

  try {
    const res = await fetch("/api/orchestrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, workDir: state.workspace.rootDir, tmuxSession: state.workspace.tmuxSession })
    });
    const data = await res.json();
    if (res.ok) {
      state.autopilotSessions = [data.session, ...state.autopilotSessions];
      state.autopilotSelectedId = data.session.id;
      state.autopilotGoal = "";
    }
  } finally {
    state.autopilotRunning = false;
    render();
  }
}

async function abortAutopilot(id) {
  await fetch(`/api/orchestrate/${id}/abort`, { method: "POST" });
  await loadAutopilotSessions();
}

async function deleteAutopilotSession(id) {
  await fetch(`/api/orchestrate/${id}`, { method: "DELETE" });
  state.autopilotSessions = state.autopilotSessions.filter((s) => s.id !== id);
  if (state.autopilotSelectedId === id) {
    state.autopilotSelectedId = state.autopilotSessions[0]?.id ?? null;
  }
  render();
}

function clearDoneAutopilotSessions() {
  const done = state.autopilotSessions.filter((s) => s.status !== "running" && s.status !== "planning");
  done.forEach((s) => fetch(`/api/orchestrate/${s.id}`, { method: "DELETE" }).catch(() => {}));
  state.autopilotSessions = state.autopilotSessions.filter((s) => s.status === "running" || s.status === "planning");
  if (!state.autopilotSessions.find((s) => s.id === state.autopilotSelectedId)) {
    state.autopilotSelectedId = state.autopilotSessions[0]?.id ?? null;
  }
  render();
}

async function pauseAutopilotRun(runId) {
  const sess = state.autopilotSessions.find((s) => s.id === state.autopilotSelectedId);
  if (!sess) return;
  await fetch(`/api/orchestrate/${sess.id}/pause/${runId}`, { method: "POST" });
  state.autopilotPausedRunId = runId;
  const run = sess.runs?.find((r) => r.id === runId);
  state.autopilotModifyTask = run?.task ?? "";
  render();
}

async function resumeAutopilotRun(runId) {
  const sess = state.autopilotSessions.find((s) => s.id === state.autopilotSelectedId);
  if (!sess) return;
  const modifiedTask = state.autopilotModifyTask || undefined;
  await fetch(`/api/orchestrate/${sess.id}/resume/${runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modifiedTask })
  });
  state.autopilotPausedRunId = null;
  state.autopilotModifyTask = "";
  render();
}

// Workspace
async function saveWorkspace() {
  const res = await fetch("/api/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.workspace)
  });
  const data = await res.json();
  state.workspace = data.workspace ?? state.workspace;
  state.codeDirContents = {};
  if (state.activeTool === "code") loadFsDir(".");
  render();
}

// Diff utilities
function looksLikeDiff(text) {
  if (!text || text.length < 20) return false;
  if (/```diff\n/.test(text)) return true;
  return /^--- /m.test(text) && /^\+\+\+ /m.test(text) && /^@@ /m.test(text);
}

function extractDiff(text) {
  const fenced = text.match(/```(?:diff)?\n([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}

function renderDiff(text) {
  const lines = extractDiff(text).split("\n");
  const rows = lines.map((line) => {
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("old mode") || line.startsWith("new mode")) return `<div class="diff-meta">${esc(line)}</div>`;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) return `<div class="diff-file">${esc(line)}</div>`;
    if (line.startsWith("@@")) return `<div class="diff-hunk">${esc(line)}</div>`;
    if (line.startsWith("+")) return `<div class="diff-add">${esc(line)}</div>`;
    if (line.startsWith("-")) return `<div class="diff-del">${esc(line)}</div>`;
    return `<div class="diff-ctx">${esc(line)}</div>`;
  }).join("");
  return `<div class="diffView">${rows}</div>`;
}

// WebSocket — main
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

// WebSocket — autopilot events (shares main WS but handles orchestrator message types)
function connectAutopilotSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.type === "orchestrator:snapshot") {
      state.autopilotSessions = msg.payload;
      if (!state.autopilotSelectedId && state.autopilotSessions[0]) {
        state.autopilotSelectedId = state.autopilotSessions[0].id;
      }
      render();
    }
    if (msg.type === "orchestrator:event") {
      const { sessionId, event } = msg.payload;
      const sess = state.autopilotSessions.find((s) => s.id === sessionId);
      if (!sess) return;
      if (event.type === "agent_delta") {
        const run = sess.runs?.find((r) => r.id === event.runId);
        if (run) run.output = (run.output ?? "") + event.delta;
      }
      if (event.type === "plan") {
        sess.plan = event.plan;
        sess.planStatus = "running";
        sess.runs = event.plan.agents.map((a, i) => ({
          id: `plan-${i}`,
          index: i,
          role: a.role,
          task: a.task,
          provider: a.provider,
          model: a.model,
          tools: a.tools,
          status: "queued",
          output: "",
        }));
      }
      if (event.type === "agent_start") {
        const run = sess.runs?.find((r) => r.index === event.index);
        if (run) { run.id = event.runId; run.status = "running"; run.startedAt = new Date().toISOString(); }
      }
      if (event.type === "agent_done") {
        const run = sess.runs?.find((r) => r.id === event.runId);
        if (run) { run.status = "completed"; run.completedAt = new Date().toISOString(); }
      }
      if (event.type === "agent_error") {
        const run = sess.runs?.find((r) => r.id === event.runId);
        if (run) { run.status = "failed"; run.error = event.error; run.completedAt = new Date().toISOString(); }
      }
      if (event.type === "done") {
        sess.status = "completed";
        sess.planStatus = "done";
        state.autopilotRunning = false;
      }
      if (event.type === "paused") {
        state.autopilotPausedRunId = event.runId;
        const run = sess.runs?.find((r) => r.id === event.runId);
        state.autopilotModifyTask = run?.task ?? "";
      }
      render();
    }
  });
  ws.addEventListener("close", () => setTimeout(connectAutopilotSocket, 1500));
}

// Render
function render() {
  const selectedSession = state.sessions.find((s) => s.id === state.selectedSessionId) ?? state.sessions[0] ?? null;
  const runningCount = state.sessions.reduce((n, s) => n + s.runs.filter((r) => r.status === "running").length, 0);

  app.innerHTML = `
    <div class="appShell">
      ${renderSidebar(selectedSession, runningCount)}
      ${renderWorkspace(selectedSession, runningCount)}
      ${renderEventRail()}
    </div>
  `;

  if (state.activeTool === "code") requestAnimationFrame(mountMonaco);
}

// Sidebar
function renderSidebar(selectedSession, runningCount) {
  return `
    <aside class="sidebar">
      <div class="brandBlock">
        <div class="brandMark">${icon("zap")}</div>
        <div class="brandText">
          <h1>HYPERION</h1>
          <p>Agentic Harness · v2</p>
        </div>
        <div class="brandStatus">
          <span class="dot ${runningCount > 0 ? "running" : "ready"}" style="width:8px;height:8px;"></span>
        </div>
      </div>

      <div class="sidebarSection">
        <div class="secLabel">${icon("radio")} Providers</div>
        <div class="providerList">
          ${state.providers.map(renderProvider).join("")}
        </div>
      </div>

      <div class="sidebarSection">
        <div class="secLabel">${icon("folder")} Workspace</div>
        <div class="workspaceRow">
          <input id="workspace-dir" class="wsInput" type="text" value="${esc(state.workspace.rootDir)}"
            placeholder="/path/to/project" />
          <button class="btn btn-icon" data-action="save-workspace" title="Set workspace root">${icon("check")}</button>
        </div>
        ${state.tmuxSessions.length > 0 ? `
          <select id="workspace-tmux" class="wsSelect" style="margin-top:5px;">
            <option value="">No tmux session</option>
            ${state.tmuxSessions.map((s) => `<option value="${esc(s.name)}" ${s.name === state.workspace.tmuxSession ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>
        ` : ""}
      </div>

      <div class="sidebarSection">
        <div class="secLabel">${icon("layers")} Tools</div>
        <div class="toolNav">
          ${["chat","tmux","email","files","agents","code","ssh","autopilot"].map((t) => renderToolNavBtn(t)).join("")}
        </div>
      </div>

      <div class="sidebarSection">
        <div class="secLabel">
          ${icon("cpu")} Agents
          <button class="btn btn-icon" data-action="select-all-agents" title="Select all" style="width:20px;height:20px;margin-left:auto;">${icon("check-all")}</button>
        </div>
        <div class="agentList">
          ${state.agents.map(renderSidebarAgent).join("")}
        </div>
      </div>

      <div class="sidebarSection fill">
        <div class="secLabel">${icon("clock")} Sessions</div>
        <div class="sessionList">
          ${state.sessions.slice(0, 20).map((s) => `
            <button class="sessionBtn ${s.id === state.selectedSessionId ? "active" : ""}"
              data-action="select-session" data-id="${s.id}">
              <span>${esc(s.title)}</span>
              <small>
                <span class="dot ${s.status === "running" ? "running" : s.status === "completed" ? "ready" : "mock"}"
                  style="width:6px;height:6px;display:inline-block;margin-right:4px;"></span>
                ${s.runs.length} agents · ${s.status}
              </small>
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
  const labels = { chat:"Chat", tmux:"tmux", email:"Email", files:"Files", agents:"Agents", code:"Code", ssh:"SSH", autopilot:"Pilot" };
  const icons  = { chat:"message", tmux:"terminal", email:"inbox", files:"file", agents:"cpu", code:"code", ssh:"server", autopilot:"zap" };
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
  const isCustom = a.id.startsWith("custom-");
  return `
    <button class="agentBtn ${sel ? "selected" : ""}" data-action="toggle-agent" data-id="${a.id}"
      title="${esc(a.description || a.name)}">
      <span class="agentAccent" style="background:${esc(a.accent)}"></span>
      <span>
        <strong>${esc(a.name)}${isCustom ? ` <span style="font-size:0.55rem;color:var(--red);font-weight:700;">CUSTOM</span>` : ""}</strong>
        <small>${esc(a.provider)} · ${esc(a.model)}</small>
      </span>
      <svg class="checkIcon" viewBox="0 0 24 24"><path d="m20 6-11 11-5-5"/></svg>
    </button>
  `;
}

// Workspace (main panel)
function renderWorkspace(selectedSession, runningCount) {
  const toolPanels = {
    chat:      renderChatPanel(selectedSession, runningCount),
    tmux:      renderTmuxPanel(),
    email:     renderEmailPanel(),
    files:     renderFilesPanel(),
    agents:    renderAgentsPanel(),
    code:      renderCodePanel(),
    ssh:       renderSshPanel(),
    autopilot: renderAutopilotPanel(),
  };

  return `
    <main class="workspace">
      <div class="workspaceHeader">
        <span class="sessionTitle">${esc(selectedSession?.title ?? "NEW SESSION")}</span>
        <div class="headerMetrics">
          ${metricBox("Running", runningCount)}
          ${metricBox("Sessions", state.sessions.length)}
          ${metricBox("SSH", state.sshConnections.length)}
        </div>
      </div>

      <div class="toolTabBar">
        ${renderToolTab("chat",      "message",  "CHAT")}
        ${renderToolTab("tmux",      "terminal", "TMUX")}
        ${renderToolTab("email",     "inbox",    "EMAIL")}
        ${renderToolTab("files",     "file",     "FILES")}
        ${renderToolTab("agents",    "cpu",      "AGENTS")}
        ${renderToolTab("code",      "code",     "CODE")}
        ${renderToolTab("ssh",       "server",   "SSH")}
        ${renderToolTab("autopilot", "zap",      "AUTOPILOT")}
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
  return `<div class="metric"><small>${label}</small><strong>${val}</strong></div>`;
}

// Chat panel
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
                <span class="contextChip">${icon("file")} ${esc(f.name)}<button data-action="remove-file" data-id="${f.id}">×</button></span>
              `).join("")}
            </div>
          ` : ""}
          <label class="fieldLabel" for="prompt">Prompt <span style="color:var(--text-muted);font-weight:400;font-size:0.58rem;margin-left:6px;">⌘↵ to run</span></label>
          <textarea id="prompt" rows="5" placeholder="Dispatch a mission…">${esc(state.prompt)}</textarea>
          <div class="promptActions">
            <div class="starterRow">
              ${STARTER_PROMPTS.map((s, i) => `<button class="ghostBtn" data-action="starter" data-value="${i}">${esc(s.slice(0, 44))}…</button>`).join("")}
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
            <button class="btn btn-icon" data-action="select-all-agents">${icon("check-all")}</button>
          </div>
          ${state.agents.map((a) => {
            const sel = state.selectedAgentIds.includes(a.id);
            return `
              <button class="agentPickCard ${sel ? "selected" : ""}" data-action="toggle-agent" data-id="${a.id}"
                title="${esc(a.description || a.name)}">
                <span class="agentAccent" style="background:${esc(a.accent)}"></span>
                <span>
                  <strong>${esc(a.name)}</strong>
                  <small>${esc(a.provider)}</small>
                </span>
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:${sel ? "var(--red)" : "var(--border-mid)"};stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;"><path d="m20 6-11 11-5-5"/></svg>
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
  const rawOutput = run.output || run.error || "Queued…";
  const isDiff = run.status === "completed" && looksLikeDiff(run.output);
  const diffMode = isDiff && state.runDiffMode[run.id] !== false;

  return `
    <article class="runCard ${run.status}" style="--accent:${esc(agent?.accent ?? "#555")}">
      <header>
        <div>
          <h4>${esc(run.agentName)}</h4>
          <p>${esc(run.provider)} / ${esc(run.model)}</p>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          ${isDiff ? `
            <span class="diffBadge">DIFF</span>
            <button class="btn btn-ghost" style="font-size:0.62rem;padding:3px 8px;"
              data-action="toggle-run-diff" data-id="${run.id}">
              ${diffMode ? "Raw" : "Diff"}
            </button>
          ` : ""}
          ${renderStatusBadge(run.status)}
        </div>
      </header>
      ${diffMode ? renderDiff(run.output) : `<pre>${esc(rawOutput)}</pre>`}
      ${run.error ? `<div class="errorLine">${icon("alert")} ${esc(run.error)}</div>` : ""}
    </article>
  `;
}

function renderStatusBadge(status) {
  const icons = { running: "loader", completed: "check", failed: "x", cancelled: "clock", queued: "clock" };
  return `<span class="statusBadge ${status}">${icon(icons[status] ?? "clock")} ${status}</span>`;
}

// tmux panel
function renderTmuxPanel() {
  const sessions = state.tmuxSessions;
  const selected = state.selectedTmuxSession;
  return `
    <div class="tmuxPanel">
      <div class="tmuxSessionList">
        <div class="tmuxSessionListHeader">
          <span>Sessions</span>
          <div style="display:flex;gap:5px;">
            <button class="btn btn-icon" data-action="load-tmux">${icon("refresh")}</button>
            <button class="btn btn-icon" data-action="new-tmux">${icon("plus")}</button>
          </div>
        </div>
        <div class="tmuxSessions">
          ${sessions.length === 0
            ? `<p style="color:var(--text-muted);font-size:0.7rem;padding:8px;">No sessions — click + to create</p>`
            : sessions.map((s) => `
              <button class="tmuxSessionItem ${s.name === selected ? "active" : ""}"
                data-action="select-tmux" data-id="${esc(s.name)}">
                <strong>${esc(s.name)}</strong>
                <small>${s.windows}w ${s.attached ? "· ●" : ""}</small>
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
            <textarea class="tmuxInput" id="tmux-command" rows="1"
              placeholder="Command… (Enter to send)">${esc(state.tmuxCommand)}</textarea>
            <button class="btn btn-secondary" data-action="send-tmux">Send</button>
            <button class="btn btn-ghost" data-action="ai-suggest-tmux">AI ▸</button>
          </div>
        ` : `
          <div class="tmuxNoSession">${icon("terminal")} Select or create a session</div>
        `}
      </div>
    </div>
  `;
}

// Email panel
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
            ${["professional","casual","concise"].map((t) => `<button class="tonePill ${state.emailTone === t ? "active" : ""}" data-action="set-tone" data-value="${t}">${t}</button>`).join("")}
          </div>
        </div>
        <div class="emailField" style="flex:1;">
          <label class="fieldLabel">Context / Thread</label>
          <textarea id="email-context" style="flex:1;min-height:180px;" placeholder="Paste the thread or describe what to reply to…">${esc(state.emailContext)}</textarea>
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
            <textarea id="email-draft" style="min-height:320px;" placeholder="AI draft appears here…">${esc(state.emailDraft)}</textarea>
            ${state.emailDrafting ? `<div class="draftingOverlay">${icon("loader")} Drafting with Claude…</div>` : ""}
          </div>
        </div>
        <div class="filesNote">ℹ Copy the draft into your mail client. Gmail connector requires OAuth setup.</div>
      </div>
    </div>
  `;
}

// Files panel
function renderFilesPanel() {
  return `
    <div class="filesPanel">
      <div>
        <div class="fieldLabel" style="margin-bottom:10px;">Context — injected into every agent session</div>
        <div class="dropZone" data-dropzone="true">
          ${icon("upload")}<p>Drop files here</p>
          <small>or switch to Files tab and paste (Cmd+V)</small>
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
                <div><strong>${esc(f.name)}</strong><small>${formatBytes(f.size)} · ${f.content.split("\n").length} lines</small></div>
                <button class="btn btn-ghost" data-action="remove-file" data-id="${f.id}">${icon("x")}</button>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
      <div class="filesNote">Files stay in browser memory — nothing is uploaded to the server.</div>
    </div>
  `;
}

// Agents panel
function renderAgentsPanel() {
  const builtin = state.agents.filter((a) => !a.id.startsWith("custom-"));
  const custom  = state.agents.filter((a) => a.id.startsWith("custom-"));
  return `
    <div class="agentsPanel">
      <div class="agentsPanelList">
        ${builtin.length > 0 ? `
          <div class="agentsPanelHeader"><span class="fieldLabel">${icon("layers")} Built-in (${builtin.length})</span></div>
          ${builtin.map((a) => renderAgentRow(a, false)).join("")}
        ` : ""}
        ${custom.length > 0 ? `
          <div class="agentsPanelHeader" style="margin-top:14px;"><span class="fieldLabel">${icon("cpu")} Custom (${custom.length})</span></div>
          ${custom.map((a) => renderAgentRow(a, true)).join("")}
        ` : `
          <div class="emptyAgents">${icon("plus")}<span>No custom agents yet</span></div>
        `}
        <div style="margin-top:16px;">
          <button class="btn btn-primary" data-action="open-agent-form" style="width:100%;">
            ${icon("plus")} New Agent
          </button>
        </div>
      </div>

      <div class="agentFormPane">
        ${state.agentFormOpen ? renderAgentForm() : `
          <div class="agentFormPlaceholder">${icon("cpu")}<span>Select an agent to edit or create new</span></div>
        `}
      </div>
    </div>
  `;
}

function renderAgentRow(a, isCustom) {
  return `
    <div class="agentPanelRow">
      <span style="width:3px;min-height:36px;border-radius:99px;background:${esc(a.accent)};flex-shrink:0;"></span>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;">
          <strong style="font-size:0.8rem;">${esc(a.name)}</strong>
          ${isCustom ? `<span class="customBadge">CUSTOM</span>` : ""}
        </div>
        <small style="color:var(--text-dim);font-size:0.64rem;">${esc(a.provider)} · ${esc(a.model)}</small>
        ${a.description ? `<small style="display:block;color:var(--text-muted);font-size:0.62rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.description)}</small>` : ""}
      </div>
      ${isCustom ? `
        <div style="display:flex;gap:5px;flex-shrink:0;">
          <button class="btn btn-icon" data-action="edit-agent" data-id="${a.id}">${icon("edit")}</button>
          <button class="btn btn-icon" data-action="delete-agent" data-id="${a.id}" style="color:var(--red-hot);">${icon("trash")}</button>
        </div>
      ` : `<span style="font-size:0.58rem;color:var(--text-muted);text-transform:uppercase;flex-shrink:0;">built-in</span>`}
    </div>
  `;
}

function renderAgentForm() {
  const f = state.agentForm;
  const isEdit = Boolean(state.agentFormId);
  const modelSuggestions = {
    anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    openai: ["gpt-4o", "gpt-4o-mini", "gpt-5.5"],
    mock: ["local-sim"],
  };
  const suggestions = modelSuggestions[f.provider] ?? [];

  return `
    <div class="agentForm">
      <div class="agentFormHeader">${icon("cpu")} ${isEdit ? "Edit Agent" : "New Agent"}</div>

      <div class="agentFormGrid">
        <div class="emailField">
          <label class="fieldLabel" for="agent-name">Name</label>
          <input type="text" id="agent-name" placeholder="e.g. Research Assistant" value="${esc(f.name)}" />
        </div>
        <div class="emailField">
          <label class="fieldLabel" for="agent-provider">Provider</label>
          <select id="agent-provider" class="agentSelect">
            <option value="anthropic" ${f.provider === "anthropic" ? "selected" : ""}>Anthropic</option>
            <option value="openai"    ${f.provider === "openai"    ? "selected" : ""}>OpenAI</option>
            <option value="mock"      ${f.provider === "mock"      ? "selected" : ""}>Mock</option>
          </select>
        </div>
        <div class="emailField">
          <label class="fieldLabel" for="agent-model">Model</label>
          <input type="text" list="model-suggestions" id="agent-model" placeholder="e.g. claude-sonnet-4-6" value="${esc(f.model)}" />
          <datalist id="model-suggestions">
            ${suggestions.map((m) => `<option value="${esc(m)}">`).join("")}
          </datalist>
        </div>
        <div class="emailField">
          <label class="fieldLabel">Accent</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <input type="color" id="agent-accent" value="${esc(f.accent)}" style="width:36px;height:32px;border:1px solid var(--border-mid);border-radius:var(--r-sm);background:var(--bg-input);cursor:pointer;padding:2px;flex-shrink:0;" />
            <input type="text" id="agent-accent-text" placeholder="#cc1111" value="${esc(f.accent)}" style="flex:1;" />
          </div>
        </div>
      </div>

      <div class="emailField" style="margin-top:10px;">
        <label class="fieldLabel" for="agent-description">Description <span style="font-weight:400;color:var(--text-muted);">(optional)</span></label>
        <input type="text" id="agent-description" placeholder="One-line description" value="${esc(f.description)}" />
      </div>

      <div class="emailField" style="margin-top:10px;">
        <label class="fieldLabel" for="agent-system-prompt">System Prompt</label>
        <textarea id="agent-system-prompt" rows="8" placeholder="You are a…">${esc(f.systemPrompt)}</textarea>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn btn-secondary" data-action="cancel-agent-form">Cancel</button>
        <button class="btn btn-primary" data-action="save-agent" style="flex:1;"
          ${!f.name.trim() || !f.systemPrompt.trim() ? "disabled" : ""}>
          ${icon("check")} ${isEdit ? "Save Changes" : "Create Agent"}
        </button>
      </div>
    </div>
  `;
}

// Code panel
function renderCodePanel() {
  const rootEntries = state.codeDirContents["."] ?? null;
  return `
    <div class="codePanel">
      <div class="codeTree">
        <div class="codeTreeHeader">
          <span class="fieldLabel" style="font-size:0.6rem;">Files</span>
          <button class="btn btn-icon" data-action="load-fs-dir" data-id=".">${icon("refresh")}</button>
        </div>
        <div style="font-size:0.6rem;color:var(--text-muted);padding:0 8px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(state.workspace.rootDir)}">${esc(state.workspace.rootDir)}</div>
        <div class="codeTreeBody">
          ${rootEntries === null
            ? `<button class="codeTreeLoad" data-action="load-fs-dir" data-id=".">${icon("folder")} Load files</button>`
            : renderFsEntries(rootEntries, 0)
          }
        </div>
      </div>

      <div class="codeEditorArea">
        <div class="codeEditorHeader">
          <span class="codeFileName">${state.codeFile ? esc(state.codeFile) : "No file open"}</span>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            ${state.codeFile && state.codeDiff === null ? `
              <button class="btn btn-ghost" id="code-save-btn" data-action="save-fs-file">
                ${state.codeSaved ? icon("check") + " Saved" : icon("circle") + " Save"}
              </button>
            ` : ""}
            ${state.codeFile ? (
              state.codeDiff !== null
                ? `<button class="btn btn-ghost" data-action="hide-git-diff">${icon("x")} Close Diff</button>`
                : `<button class="btn btn-ghost" data-action="show-git-diff">${icon("diff")} Git Diff</button>`
            ) : ""}
            <button class="btn btn-ghost" data-action="code-to-chat" ${!state.codeContent ? "disabled" : ""}>${icon("send")} To Chat</button>
          </div>
        </div>
        ${state.codeDiff !== null
          ? `<div class="codeDiffPane">${renderDiff(state.codeDiff)}</div>`
          : `<div id="monaco-slot" style="flex:1;min-height:0;overflow:hidden;"></div>`
        }
      </div>
    </div>
  `;
}

function renderFsEntries(entries, depth) {
  return entries.map((e) => {
    if (e.type === "dir") {
      const expanded = state.codeExpanded[e.path];
      const children = state.codeDirContents[e.path];
      return `
        <button class="codeTreeItem dir" data-action="toggle-fs-dir" data-id="${esc(e.path)}"
          style="padding-left:${10 + depth * 14}px;" title="${esc(e.path)}">
          <span class="codeTreeArrow">${expanded ? "▾" : "▸"}</span>
          ${icon("folder")}
          <span>${esc(e.name)}</span>
        </button>
        ${expanded && children ? renderFsEntries(children, depth + 1) : ""}
      `;
    } else {
      const active = state.codeFile === e.path;
      return `
        <button class="codeTreeItem ${active ? "active" : ""}" data-action="open-fs-file" data-id="${esc(e.path)}"
          style="padding-left:${24 + depth * 14}px;" title="${esc(e.path)}">
          ${icon("file")}<span>${esc(e.name)}</span>
        </button>
      `;
    }
  }).join("");
}

// SSH panel
function renderSshPanel() {
  const selected = state.sshConnections.find((c) => c.id === state.sshSelectedId);
  return `
    <div class="sshPanel">
      <div class="sshSidebar">
        <div class="sshSidebarHeader">
          <span class="fieldLabel">Connections</span>
          <button class="btn btn-icon" data-action="open-ssh-form">${icon("plus")}</button>
        </div>

        ${state.sshFormOpen ? `
          <div class="sshForm">
            <div class="emailField">
              <label class="fieldLabel">Label</label>
              <input type="text" id="ssh-label" placeholder="Production server" value="${esc(state.sshForm.label)}" />
            </div>
            <div class="emailField">
              <label class="fieldLabel">Host</label>
              <input type="text" id="ssh-host" placeholder="192.168.1.1 or host.example.com" value="${esc(state.sshForm.host)}" />
            </div>
            <div class="sshFormRow">
              <div class="emailField" style="flex:2;">
                <label class="fieldLabel">User</label>
                <input type="text" id="ssh-user" placeholder="ubuntu" value="${esc(state.sshForm.user)}" />
              </div>
              <div class="emailField" style="flex:1;">
                <label class="fieldLabel">Port</label>
                <input type="number" id="ssh-port" value="${esc(state.sshForm.port ?? 22)}" />
              </div>
            </div>
            <div class="emailField">
              <label class="fieldLabel">Key Path <span style="font-weight:400;color:var(--text-muted);">(optional)</span></label>
              <input type="text" id="ssh-key" placeholder="~/.ssh/id_rsa" value="${esc(state.sshForm.keyPath ?? "")}" />
            </div>
            <div class="emailField">
              <label class="fieldLabel">Description</label>
              <input type="text" id="ssh-description" placeholder="Notes…" value="${esc(state.sshForm.description ?? "")}" />
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;">
              <button class="btn btn-secondary" data-action="cancel-ssh-form">Cancel</button>
              <button class="btn btn-primary" data-action="save-ssh" style="flex:1;"
                ${!state.sshForm.label || !state.sshForm.host || !state.sshForm.user ? "disabled" : ""}>
                ${icon("plus")} Add
              </button>
            </div>
          </div>
        ` : ""}

        <div class="sshConnectionList">
          ${state.sshConnections.length === 0
            ? `<p style="color:var(--text-muted);font-size:0.7rem;padding:10px;">No SSH connections yet</p>`
            : state.sshConnections.map((c) => `
              <div class="sshConnItem ${c.id === state.sshSelectedId ? "active" : ""}"
                data-action="select-ssh" data-id="${c.id}">
                <div style="flex:1;min-width:0;">
                  <strong>${esc(c.label)}</strong>
                  <small>${esc(c.user)}@${esc(c.host)}${c.port && c.port !== 22 ? `:${c.port}` : ""}</small>
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0;">
                  <button class="btn btn-icon" data-action="test-ssh" data-id="${c.id}" title="Test connection">${icon("radio")}</button>
                  <button class="btn btn-icon" data-action="ssh-in-tmux" data-id="${c.id}" title="Open in tmux">${icon("terminal")}</button>
                  <button class="btn btn-icon" data-action="delete-ssh" data-id="${c.id}" title="Delete" style="color:var(--red-hot);">${icon("trash")}</button>
                </div>
              </div>
            `).join("")}
        </div>
      </div>

      <div class="sshMain">
        ${selected ? `
          <div class="sshMainHeader">
            <span>${esc(selected.user)}@${esc(selected.host)}</span>
            <span style="color:var(--text-muted);font-size:0.65rem;">${esc(selected.label)}</span>
          </div>
          <div class="tmuxOutput" style="flex:1;">${esc(state.sshOutput)}</div>
          <div class="tmuxInputBar">
            <span class="tmuxPromptPrefix">$</span>
            <input class="tmuxInput" id="ssh-command" type="text"
              placeholder="Command… (Enter to run)" value="${esc(state.sshCommand)}" />
            <button class="btn btn-secondary" data-action="run-ssh" ${state.sshRunning ? "disabled" : ""}>
              ${state.sshRunning ? icon("loader") : "Run"}
            </button>
          </div>
        ` : `
          <div class="tmuxNoSession">${icon("server")} Select a connection or add one</div>
        `}
      </div>
    </div>
  `;
}

// Autopilot panel
function renderAutopilotPanel() {
  const selectedSession = state.autopilotSessions.find((s) => s.id === state.autopilotSelectedId);
  return `
    <div class="autopilotPanel">
      <div class="autopilotSidebar">
        <div class="autopilotGoalArea">
          <label class="fieldLabel" for="autopilot-goal">
            ${icon("zap")} Goal
            <span style="font-weight:400;color:var(--text-muted);font-size:0.58rem;margin-left:6px;">⌘↵ to launch</span>
          </label>
          <textarea id="autopilot-goal" rows="4"
            placeholder="e.g. Add dark mode to Hyperion. Read styles.css, propose changes, write them.">${esc(state.autopilotGoal)}</textarea>
          <div style="display:flex;gap:6px;margin-top:8px;align-items:center;">
            <div class="fieldLabel" style="font-size:0.6rem;color:var(--text-muted);">
              ${icon("folder")} ${esc(state.workspace.rootDir)}
            </div>
            <button class="btn btn-primary" data-action="launch-autopilot" style="margin-left:auto;"
              ${state.autopilotRunning || !state.autopilotGoal.trim() ? "disabled" : ""}>
              ${icon(state.autopilotRunning ? "loader" : "zap")}
              ${state.autopilotRunning ? "Planning…" : "Launch"}
            </button>
          </div>
        </div>

        <div class="autopilotSessionListHeader">
          <span class="fieldLabel" style="font-size:0.58rem;">History</span>
          ${state.autopilotSessions.some((s) => s.status !== "running" && s.status !== "planning") ? `
            <button class="btn btn-ghost" style="font-size:0.58rem;padding:2px 7px;" data-action="clear-autopilot-done">
              ${icon("trash")} Clear done
            </button>
          ` : ""}
        </div>
        <div class="autopilotSessionList">
          ${state.autopilotSessions.length === 0
            ? `<p style="color:var(--text-muted);font-size:0.7rem;padding:10px;">No autopilot sessions yet</p>`
            : state.autopilotSessions.map((s) => `
              <div class="autopilotSessionItem ${s.id === state.autopilotSelectedId ? "active" : ""}"
                data-action="select-autopilot" data-id="${s.id}">
                <span class="dot ${s.status === "running" ? "running" : s.status === "completed" ? "ready" : "mock"}" style="width:6px;height:6px;flex-shrink:0;"></span>
                <div style="flex:1;min-width:0;text-align:left;">
                  <strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.goal.slice(0, 46))}</strong>
                  <small>${s.status} · ${s.runs?.length ?? 0} agents</small>
                </div>
                <button class="btn btn-icon" data-action="delete-autopilot" data-id="${s.id}"
                  style="width:20px;height:20px;flex-shrink:0;color:var(--text-muted);"
                  title="Delete session">${icon("x")}</button>
              </div>
            `).join("")}
        </div>
      </div>

      <div class="autopilotMain">
        ${selectedSession ? renderAutopilotSession(selectedSession) : `
          <div class="tmuxNoSession">${icon("zap")} Enter a goal and launch Autopilot</div>
        `}
      </div>
    </div>
  `;
}

function renderAutopilotSession(sess) {
  const isRunning = sess.status === "running" || sess.status === "planning";
  return `
    <div class="autopilotSessionView">
      <div class="autopilotSessionHeader">
        <div>
          <div class="fieldLabel" style="font-size:0.68rem;">${esc(sess.goal.slice(0, 80))}</div>
          <small style="color:var(--text-muted);">${esc(sess.workDir)} · ${esc(sess.status)}</small>
        </div>
        ${isRunning
          ? `<button class="btn btn-danger" data-action="abort-autopilot" data-id="${sess.id}">${icon("square")} Abort</button>`
          : ""
        }
      </div>

      ${sess.plan ? `
        <div class="autopilotPlanBar">
          <span class="secLabel" style="margin-bottom:0;">${icon("layers")} Plan: ${esc(sess.plan.reasoning)}</span>
        </div>
      ` : sess.status === "planning" ? `
        <div class="autopilotPlanBar">
          ${icon("loader")} <span style="color:var(--text-dim);font-size:0.7rem;">Planning with AI…</span>
        </div>
      ` : ""}

      <div class="autopilotRunList">
        ${sess.runs?.length > 0
          ? sess.runs.map((run) => renderAutopilotRun(run, sess)).join("")
          : `<div class="emptyState" style="margin-top:24px;">${icon("clock")}<span>Waiting for plan…</span></div>`
        }
      </div>

      ${state.autopilotPausedRunId ? `
        <div class="modifyPanel">
          <div class="fieldLabel">${icon("edit")} Modify paused agent task</div>
          <textarea id="autopilot-modify-task" rows="4">${esc(state.autopilotModifyTask)}</textarea>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn btn-secondary" data-action="cancel-modify">Cancel</button>
            <button class="btn btn-primary" data-action="resume-run" data-id="${state.autopilotPausedRunId}" style="flex:1;">
              ${icon("zap")} Resume with changes
            </button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

function renderAutopilotRun(run, sess) {
  const isPaused = state.autopilotPausedRunId === run.id;
  const isCollapsed = state.autopilotRunCollapsed[run.id] === true;
  const statusColor = { running: "var(--amber)", completed: "var(--green)", failed: "var(--red)", queued: "var(--text-muted)", cancelled: "var(--text-muted)" }[run.status] ?? "var(--text-muted)";

  return `
    <div class="autopilotRunCard ${run.status}">
      <div class="autopilotRunHeader">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="dot ${run.status === "running" ? "running" : ""}" style="width:8px;height:8px;background:${statusColor};"></span>
          <div>
            <strong style="font-size:0.8rem;">${esc(run.role)}</strong>
            <small style="color:var(--text-dim);font-size:0.62rem;display:block;">${esc(run.provider)} · ${esc(run.model)}</small>
          </div>
        </div>
        <div style="display:flex;gap:5px;align-items:center;">
          ${run.status === "running" && !isPaused
            ? `<button class="btn btn-ghost" style="font-size:0.62rem;padding:2px 8px;" data-action="pause-run" data-id="${run.id}">${icon("square")} Pause</button>`
            : ""
          }
          ${isPaused
            ? `<button class="btn btn-primary" style="font-size:0.62rem;padding:2px 8px;" data-action="resume-run" data-id="${run.id}">${icon("zap")} Resume</button>`
            : ""
          }
          ${renderStatusBadge(run.status)}
          <button class="btn btn-icon" data-action="toggle-run-collapse" data-id="${run.id}"
            style="width:22px;height:22px;flex-shrink:0;" title="${isCollapsed ? "Expand" : "Collapse"}">
            ${isCollapsed ? icon("plus") : icon("x")}
          </button>
        </div>
      </div>

      ${isCollapsed ? "" : `
        <div class="autopilotRunTask">${esc(run.task.slice(0, 120))}${run.task.length > 120 ? "…" : ""}</div>

        ${run.tools?.length > 0 ? `
          <div class="autopilotRunTools">
            ${run.tools.map((t) => `<span class="toolPill">${t}</span>`).join("")}
          </div>
        ` : ""}

        ${run.output ? `
          <div class="autopilotRunOutput">
            <pre>${esc(run.output.slice(-2000))}${run.output.length > 2000 ? "\n[…]" : ""}</pre>
          </div>
        ` : ""}

        ${run.error ? `<div class="errorLine">${icon("alert")} ${esc(run.error)}</div>` : ""}
      `}
    </div>
  `;
}

// Event rail
function renderEventRail() {
  return `
    <aside class="eventRail">
      <div class="railHeader">
        ${icon("activity")}<span>Signal Stream</span>
        <span class="railLiveDot"></span>
      </div>
      <div class="eventList">
        ${state.events.slice().reverse().slice(0, 60).map((e) => `
          <div class="eventItem ${e.level}">
            <small>${new Date(e.createdAt).toLocaleTimeString()}</small>
            <span>${esc(e.message)}</span>
          </div>
        `).join("") || `<p style="color:var(--text-muted);font-size:0.7rem;padding:8px;">No events</p>`}
      </div>
    </aside>
  `;
}

// Utilities
function toggle(arr, id) { return arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]; }

function upsert(sessions, session) {
  const exists = sessions.some((s) => s.id === session.id);
  const next = exists ? sessions.map((s) => s.id === session.id ? session : s) : [session, ...sessions];
  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function applyDelta(sessions, { sessionId, runId, delta }) {
  return sessions.map((s) =>
    s.id !== sessionId ? s : { ...s, runs: s.runs.map((r) => r.id !== runId ? r : { ...r, output: r.output + delta }) }
  );
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function defaultModel(provider) {
  if (provider === "anthropic") return "claude-sonnet-4-6";
  if (provider === "openai") return "gpt-4o";
  return "local-sim";
}

function inferLanguage(filePath) {
  if (!filePath) return "plaintext";
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  const map = { ts:"typescript", tsx:"typescript", js:"javascript", jsx:"javascript", py:"python", rs:"rust", go:"go", json:"json", md:"markdown", css:"css", html:"html", sh:"shell", yaml:"yaml", yml:"yaml", toml:"toml", txt:"plaintext" };
  return map[ext] || "plaintext";
}

function esc(val) {
  return String(val ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

// Icon library (Feather-style)
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
    code:       '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    copy:       '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    cpu:        '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 15h3"/><path d="M1 9h3"/><path d="M1 15h3"/>',
    diff:       '<path d="M12 3v18"/><path d="M17 8l-5-5-5 5"/><path d="M7 16l5 5 5-5"/>',
    edit:       '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    file:       '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/>',
    folder:     '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    inbox:      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
    layers:     '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    loader:     '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    message:    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    plus:       '<path d="M12 5v14"/><path d="M5 12h14"/>',
    plug:       '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M6 8h12v3a6 6 0 0 1-12 0Z"/>',
    radio:      '<circle cx="12" cy="12" r="2"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M7.76 7.76a6 6 0 0 0 0 8.49"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/>',
    refresh:    '<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.4 5.6L21 8"/><path d="M21 3v5h-5"/>',
    send:       '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    server:     '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
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
