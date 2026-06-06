# Hyperion Python Services

Two optional Python microservices that extend the core Deno server with
capabilities that have no mature Deno equivalent.

---

## `vector_memory/` — Semantic search

Wraps `sentence-transformers` + ChromaDB to give Hyperion semantic vector
search on top of its JSON memory store. The Deno server proxies
`GET /api/memory?q=...` here when `VECTOR_MEMORY_URL` is set; it falls back
to keyword search otherwise.

**Stack:** FastAPI · sentence-transformers (`all-MiniLM-L6-v2`) · ChromaDB

### Setup

```bash
cd services/vector_memory
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8788 --reload
```

Then add to your root `.env`:

```
VECTOR_MEMORY_URL=http://127.0.0.1:8788
```

The service auto-persists its ChromaDB to `services/vector_memory/data/chroma/`.

### Sync existing memories

After starting the service, call the sync endpoint to import existing entries
from the Deno JSON store:

```bash
# From the repo root (Deno server must be running)
curl -s http://127.0.0.1:8787/api/memory | \
  jq '[.entries[] | {id, category, text, tags}]' | \
  curl -s -X POST http://127.0.0.1:8788/sync \
       -H "Content-Type: application/json" -d @-
```

---

## `email_poller/` — IMAP inbox watcher

Python daemon that polls an IMAP mailbox for new (UNSEEN) messages and
forwards each one to the Deno server via `POST /api/webhooks/email`. The
Deno server emits the email as a Signal Stream event and can optionally
start an AI triage session.

**Stack:** `imaplib` (stdlib) · `httpx`

### Setup

```bash
cd services/email_poller
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Add to your root `.env`:

```
IMAP_HOST=imap.gmail.com
IMAP_USER=you@gmail.com
IMAP_PASS=your-app-password
IMAP_PORT=993
IMAP_MAILBOX=INBOX
EMAIL_POLL_INTERVAL=60
EMAIL_AUTO_TRIAGE=false
HYPERION_URL=http://127.0.0.1:8787
```

> For Gmail: enable 2FA and generate an **App Password** at
> myaccount.google.com/apppasswords. Use that password as `IMAP_PASS`.

Set `EMAIL_AUTO_TRIAGE=true` to have the Deno server automatically start
a Claude session to classify urgency and draft a reply for each new email.

---

## Running both services alongside the Deno server

```bash
# Terminal 1 — Deno server
deno task dev

# Terminal 2 — vector memory
cd services/vector_memory && uvicorn main:app --port 8788

# Terminal 3 — email poller
cd services/email_poller && python main.py
```

Or use the tmux panel inside Hyperion itself to manage all three sessions.
