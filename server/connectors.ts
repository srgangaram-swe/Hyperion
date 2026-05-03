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
    connector("gmail", "Gmail", "email", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], "OAuth draft and inbox actions"),
    connector(
      "google-calendar",
      "Google Calendar",
      "calendar",
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      "Availability, agenda, and event actions"
    ),
    connector(
      "outlook",
      "Microsoft 365",
      "email",
      ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
      "Outlook mail and calendar actions"
    ),
    connector("slack", "Slack", "chat", ["SLACK_BOT_TOKEN"], "Channel summaries and notifications"),
    connector("tmux", "tmux Host", "shell", [], "Local session supervision placeholder")
  ];
}
