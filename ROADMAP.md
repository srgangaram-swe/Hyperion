# Hyperion Roadmap

This is a living document. Items are roughly ordered by priority.

---

## Phase 1 — Core harness (current)

- [x] Multi-agent parallel sessions (OpenAI + Anthropic)
- [x] Real-time WebSocket token streaming
- [x] Red Matrix dark theme (canvas rain, scanlines, JetBrains Mono)
- [x] tmux session management (list, create, kill, send-keys, capture-pane)
- [x] AI email drafting with Claude (SSE stream, tone picker)
- [x] File context injection (drag-and-drop → prepend to prompt)
- [x] Persistent memory store (fact / preference / context / skill)
- [x] Live event stream rail (Signal Stream)
- [x] Mock mode (works without API keys)

---

## Phase 2 — Tool depth

- [ ] **IMAP email poller** — connect a real mailbox (IMAP), poll for new messages, classify urgency, auto-draft replies for human approval. Design modelled on Odysseus `email_pollers.py`.
- [ ] **WebSocket PTY** — replace polling-based tmux capture with a real PTY stream over WebSocket. Fully interactive terminal in the browser. Inspired by Odysseus `shell_routes.py` PTY implementation.
- [ ] **Vector memory** — upgrade keyword search to semantic search using a local embedding model. Inspired by Odysseus `MemoryVectorStore` (ChromaDB + fastembed).
- [ ] **Memory panel** — dedicated UI tab to view, search, edit, and delete memory entries.
- [ ] **Deep research mode** — multi-step agentic loop: decompose query → web search → read sources → synthesize → structured visual report. Adapted from Odysseus research handler pattern.
- [ ] **Tool approval flow** — when an agent proposes a tool call, show a diff-style approval card before executing. Human-in-the-loop for side effects.

---

## Phase 3 — Platform

- [ ] **Multi-user auth** — bcrypt passwords, session tokens with 7-day TTL, per-user memory isolation. Modelled on Odysseus `core/auth.py` + `AuthManager`.
- [ ] **CalDAV calendar** — read/write calendar events via CalDAV (Radicale / Nextcloud / Apple / Fastmail). Agents can schedule and query events.
- [ ] **MCP server support** — expose Hyperion tools (memory, tmux, email) as an MCP server so external agents can call them.
- [ ] **Webhook triggers** — accept inbound webhooks to start sessions automatically (e.g., new email arrives → start triage session).
- [ ] **Session persistence** — save sessions and run outputs to SQLite so they survive server restarts.
- [ ] **Model comparison mode** — send one prompt to Claude and GPT-4o simultaneously and compare responses side-by-side. Inspired by Odysseus Compare panel.

---

## Phase 4 — Infrastructure

- [ ] **Docker Compose packaging** — single `docker compose up` deployment with Deno inside a container.
- [ ] **Tailscale Serve integration** — private HTTPS access over your tailnet without port forwarding.
- [ ] **Local model support** — connect to Ollama or llama.cpp via an OpenAI-compatible endpoint. Zero API cost for daily tasks.
- [ ] **Notification channels** — ntfy / browser push / Slack notifications when long-running sessions complete.
- [ ] **2FA (TOTP)** — authenticator-app second factor for multi-user deployments.

---

## Inspirations

- [Odysseus](https://github.com/srgangaram-swe/odysseus) — self-hosted AI workspace (Python/FastAPI). Source of IMAP email design, PTY streaming, vector memory pattern, deep research flow, and auth architecture.
- Anthropic Claude API — primary inference for reasoning, drafting, and research.
- OpenAI Responses API — parallel inference and model comparison.
