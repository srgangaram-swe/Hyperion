import type { AgentConfig } from "../shared/types.ts";

const DATA_PATH = "./data/custom-agents.json";

async function load(): Promise<AgentConfig[]> {
  try {
    const text = await Deno.readTextFile(DATA_PATH);
    return JSON.parse(text) as AgentConfig[];
  } catch {
    return [];
  }
}

async function persist(list: AgentConfig[]): Promise<void> {
  try { await Deno.mkdir("./data", { recursive: true }); } catch { /* exists */ }
  await Deno.writeTextFile(DATA_PATH, JSON.stringify(list, null, 2));
}

export async function listCustomAgents(): Promise<AgentConfig[]> {
  return load();
}

export async function addCustomAgent(fields: Omit<AgentConfig, "id">): Promise<AgentConfig> {
  const list = await load();
  const agent: AgentConfig = { ...fields, id: `custom-${crypto.randomUUID().slice(0, 8)}` };
  list.push(agent);
  await persist(list);
  return agent;
}

export async function editCustomAgent(id: string, patch: Partial<Omit<AgentConfig, "id">>): Promise<AgentConfig | null> {
  const list = await load();
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  await persist(list);
  return list[idx];
}

export async function deleteCustomAgent(id: string): Promise<boolean> {
  const list = await load();
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return false;
  await persist(next);
  return true;
}
