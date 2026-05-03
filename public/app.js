const starterPrompts = [
  "Design Conductor as a local agent dashboard that can run coding agents in parallel and show every stream in real time.",
  "Compare the best architecture for email/calendar tool access with human approval before side effects.",
  "Pressure test an MVP for a personal AI operations dashboard with multiple model providers."
];

const state = {
  agents: [],
  providers: [],
  connectors: [],
  sessions: [],
  events: [],
  selectedSessionId: null,
  selectedAgentIds: [],
  prompt: starterPrompts[0],
  submitting: false
};

const app = document.querySelector("#app");

app.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  const id = target.dataset.id;

  if (action === "select-session") {
    state.selectedSessionId = id;
    render();
  }

  if (action === "toggle-agent") {
    state.selectedAgentIds = toggleId(state.selectedAgentIds, id);
    render();
  }

  if (action === "select-all-agents") {
    state.selectedAgentIds = state.agents.map((agent) => agent.id);
    render();
  }

  if (action === "starter") {
    state.prompt = starterPrompts[Number(target.dataset.index)];
    render();
  }

  if (action === "run") {
    void createSession();
  }

  if (action === "refresh") {
    void loadInitialData();
  }

  if (action === "abort") {
    void abortSession(id);
  }
});

app.addEventListener("input", (event) => {
  if (event.target.id === "prompt") {
    state.prompt = event.target.value;
  }
});

await loadInitialData();
connectSocket();
render();

async function loadInitialData() {
  const [agentsResponse, connectorsResponse, sessionsResponse, eventsResponse] = await Promise.all([
    fetch("/api/agents"),
    fetch("/api/connectors"),
    fetch("/api/sessions"),
    fetch("/api/events")
  ]);

  const agentsData = await agentsResponse.json();
  const connectorsData = await connectorsResponse.json();
  const sessionsData = await sessionsResponse.json();
  const eventsData = await eventsResponse.json();

  state.agents = agentsData.agents;
  state.providers = agentsData.providers;
  state.connectors = connectorsData.connectors;
  state.sessions = sessionsData.sessions;
  state.events = eventsData.events;

  if (state.selectedAgentIds.length === 0) {
    state.selectedAgentIds = state.agents.map((agent) => agent.id);
  }

  state.selectedSessionId = state.selectedSessionId ?? state.sessions[0]?.id ?? null;
  render();
}

function connectSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/ws`);

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "sessions:snapshot") {
      state.sessions = message.payload;
      state.selectedSessionId = state.selectedSessionId ?? state.sessions[0]?.id ?? null;
    }

    if (message.type === "events:snapshot") {
      state.events = message.payload;
    }

    if (message.type === "session:updated") {
      state.sessions = upsertSession(state.sessions, message.payload);
      state.selectedSessionId = state.selectedSessionId ?? message.payload.id;
    }

    if (message.type === "run:delta") {
      state.sessions = applyDelta(state.sessions, message.payload);
    }

    if (message.type === "session:event") {
      state.events = [...state.events.slice(-249), message.payload];
    }

    render();
  });

  socket.addEventListener("close", () => {
    setTimeout(connectSocket, 1200);
  });
}

async function createSession() {
  if (!state.prompt.trim() || state.selectedAgentIds.length === 0 || state.submitting) {
    return;
  }

  state.submitting = true;
  render();

  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: state.prompt,
        agentIds: state.selectedAgentIds
      })
    });

    if (!response.ok) {
      throw new Error("Session request failed");
    }

    const data = await response.json();
    state.selectedSessionId = data.session.id;
  } finally {
    state.submitting = false;
    render();
  }
}

async function abortSession(sessionId) {
  await fetch(`/api/sessions/${sessionId}/abort`, { method: "POST" });
}

function render() {
  const selectedSession = state.sessions.find((session) => session.id === state.selectedSessionId) ?? state.sessions[0] ??
    null;
  const activeRuns = selectedSession?.runs ?? [];
  const runningCount = state.sessions.reduce(
    (total, session) => total + session.runs.filter((run) => run.status === "running").length,
    0
  );
  const readyConnectors = state.connectors.filter((connector) =>
    connector.status === "ready" || connector.status === "mock"
  );

  app.innerHTML = `
    <div class="appShell">
      <aside class="sidebar">
        <div class="brandBlock">
          <div class="brandMark">${icon("workflow")}</div>
          <div>
            <h1>Conductor</h1>
            <p>Agent Console</p>
          </div>
        </div>

        <section class="sidebarSection">
          <div class="sectionTitle">${icon("activity")}<span>Providers</span></div>
          <div class="statusList">
            ${state.providers.map(providerRow).join("")}
          </div>
        </section>

        <section class="sidebarSection">
          <div class="sectionTitle">${icon("plug")}<span>Connectors</span><b>${readyConnectors.length}</b></div>
          <div class="connectorList">
            ${state.connectors.map(connectorRow).join("")}
          </div>
        </section>

        <section class="sidebarSection fill">
          <div class="sectionTitle">${icon("clock")}<span>Sessions</span></div>
          <div class="sessionList">
            ${state.sessions.map((session) => sessionButton(session, selectedSession)).join("")}
          </div>
        </section>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">Real-time multi-agent console</p>
            <h2>${escapeHtml(selectedSession?.title ?? "New session")}</h2>
          </div>
          <div class="topbarStats">
            ${metric("Running", runningCount)}
            ${metric("Sessions", state.sessions.length)}
            ${metric("Agents", state.agents.length)}
          </div>
        </header>

        <section class="composer">
          <div class="promptColumn">
            <label for="prompt">Prompt</label>
            <textarea id="prompt" rows="5" placeholder="Ask the crew...">${escapeHtml(state.prompt)}</textarea>
            <div class="promptActions">
              <div class="starterRow">
                ${starterPrompts.map((starter, index) => `
                  <button class="ghostButton" data-action="starter" data-index="${index}" type="button">
                    ${escapeHtml(starter.slice(0, 34))}
                  </button>
                `).join("")}
              </div>
              <button
                class="primaryButton"
                data-action="run"
                ${state.submitting || !state.prompt.trim() || state.selectedAgentIds.length === 0 ? "disabled" : ""}
                title="Run"
                type="button"
              >
                ${icon(state.submitting ? "loader" : "send")}
                <span>Run</span>
              </button>
            </div>
          </div>

          <div class="agentPicker">
            <div class="pickerHeader">
              <span>Agents</span>
              <button class="iconButton" data-action="select-all-agents" title="Select all" type="button">
                ${icon("check")}
              </button>
            </div>
            ${state.agents.map(agentChoice).join("")}
          </div>
        </section>

        <section class="runHeader">
          <div>
            <p class="eyebrow">Live output</p>
            <h3>${escapeHtml(selectedSession?.status ?? "Idle")}</h3>
          </div>
          ${selectedSession?.status === "running"
            ? `<button class="dangerButton" data-action="abort" data-id="${selectedSession.id}" title="Stop session" type="button">${icon("square")}<span>Stop</span></button>`
            : `<button class="secondaryButton" data-action="refresh" title="Refresh" type="button">${icon("refresh")}<span>Refresh</span></button>`}
        </section>

        <section class="runGrid">
          ${activeRuns.length > 0 ? activeRuns.map(runCard).join("") : emptyState()}
        </section>
      </main>

      <aside class="eventRail">
        <div class="sectionTitle">${icon("activity")}<span>Event Stream</span></div>
        <div class="eventList">
          ${state.events.slice().reverse().map(eventItem).join("")}
        </div>
      </aside>
    </div>
  `;
}

function providerRow(provider) {
  return `
    <div class="statusRow">
      <span class="dot ${provider.configured ? "ready" : "mock"}"></span>
      <div>
        <strong>${escapeHtml(provider.label)}</strong>
        <small>${escapeHtml(provider.detail)}</small>
      </div>
    </div>
  `;
}

function connectorRow(connector) {
  return `
    <div class="connectorRow">
      ${icon(connector.kind === "calendar" ? "calendar" : connector.kind === "shell" ? "terminal" : "inbox")}
      <div>
        <strong>${escapeHtml(connector.name)}</strong>
        <small>${escapeHtml(connector.status === "needs_env" ? connector.envVars.join(", ") : connector.detail)}</small>
      </div>
      <span class="pill ${connector.status}">${escapeHtml(connector.status.replace("_", " "))}</span>
    </div>
  `;
}

function sessionButton(session, selectedSession) {
  return `
    <button
      class="sessionButton ${session.id === selectedSession?.id ? "active" : ""}"
      data-action="select-session"
      data-id="${session.id}"
      type="button"
    >
      <span>${escapeHtml(session.title)}</span>
      <small>${session.runs.length} agents</small>
    </button>
  `;
}

function metric(label, value) {
  return `
    <div class="metric">
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
  `;
}

function agentChoice(agent) {
  const selected = state.selectedAgentIds.includes(agent.id);
  return `
    <button class="agentChoice ${selected ? "selected" : ""}" data-action="toggle-agent" data-id="${agent.id}" type="button">
      <span class="agentAccent" style="background: ${escapeHtml(agent.accent)}"></span>
      <span>
        <strong>${escapeHtml(agent.name)}</strong>
        <small>${escapeHtml(agent.provider)} / ${escapeHtml(agent.model)}</small>
      </span>
      ${icon(selected ? "check" : "circle")}
    </button>
  `;
}

function runCard(run) {
  const agent = state.agents.find((candidate) => candidate.id === run.agentId);
  const output = run.output || run.error || "Queued";

  return `
    <article class="runCard" style="--accent: ${escapeHtml(agent?.accent ?? "#555")}">
      <header>
        <div>
          <h4>${escapeHtml(run.agentName)}</h4>
          <p>${escapeHtml(run.provider)} / ${escapeHtml(run.model)}</p>
        </div>
        ${statusBadge(run.status)}
      </header>
      <pre>${escapeHtml(output)}</pre>
      ${run.error ? `<div class="errorLine">${icon("alert")}<span>${escapeHtml(run.error)}</span></div>` : ""}
    </article>
  `;
}

function statusBadge(status) {
  const icons = {
    running: "loader",
    completed: "check",
    failed: "x",
    cancelled: "clock",
    queued: "clock"
  };

  return `
    <span class="statusBadge ${status}">
      ${icon(icons[status] ?? "clock")}
      ${escapeHtml(status)}
    </span>
  `;
}

function eventItem(event) {
  return `
    <div class="eventItem ${event.level}">
      <small>${new Date(event.createdAt).toLocaleTimeString()}</small>
      <span>${escapeHtml(event.message)}</span>
    </div>
  `;
}

function emptyState() {
  return `
    <div class="emptyState">
      ${icon("terminal")}
      <span>No sessions yet</span>
    </div>
  `;
}

function toggleId(ids, id) {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}

function upsertSession(sessions, session) {
  const exists = sessions.some((candidate) => candidate.id === session.id);
  const next = exists
    ? sessions.map((candidate) => candidate.id === session.id ? session : candidate)
    : [session, ...sessions];

  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function applyDelta(sessions, payload) {
  return sessions.map((session) => {
    if (session.id !== payload.sessionId) {
      return session;
    }

    return {
      ...session,
      runs: session.runs.map((run) =>
        run.id === payload.runId
          ? {
            ...run,
            output: run.output + payload.delta
          }
          : run
      )
    };
  });
}

function icon(name) {
  const paths = {
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    alert:
      '<path d="m21 16-8.5-14.5a1 1 0 0 0-1.8 0L2 16a1 1 0 0 0 .9 1.5h18.2A1 1 0 0 0 21 16Z"/><path d="M12 7v4"/><path d="M12 15h.01"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    circle: '<circle cx="12" cy="12" r="8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
    loader: '<path d="M21 12a9 9 0 0 1-9 9"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M6 8h12v3a6 6 0 0 1-12 0Z"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.4 5.6L21 8"/><path d="M21 3v5h-5"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    terminal: '<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>',
    workflow:
      '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h4a3 3 0 0 1 3 3v6"/><path d="M15 18h-4a3 3 0 0 1-3-3v-2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };

  return `<svg class="icon ${name === "loader" ? "spin" : ""}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths.circle}</svg>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
