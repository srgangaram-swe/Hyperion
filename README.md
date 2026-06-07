# Hyperion Z

> A self-hosted agentic AI operations console. Point it at any codebase, give it a goal, and watch a fleet of AI agents plan the work, split it across parallel and serial tasks, read and write real files, run shell commands, and hand you a git diff when they are done.

## What it is

Hyperion Z is a **local-first AI ops console** built for engineers who want more than a chat window. It runs a Deno/TypeScript server behind a dark red Matrix-themed browser UI. You can orchestrate multi-agent pipelines with a single natural-language prompt, manage tmux sessions, draft emails with AI, browse and edit code with a Monaco editor, manage SSH connections, and configure custom agents — all from one streaming dashboard.

The entire system runs on your machine. The only external dependency is the model API (Anthropic Claude, OpenAI, or both).

The UI is intentionally stark: canvas matrix rain in red, scanlines, glow effects, and JetBrains Mono throughout.

---

## Eight tool panels

### CHAT
Multi-agent composer. Select which agents to include, attach file context chips, write a prompt, and hit Run. Each agent streams into its own card simultaneously. Supports mid-stream abort.

### TMUX
Live terminal session management. Sessions listed on the left; live `capture-pane` output on the right, polled every two seconds. Send commands from the input bar. The AI button sends the current pane output to Claude and asks it to suggest the next command.

### EMAIL
Provide a thread or topic, pick a tone (professional, casual, concise), and click Draft with AI. Claude streams a reply draft in real time. Edit inline and copy to your mail client.

### FILES
Drag-and-drop or paste files. Content is automatically prepended to the next agent session as structured context blocks.

### AGENTS
Create and manage custom agent configurations. Set the name, provider, model, system prompt, accent colour, and tool access. Agents persist across restarts in `data/agents.json`.

### CODE
Monaco editor (the VS Code engine) embedded in the browser. Browse the workspace directory tree, open files, and view git diffs. When Autopilot completes a run, you can click "Hyperion Z Diff" on any session to see the full `git diff HEAD` for every file the agents touched.

### SSH
Saved SSH connection manager. Add connections (label, host, user, port, key path) and open any of them directly in a new tmux window with one click. Connections persist in `data/ssh-connections.json`.

### AUTOPILOT
The meta-agent orchestrator. Give it a single natural-language goal and a workspace directory. A planner agent (Claude or GPT) reads the goal and produces a JSON pipeline: 2-4 focused sub-agents, each with a specific task, a tool set, and a dependency graph that determines whether they run in parallel or in serial.

Each agent then runs its own autonomous tool-use loop:

| Tool | What it does |
|------|-------------|
| `fs_read` | Read a file from the workspace (up to 20 KB) |
| `fs_write` | Write or overwrite a file |
| `fs_list` | List a directory |
| `tmux_run` | Execute a shell command via tmux and capture output |

Everything is visible in real time: the plan appears as it is generated, each agent's token-by-token output streams live, and every tool call is shown. You can pause any agent mid-run, edit its task, and resume. When a session completes, written files appear as green chips on each agent card. The Hyperion Z Diff button runs `git diff HEAD` across all session-written files and renders the result in the Code panel.

Autopilot has been used to improve its own codebase from a single prompt, which makes it a practical test for any engineering workflow you point it at.

---

## Architecture

```
Browser (http://127.0.0.1:8787)
    |
    |  WebSocket (ws://) + REST (http://)
    v
Deno server (server/main.ts)
    |-- providers.ts    OpenAI + Anthropic streaming adapters
    |-- agents.ts       Agent roster and custom agent CRUD
    |-- orchestrator.ts Autopilot planner + tool-use loop
    |-- ssh.ts          SSH connection CRUD (data/ssh-connections.json)
    |-- utils.ts        Path-safe file resolution, tmux helpers
    |-- connectors.ts   Connector readiness checks
    |-- tmux.ts         Deno.Command wrapper for tmux
    |-- memory.ts       JSON-backed persistent memory
    |
    |-- /api/sessions         multi-agent session CRUD
    |-- /api/orchestrate      Autopilot session CRUD + WebSocket events
    |-- /api/orchestrate/:id/diff  git diff for session-written files
    |-- /api/ssh              SSH connection CRUD
    |-- /api/tmux/*           tmux session management + pane capture
    |-- /api/draft-email      Claude SSE stream for email drafting
    |-- /api/memory           persistent memory CRUD + keyword search
    |-- /api/files/list       workspace directory listing
    |-- /api/files/read       workspace file content
    |
    |  HTTPS API calls
    v
OpenAI / Anthropic APIs
```

**Stack:** Deno, TypeScript, vanilla JS (no bundler, no framework), Python, WebSocket, SSE, Monaco Editor (AMD CDN)

---

## Quick start

### Prerequisites

- [Deno](https://deno.land/) v1.40 or later (`curl -fsSL https://deno.land/install.sh | sh`)
- API keys for OpenAI and/or Anthropic
- `tmux` installed for the terminal panel (`brew install tmux` on macOS)

### Run

```bash
git clone https://github.com/srgangaram-swe/Hyperion Z.git
cd Hyperion Z
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY and/or OPENAI_API_KEY
deno task dev
```

Open **http://127.0.0.1:8787**. Without keys, agents run in mock streaming mode so the UI is always explorable.

---

## Getting API keys

### Anthropic Claude

1. Go to [console.anthropic.com](https://console.anthropic.com/) and create an account.
2. Navigate to API Keys and create a key.
3. Add to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-api03-...
   ```
4. Set a monthly budget cap under Billing to avoid surprises.

**Models (set `CLAUDE_MODEL` in `.env`):**

| Model | Use case |
|-------|---------|
| `claude-haiku-4-5-20251001` | Fast and cheap; good for routine tasks |
| `claude-sonnet-4-6` | Balanced; best daily driver (default) |
| `claude-opus-4-8` | Most capable; use for complex reasoning |

### OpenAI

1. Go to [platform.openai.com](https://platform.openai.com/) and create an account.
2. Navigate to API keys and create a secret key.
3. Add to `.env`:
   ```
   OPENAI_API_KEY=sk-proj-...
   ```

**Recommended model:** `gpt-4o`

---

## Environment variables

```bash
PORT=8787

# LLM providers
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-4-6
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o
AGENT_MAX_TOKENS=8192

# Autopilot workspace (optional — set per-session in the UI)
FS_ROOT=

# Email connectors (optional)
IMAP_HOST=
IMAP_USER=
IMAP_PASS=
SMTP_HOST=
SMTP_USER=
SMTP_PASS=

# Google Calendar (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Slack (optional)
SLACK_BOT_TOKEN=
```

---

## Autopilot in depth

### How it works

1. You provide a goal (natural language) and a workspace directory path.
2. A planner agent reads the goal and returns a JSON pipeline with 2-4 sub-agents. Each agent has a `role`, `task`, `provider`, `model`, `tools`, and a `dependsOn` index list that controls ordering.
3. Agents with no dependencies run in parallel. Agents that depend on earlier ones run after those complete, using handoff files in `tmp/` to pass data between stages.
4. Each agent runs a multi-turn tool-use loop until it either signals completion or exhausts its tool calls.
5. All output streams live to the UI. Written files are tracked per agent and shown as clickable green chips on the run card.

### Human-in-the-loop controls

- **Pause / Resume** any running agent
- **Modify task** while paused: edit the agent's task prompt and resume with the new instruction
- **Abort** the entire session at any time
- **Hyperion Z Diff**: after completion, view the full `git diff HEAD` for everything the session wrote

### Configuring the planner

The planner defaults to Claude Sonnet. You can switch any individual agent to OpenAI by changing the `provider` field returned in the plan, or override the planner model via the workspace config in the UI.

---

## Persistent memory

Backed by `data/memory.json`. Four categories:

| Category | Example |
|----------|---------|
| `fact` | "User is a data scientist at LANL" |
| `preference` | "Always format code with 2-space indentation" |
| `context` | "Current project: Hyperion Z orchestrator improvements" |
| `skill` | "Agent knows how to search arXiv for papers" |

**API:**
```
GET    /api/memory?category=fact&q=search+query&limit=20
POST   /api/memory          { category, text, tags, agentId }
PATCH  /api/memory/:id      { text?, tags?, category? }
DELETE /api/memory/:id
```

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full list. Near-term priorities:

- WebSocket PTY for a fully interactive in-browser terminal
- Vector memory with local embeddings (semantic search replacing keyword search)
- Deep research mode (multi-step web search → synthesize → visual report)
- IMAP inbox polling with AI triage and auto-draft replies
- Session persistence to SQLite (survive server restarts)
- Docker Compose packaging for one-command deployment

---

## Contributing

Issues and pull requests welcome. See `.github/` for templates.

---

## License

MIT
