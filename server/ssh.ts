import type { SshConnection, SshCommandResult } from "../shared/types.ts";

const DATA_PATH = "./data/ssh-connections.json";

async function load(): Promise<SshConnection[]> {
  try {
    return JSON.parse(await Deno.readTextFile(DATA_PATH)) as SshConnection[];
  } catch {
    return [];
  }
}

async function persist(list: SshConnection[]): Promise<void> {
  try { await Deno.mkdir("./data", { recursive: true }); } catch { /* exists */ }
  await Deno.writeTextFile(DATA_PATH, JSON.stringify(list, null, 2));
}

export async function listSshConnections(): Promise<SshConnection[]> {
  return load();
}

export async function getSshConnection(id: string): Promise<SshConnection | null> {
  const list = await load();
  return list.find((c) => c.id === id) ?? null;
}

export async function addSshConnection(
  fields: Omit<SshConnection, "id" | "createdAt">
): Promise<SshConnection> {
  const list = await load();
  const conn: SshConnection = {
    ...fields,
    id: `ssh-${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  };
  list.push(conn);
  await persist(list);
  return conn;
}

export async function editSshConnection(
  id: string,
  patch: Partial<Omit<SshConnection, "id" | "createdAt">>
): Promise<SshConnection | null> {
  const list = await load();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  await persist(list);
  return list[idx];
}

export async function deleteSshConnection(id: string): Promise<boolean> {
  const list = await load();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  await persist(next);
  return true;
}

export async function runSshCommand(
  conn: SshConnection,
  command: string,
  timeoutMs = 30_000
): Promise<SshCommandResult> {
  const args = buildArgs(conn, command);
  try {
    const proc = new Deno.Command("ssh", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await Promise.race([
      proc.output(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSH command timed out")), timeoutMs)
      ),
    ]);
    return {
      ok: result.success,
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
      exitCode: result.code ?? 0,
    };
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      exitCode: -1,
    };
  }
}

export async function testSshConnection(conn: SshConnection): Promise<SshCommandResult> {
  return runSshCommand(conn, "echo HYPERION_OK && uname -a", 10_000);
}

export async function openSshInTmux(
  conn: SshConnection,
  tmuxSession: string
): Promise<{ ok: boolean; err: string }> {
  const sshCmd = buildCommandString(conn);
  try {
    const proc = new Deno.Command("tmux", {
      args: ["new-window", "-t", tmuxSession, "-n", `ssh:${conn.label}`, sshCmd],
      stdout: "piped",
      stderr: "piped",
    });
    const { success, stderr } = await proc.output();
    return { ok: success, err: success ? "" : new TextDecoder().decode(stderr).trim() };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

function buildArgs(conn: SshConnection, command: string): string[] {
  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
  ];
  if (conn.port && conn.port !== 22) args.push("-p", String(conn.port));
  if (conn.keyPath) args.push("-i", conn.keyPath);
  args.push(`${conn.user}@${conn.host}`, command);
  return args;
}

function buildCommandString(conn: SshConnection): string {
  const parts = ["ssh", "-o", "StrictHostKeyChecking=no"];
  if (conn.port && conn.port !== 22) parts.push("-p", String(conn.port));
  if (conn.keyPath) parts.push("-i", conn.keyPath);
  parts.push(`${conn.user}@${conn.host}`);
  return parts.join(" ");
}
