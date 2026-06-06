# Hyperion

> **A self-hosted agentic harness with a red Matrix-themed UI — run OpenAI and Anthropic agents in parallel, manage tmux sessions, draft emails with AI, and inject local file context, all from one streaming dashboard.**

---

## What it is

Hyperion is a **local-first AI operations console** built for power users who want more than a chat window. It orchestrates multiple AI agents simultaneously, gives each one real tools (shell sessions, email, file context, persistent memory), and streams every token of output to a live dashboard — all running on your own machine with no cloud dependency beyond the model APIs.

The UI is intentionally stark: a dark red Matrix-style terminal aesthetic that makes it feel like you're running a mission control, not clicking around a SaaS product.

---

## Features

| Feature | Detail |
|---------|--------|
| **Multi-agent sessions** | Dispatch one prompt to multiple agents (OpenAI + Anthropic) in parallel; watch streams side-by-side |
| **Red Matrix UI** | Dark theme with canvas Matrix rain, scanlines, glow effects, JetBrains Mono throughout |
| **tmux integration** | List, create, kill sessions; stream live `capture-pane` output; send commands; ask AI to suggest the next command |
| **AI email drafting** | Claude streams a reply draft in real time given any email thread; choose tone (professional / casual / concise) |
| **File context injection** | Drag-and-drop or paste files; content is automatically prepended to the next agent prompt |
| **Persistent memory** | Agents can read/write tagged facts, preferences, skills, and context across sessions (JSON-backed) |
| **Live event stream** | Every session, run, tool call, and error appears in real time in the Signal Stream rail |
| **Mock mode** | No API keys? All agents fall back to deterministic mock streaming so the UI always works |
| **WebSocket first** | All state updates — token deltas, session status, events — flow over a single WebSocket connection |

---

## Architecture

```
Browser (http://127.0.0.1:8787)
    │
    │  WebSocket (ws://) + REST (http://)
    ▼
Deno server (server/main.ts)
    ├─ providers.ts    — OpenAI Responses API + Anthropic Messages API streaming adapters
    ├─ agents.ts       — agent roster (provider, model, system prompt, accent colour)
    ├─ connectors.ts   — connector readiness (Gmail/IMAP, SMTP, Calendar, Slack, tmux)
    ├─ tmux.ts         — Deno.Command subprocess wrapper for tmux
    └─ memory.ts       — JSON-backed persistent memory (list, add, edit, delete, search)
    │
    ├─ /api/sessions        — create, list, abort multi-agent sessions
    ├─ /api/tmux/*          — tmux session management + pane capture
    ├─ /api/draft-email     — Claude SSE stream for email drafting
    └─ /api/memory          — persistent memory CRUD + keyword search
    │
    │  HTTPS API calls
    ▼
OpenAI / Anthropic APIs
```

**Stack:** Deno · TypeScript · vanilla JS (no bundler, no framework) · WebSocket · SSE

---

## Quick start

### Prerequisites

- [Deno](https://deno.land/) v1.40+  (`curl -fsSL https://deno.land/install.sh | sh`)
- API keys for OpenAI and/or Anthropic (see [Getting API Keys](#getting-api-keys))
- `tmux` installed if you want the terminal panel (`brew install tmux` / `apt install tmux`)

### Run

```bash
git clone https://github.com/srgangaram-swe/Hyperion.git
cd Hyperion
cp .env.example .env
# Edit .env — paste your ANTHROPIC_API_KEY and/or OPENAI_API_KEY
deno task dev
```

Open **http://127.0.0.1:8787** — the dashboard loads instantly. Without keys, agents run in mock streaming mode so you can explore the UI.

---

## Getting API Keys

### Anthropic Claude

1. Go to [console.anthropic.com](https://console.anthropic.com/) and create an account.
2. Navigate to **API Keys** → **Create Key**.
3. Paste the key into `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-api03-...
   ```
4. Set a **monthly budget cap** under Billing → Usage limits (start with $20).

**Models available (set `CLAUDE_MODEL` in `.env`):**
| Model | Use case |
|-------|---------|
| `claude-haiku-4-5-20251001` | Fast, cheapest — routine tasks, drafts |
| `claude-sonnet-4-6` | Balanced — best daily driver (default) |
| `claude-opus-4-8` | Most capable — complex reasoning only |

> Claude.ai Pro/Max subscriptions are **not** the same as API access. You need a key from `console.anthropic.com`.

### OpenAI

1. Go to [platform.openai.com](https://platform.openai.com/) and create an account.
2. Navigate to **API keys** → **Create new secret key**.
3. Paste the key into `.env`:
   ```
   OPENAI_API_KEY=sk-proj-...
   ```
4. Set a monthly usage limit under **Billing → Usage limits**.

**Model (set `OPENAI_MODEL` in `.env`):**
```
OPENAI_MODEL=gpt-4o        # recommended
```

---

## Tool panels

### CHAT
The main multi-agent composer. Select which agents to include, attach file context (shown as chips), write a prompt, and hit **Run**. Each agent streams into its own card.

### TMUX
Live terminal session management. Sessions listed on the left; live `capture-pane` output on the right, polled every 2 seconds. Type commands in the input bar (Enter to send). **AI ▸** sends the current pane output to Claude and asks it to suggest the next command.

### EMAIL
Provide a thread or topic, pick a tone, and click **Draft with AI** — Claude streams a reply draft in real time. Edit the draft, then copy it into your mail client. Full IMAP/SMTP integration (configurable via `.env`) is on the roadmap.

### FILES
Drag-and-drop files or paste text. Content is automatically prepended to the next session's prompt as structured context blocks.

---

## Environment variables

```bash
PORT=8787

# LLM providers
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-4-6
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o
AGENT_MAX_TOKENS=4096

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

# Microsoft 365 (optional)
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=

# Slack (optional)
SLACK_BOT_TOKEN=
```

---

## Persistent memory

Agents can read and write to a JSON-backed memory store at `data/memory.json`. Four categories:

| Category | Examples |
|----------|---------|
| `fact` | "User is a PhD researcher in computational biology" |
| `preference` | "Always format code with 2-space indentation" |
| `context` | "Current project: tmux integration for Hyperion" |
| `skill` | "Agent knows how to search arXiv for papers" |

**API:**
```
GET  /api/memory?category=fact&q=search+query&limit=20
POST /api/memory          { category, text, tags, agentId }
PATCH /api/memory/:id     { text?, tags?, category? }
DELETE /api/memory/:id
```

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full list. Near-term priorities:

- [ ] IMAP inbox polling with AI triage (auto-classify urgency, draft replies)
- [ ] Vector memory with local embeddings (upgrade keyword search to semantic)
- [ ] Deep research mode (multi-step web search → synthesize → visual report)
- [ ] WebSocket PTY streaming for a proper in-browser terminal
- [ ] Multi-user auth (bcrypt + session tokens)
- [ ] CalDAV calendar integration

---

## Contributing

Issues and PRs welcome. See `.github/` for templates.

---

## License

MIT
