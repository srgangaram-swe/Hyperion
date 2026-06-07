/**
 * Persistent agent memory — SQLite-backed key/value + tagged fact store.
 *
 * Inspired by Odysseus's MemoryManager + MCP memory server pattern.
 * Agents can read from and write to this store during sessions; the UI
 * exposes it in a future Memory panel.
 *
 * Storage: data/memory.db (SQLite via Deno's built-in sqlite3 FFI or
 * a simple JSON flat-file fallback when sqlite3 is unavailable).
 */

import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const DATA_DIR = join(Deno.cwd(), "data");
const MEMORY_FILE = join(DATA_DIR, "memory.json");

export type MemoryCategory = "fact" | "preference" | "context" | "skill";

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  text: string;
  tags: string[];
  agentId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

// Persistence (JSON flat-file — no native sqlite3 dep required)

async function ensureDataDir() {
  try {
    await Deno.mkdir(DATA_DIR, { recursive: true });
  } catch {
    /* already exists */
  }
}

async function loadStore(): Promise<MemoryEntry[]> {
  try {
    const raw = await Deno.readTextFile(MEMORY_FILE);
    return JSON.parse(raw) as MemoryEntry[];
  } catch {
    return [];
  }
}

async function saveStore(entries: MemoryEntry[]): Promise<void> {
  await ensureDataDir();
  await Deno.writeTextFile(MEMORY_FILE, JSON.stringify(entries, null, 2));
}

// Public API

export async function listMemories(opts?: {
  category?: MemoryCategory;
  agentId?: string;
  limit?: number;
}): Promise<MemoryEntry[]> {
  let entries = await loadStore();

  if (opts?.category) entries = entries.filter((e) => e.category === opts.category);
  if (opts?.agentId)  entries = entries.filter((e) => e.agentId === opts.agentId);

  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return opts?.limit ? entries.slice(0, opts.limit) : entries;
}

export async function addMemory(opts: {
  category: MemoryCategory;
  text: string;
  tags?: string[];
  agentId?: string;
  sessionId?: string;
}): Promise<MemoryEntry> {
  const entries = await loadStore();
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    category: opts.category,
    text: opts.text.trim(),
    tags: opts.tags ?? [],
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  await saveStore(entries);
  return entry;
}

export async function editMemory(id: string, updates: Partial<Pick<MemoryEntry, "text" | "tags" | "category">>): Promise<MemoryEntry | null> {
  const entries = await loadStore();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;

  entries[idx] = { ...entries[idx], ...updates, updatedAt: new Date().toISOString() };
  await saveStore(entries);
  return entries[idx];
}

export async function deleteMemory(id: string): Promise<boolean> {
  const entries = await loadStore();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  await saveStore(next);
  return true;
}

export async function searchMemory(query: string, opts?: { limit?: number }): Promise<MemoryEntry[]> {
  const entries = await loadStore();
  const q = query.toLowerCase();

  // Simple keyword search — can be upgraded to vector search with ChromaDB or
  // a local embedding model in the future (see Odysseus MemoryVectorStore).
  const scored = entries
    .map((e) => {
      const haystack = `${e.text} ${e.tags.join(" ")} ${e.category}`.toLowerCase();
      const hits = q.split(/\s+/).filter((word) => haystack.includes(word)).length;
      return { entry: e, score: hits };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));

  const results = scored.map((r) => r.entry);
  return opts?.limit ? results.slice(0, opts.limit) : results;
}

/** Build a compact memory context string to prepend to an agent prompt. */
export async function buildMemoryContext(agentId?: string): Promise<string> {
  const facts = await listMemories({ category: "fact", limit: 20 });
  const prefs = await listMemories({ category: "preference", limit: 10 });
  const skills = await listMemories({ category: "skill", limit: 10 });

  const agentCtx = agentId ? await listMemories({ agentId, limit: 10 }) : [];

  const parts: string[] = [];
  if (facts.length)    parts.push(`Facts:\n${facts.map((e) => `- ${e.text}`).join("\n")}`);
  if (prefs.length)    parts.push(`Preferences:\n${prefs.map((e) => `- ${e.text}`).join("\n")}`);
  if (skills.length)   parts.push(`Skills:\n${skills.map((e) => `- ${e.text}`).join("\n")}`);
  if (agentCtx.length) parts.push(`Agent context:\n${agentCtx.map((e) => `- ${e.text}`).join("\n")}`);

  if (!parts.length) return "";
  return `--- Persistent Memory ---\n${parts.join("\n\n")}\n--- End Memory ---`;
}
