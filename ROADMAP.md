# Hyperion Z Roadmap

This is a living document. Items are roughly ordered by priority within each phase.

---

## Phase 1 — Core harness (complete)

- [x] Multi-agent parallel sessions (OpenAI + Anthropic)
- [x] Real-time WebSocket token streaming
- [x] Red Matrix dark theme (canvas rain visible through semi-transparent panels, scanlines, JetBrains Mono)
- [x] tmux session management (list, create, kill, send-keys, capture-pane)
- [x] AI email drafting with Claude (SSE stream, tone picker)
- [x] File context injection (drag-and-drop, prepend to prompt)
- [x] Persistent memory store (fact, preference, context, skill)
- [x] Live event stream rail (Signal Stream)
- [x] Mock mode (works without API keys)
- [x] SSH connection manager (saved connections, open in tmux window)
- [x] Custom agents panel (create, edit, delete agents with full config)
- [x] Code panel with Monaco editor and workspace file tree
- [x] Autopilot meta-agent orchestrator (single prompt to multi-agent pipeline)
- [x] Autopilot tool-use loop: `fs_read`, `fs_write`, `fs_list`, `tmux_run`
- [x] Parallel and serial agent execution based on dependency graph
- [x] Human-in-the-loop steering (pause, modify task, resume)
- [x] Per-run written file tracking with green chip UI
- [x] Hyperion Z Diff (git diff for all session-written files, rendered in Code panel)
- [x] Self-improvement capability (Hyperion Z Autopilot successfully improving its own codebase)

---

## Phase 2 — Tool depth

- [ ] **WebSocket PTY** — replace polling-based tmux capture with a real PTY stream over WebSocket; fully interactive terminal in the browser with keyboard input, resize events, and ANSI rendering
- [ ] **Vector memory** — upgrade keyword search to semantic search using a local embedding model (sentence-transformers + ChromaDB); drop-in replacement for the current JSON keyword filter
- [ ] **Memory panel UI** — dedicated tab to view, search, filter by category and tag, edit, and delete memory entries
- [ ] **IMAP inbox poller** — connect a real mailbox, poll for new messages (UNSEEN flag), classify urgency with Claude, auto-draft replies for human approval before send
- [ ] **Deep research mode** — multi-step agentic loop: decompose query, search the web, read sources, synthesize findings, produce a structured visual report; designed as a specialist Autopilot plan type
- [ ] **Tool approval flow** — before executing any Autopilot tool call with side effects (writes, shell commands), show a diff-style approval card; human approves or rejects each step

---

## Phase 3 — Platform

- [ ] **Session persistence** — save sessions, runs, and output to SQLite so they survive server restarts; session list persists across reboots
- [ ] **Model comparison mode** — send one prompt to Claude and GPT-4o simultaneously and compare responses side-by-side in the Code panel
- [ ] **Multi-user auth** — bcrypt password hashing, session tokens with 7-day TTL, per-user memory isolation; single-user mode remains default
- [ ] **MCP server** — expose Hyperion Z tools (memory, tmux, file access, email) as a Model Context Protocol server so external agents and tools can call them
- [ ] **Webhook triggers** — accept inbound webhooks (email arrival, CI event, cron) to start Autopilot sessions automatically
- [ ] **CalDAV calendar integration** — read and write calendar events via CalDAV (compatible with Radicale, Nextcloud, Apple Calendar, Fastmail)

---

## Phase 4 — Infrastructure

- [ ] **Docker Compose packaging** — single `docker compose up` deploys the Deno server and optional Python services in containers; no Deno install required on the host
- [ ] **Tailscale Serve integration** — private HTTPS access over your tailnet without any port forwarding or public exposure
- [ ] **Local model support** — connect to Ollama or llama.cpp via an OpenAI-compatible endpoint for zero API cost on daily tasks
- [ ] **Notification channels** — ntfy, browser push, and Slack notifications when long-running Autopilot sessions complete
- [ ] **2FA (TOTP)** — authenticator-app second factor for multi-user deployments

---

## Phase 5 — Agentic depth

- [ ] **Autopilot agent plugins** — define new agent archetypes (Security Auditor, Data Analyst, Documentation Writer) as JSON or TypeScript plugins without touching core code
- [ ] **Long-horizon memory** — automatic summarisation and archiving of completed sessions into persistent context so agents accumulate project knowledge over time
- [ ] **Dependency graph visualiser** — render the Autopilot pipeline as a live directed acyclic graph in the UI; nodes pulse as agents run and turn green on completion
- [ ] **Agent-to-agent messaging** — allow running agents to send typed messages to sibling agents in the same session without writing to intermediate files
- [ ] **Evaluation harness** — run a set of predefined goal prompts against the Autopilot engine and score output quality; track regressions across versions

---

## Completed milestones

| Date | Milestone |
|------|-----------|
| May 2026 | Initial Conductor MVP |
| Jun 2026 | Phase 1 complete: Red Matrix UI, tmux, email, memory, WebSocket |
| Jun 2026 | SSH manager, custom agents panel, Code panel with Monaco |
| Jun 2026 | Autopilot meta-agent orchestrator with parallel/serial execution |
| Jun 2026 | Human-in-the-loop steering, written-file tracking, Hyperion Z Diff |
| Jun 2026 | Self-improvement demo: Hyperion Z improved its own orchestrator from a single prompt |
