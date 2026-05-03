# Conductor

A local dashboard for running multiple AI agents in parallel and watching their output stream into one GUI.

## What Works Now

- Send one prompt to several agents at once.
- Stream OpenAI Responses API output and Anthropic Messages API output into live cards.
- Fall back to mock streaming when API keys are missing, so the UI works immediately.
- Track sessions, per-agent status, event history, and connector readiness.
- Abort an in-flight session from the dashboard.

## Run Locally

```bash
cp .env.example .env
deno task dev
```

Open `http://127.0.0.1:8787`.

Without keys, OpenAI and Claude agents run in mock mode. Add these to `.env` when ready:

```bash
OPENAI_API_KEY="..."
ANTHROPIC_API_KEY="..."
```

## Architecture

- `server/main.ts` serves the REST API, WebSocket events, and static dashboard.
- `server/providers.ts` contains streaming adapters for OpenAI, Anthropic, and mock agents.
- `server/agents.ts` defines the default agent roster.
- `server/connectors.ts` reports connector readiness for future email/calendar/chat integrations.
- `public/app.js` is the real-time Conductor UI.
- `shared/types.ts` keeps frontend/backend contracts aligned.

## Private GitHub Repo

From this directory:

```bash
git init
git add .
git commit -m "Initial Conductor MVP"
gh repo create conductor --private --source=. --remote=origin --push
```

If you do not use the GitHub CLI:

```bash
git init
git add .
git commit -m "Initial Conductor MVP"
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/conductor.git
git push -u origin main
```

Create the empty private repo on GitHub before the last two commands in the non-CLI flow.
