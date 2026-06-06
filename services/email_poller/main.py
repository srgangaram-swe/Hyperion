"""
Hyperion Email Poller

Python daemon that watches an IMAP mailbox for new messages and forwards
each one to the Deno server via the /api/webhooks/email endpoint.
The Deno server then emits the email as a WebSocket event (visible in
the Signal Stream) and can optionally trigger an AI triage session.

Config is read from environment variables (set in the root .env file).

Run:
    python main.py
"""

from __future__ import annotations

import email
import imaplib
import json
import logging
import os
import time
from email.header import decode_header
from pathlib import Path

import httpx

logging.basicConfig(
    level=logging.INFO,
    format="[EMAIL POLLER] %(asctime)s %(levelname)s — %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

IMAP_HOST        = os.getenv("IMAP_HOST", "")
IMAP_USER        = os.getenv("IMAP_USER", "")
IMAP_PASS        = os.getenv("IMAP_PASS", "")
IMAP_PORT        = int(os.getenv("IMAP_PORT", "993"))
IMAP_MAILBOX     = os.getenv("IMAP_MAILBOX", "INBOX")
POLL_INTERVAL    = int(os.getenv("EMAIL_POLL_INTERVAL", "60"))
HYPERION_URL     = os.getenv("HYPERION_URL", "http://127.0.0.1:8787")
SEEN_PATH        = Path(os.getenv("SEEN_IDS_PATH", "./data/seen_ids.json"))
AUTO_TRIAGE      = os.getenv("EMAIL_AUTO_TRIAGE", "false").lower() == "true"

# ── Seen-ID persistence ───────────────────────────────────────────────────────

def load_seen() -> set[str]:
    if SEEN_PATH.exists():
        try:
            return set(json.loads(SEEN_PATH.read_text()))
        except Exception:
            pass
    return set()

def save_seen(seen: set[str]) -> None:
    SEEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEEN_PATH.write_text(json.dumps(sorted(seen)))

# ── Email parsing ─────────────────────────────────────────────────────────────

def _decode_header_value(raw: str) -> str:
    parts = decode_header(raw or "")
    out = []
    for fragment, charset in parts:
        if isinstance(fragment, bytes):
            out.append(fragment.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(fragment)
    return " ".join(out).strip()

def parse_message(raw_bytes: bytes) -> dict:
    msg = email.message_from_bytes(raw_bytes)

    subject = _decode_header_value(msg.get("Subject", "(no subject)"))
    sender  = _decode_header_value(msg.get("From", ""))
    date    = msg.get("Date", "")
    msg_id  = msg.get("Message-ID", "")

    # Extract plain-text body (prefer text/plain over HTML)
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/plain" and not body:
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    body = payload.decode(charset, errors="replace")
            elif ct == "text/html" and not body:
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    body = payload.decode(charset, errors="replace")
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            body = payload.decode(charset, errors="replace")

    return {
        "messageId": msg_id,
        "subject": subject,
        "from": sender,
        "date": date,
        "body": body[:5000],        # truncate for safety
        "autoTriage": AUTO_TRIAGE,
    }

# ── IMAP polling ──────────────────────────────────────────────────────────────

def poll_once(seen: set[str], client: httpx.Client) -> set[str]:
    if not all([IMAP_HOST, IMAP_USER, IMAP_PASS]):
        log.warning("IMAP credentials missing — set IMAP_HOST, IMAP_USER, IMAP_PASS in .env")
        return seen

    try:
        with imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT) as imap:
            imap.login(IMAP_USER, IMAP_PASS)
            imap.select(IMAP_MAILBOX, readonly=True)

            # Search for all unseen messages
            _, data = imap.search(None, "UNSEEN")
            uids = [u.decode() for u in data[0].split() if data[0]]

            new_count = sum(1 for u in uids if u not in seen)
            if new_count:
                log.info(f"Found {new_count} new message(s)")

            for uid in uids:
                if uid in seen:
                    continue

                _, msg_data = imap.fetch(uid, "(RFC822)")
                for response_part in msg_data:
                    if not isinstance(response_part, tuple):
                        continue
                    parsed = parse_message(response_part[1])
                    forward_to_hyperion(parsed, client)
                    seen.add(uid)

            save_seen(seen)

    except imaplib.IMAP4.error as exc:
        log.error(f"IMAP auth/protocol error: {exc}")
    except OSError as exc:
        log.error(f"Network error: {exc}")
    except Exception as exc:
        log.exception(f"Unexpected error during poll: {exc}")

    return seen


def forward_to_hyperion(parsed: dict, client: httpx.Client) -> None:
    subject = parsed.get("subject", "")
    try:
        resp = client.post(
            f"{HYPERION_URL}/api/webhooks/email",
            json=parsed,
            timeout=10.0,
        )
        if resp.status_code < 300:
            log.info(f"Forwarded: {subject!r}")
        else:
            log.warning(f"Hyperion returned {resp.status_code} for {subject!r}: {resp.text[:200]}")
    except httpx.ConnectError:
        log.error(f"Cannot reach Hyperion at {HYPERION_URL} — is it running?")
    except Exception as exc:
        log.error(f"Failed to forward {subject!r}: {exc}")

# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    if not IMAP_HOST:
        log.warning("IMAP_HOST not set — poller will run but skip every cycle until configured")

    log.info(f"Polling {IMAP_HOST or '(unconfigured)'} every {POLL_INTERVAL}s → {HYPERION_URL}")
    log.info(f"Auto-triage: {'enabled' if AUTO_TRIAGE else 'disabled'}")

    seen = load_seen()

    with httpx.Client() as client:
        while True:
            seen = poll_once(seen, client)
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
