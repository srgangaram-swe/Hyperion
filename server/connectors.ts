import type { ConnectorStatus } from "../shared/types.ts";

function hasEnv(keys: string[]) {
  return keys.every((key) => Boolean(Deno.env.get(key)?.trim()));
}

function connector(
  id: ConnectorStatus["id"],
  name: ConnectorStatus["name"],
  kind: ConnectorStatus["kind"],
  envVars: string[],
  detail: string
): ConnectorStatus {
  return {
    id,
    name,
    kind,
    envVars,
    detail,
    status: envVars.length === 0 ? "mock" : hasEnv(envVars) ? "ready" : "needs_env"
  };
}

export function getConnectors(): ConnectorStatus[] {
  return [
    // Email — IMAP/SMTP (inspired by Odysseus email_routes.py + email_pollers.py)
    connector("gmail", "Gmail / IMAP", "email",
      ["IMAP_HOST", "IMAP_USER", "IMAP_PASS"],
      "IMAP fetch + AI triage + Claude-drafted replies"),

    connector("smtp", "SMTP Send", "email",
      ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"],
      "Send approved email drafts via SMTP"),

    connector("google-calendar", "Google Calendar", "calendar",
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      "Availability, agenda, and event actions"),

    connector("outlook", "Microsoft 365", "email",
      ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
      "Outlook mail and calendar via MS Graph"),

    connector("slack", "Slack", "chat",
      ["SLACK_BOT_TOKEN"],
      "Channel summaries and agent notifications"),

    // tmux — always available on POSIX (see server/tmux.ts)
    connector("tmux", "tmux Host", "shell", [],
      "Live terminal session management + PTY streaming"),
  ];
}
