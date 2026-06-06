import type { TmuxSession, TmuxOutput } from "../shared/types.ts";

async function tmux(...args: string[]): Promise<{ out: string; err: string; ok: boolean }> {
  try {
    const proc = new Deno.Command("tmux", {
      args,
      stdout: "piped",
      stderr: "piped"
    });
    const { stdout, stderr, success } = await proc.output();
    return {
      out: new TextDecoder().decode(stdout).trim(),
      err: new TextDecoder().decode(stderr).trim(),
      ok: success
    };
  } catch {
    return { out: "", err: "tmux not found — install tmux or start a tmux server", ok: false };
  }
}

export async function listSessions(): Promise<TmuxSession[]> {
  const { out, ok } = await tmux("ls", "-F", "#{session_name}|#{session_windows}|#{session_attached}");
  if (!ok || !out) return [];

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached] = line.split("|");
      return { name: name ?? "", windows: Number(windows) || 1, attached: attached === "1" };
    });
}

export async function capturePane(sessionName: string): Promise<TmuxOutput> {
  const { out, ok } = await tmux("capture-pane", "-t", sessionName, "-p", "-e");
  return {
    session: sessionName,
    output: ok ? out : `[capture failed for: ${sessionName}]`,
    capturedAt: new Date().toISOString()
  };
}

export async function sendKeys(sessionName: string, keys: string): Promise<{ ok: boolean; err: string }> {
  const { ok, err } = await tmux("send-keys", "-t", sessionName, keys, "Enter");
  return { ok, err };
}

export async function newSession(name: string): Promise<{ ok: boolean; err: string }> {
  // Sanitise session name (tmux only allows alphanumeric + dash/underscore/dot)
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) || "hyperion";
  const { ok, err } = await tmux("new-session", "-d", "-s", safe);
  return { ok, err: ok ? "" : err };
}

export async function killSession(name: string): Promise<{ ok: boolean; err: string }> {
  const { ok, err } = await tmux("kill-session", "-t", name);
  return { ok, err: ok ? "" : err };
}

export async function renameSession(oldName: string, newName: string): Promise<{ ok: boolean; err: string }> {
  const safe = newName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  const { ok, err } = await tmux("rename-session", "-t", oldName, safe);
  return { ok, err: ok ? "" : err };
}

export { TmuxSession, TmuxOutput };
