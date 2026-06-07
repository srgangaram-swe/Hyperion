export function resolveFsPath(userPath: string, root?: string): string | null {
  const fsRoot = root ?? Deno.env.get("FS_ROOT") ?? Deno.cwd();
  if (!userPath || userPath === "." || userPath === "/") return fsRoot;
  const parts = userPath.replace(/\\/g, "/").split("/");
  const safe: string[] = [];
  for (const p of parts) {
    if (p === "..") safe.pop();
    else if (p && p !== ".") safe.push(p);
  }
  const resolved = `${fsRoot}/${safe.join("/")}`;
  if (!resolved.startsWith(fsRoot)) return null;
  return resolved;
}

export async function runInTmux(
  session: string,
  command: string,
  waitMs = 2000
): Promise<{ ok: boolean; output: string; err: string }> {
  try {
    const send = new Deno.Command("tmux", {
      args: ["send-keys", "-t", session, command, "Enter"],
      stdout: "piped",
      stderr: "piped",
    });
    const { success, stderr } = await send.output();
    if (!success) {
      return { ok: false, output: "", err: new TextDecoder().decode(stderr) };
    }
    await new Promise((r) => setTimeout(r, waitMs));
    const cap = new Deno.Command("tmux", {
      args: ["capture-pane", "-t", session, "-p", "-e"],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout } = await cap.output();
    return { ok: true, output: new TextDecoder().decode(stdout).trim(), err: "" };
  } catch (e) {
    return { ok: false, output: "", err: e instanceof Error ? e.message : String(e) };
  }
}
