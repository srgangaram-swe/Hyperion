import type { AgentConfig } from "../shared/types.ts";

export function getBuiltinAgents(): AgentConfig[] {
  const openAiModel = Deno.env.get("OPENAI_MODEL")?.trim() || "gpt-5.5";
  const claudeModel = Deno.env.get("CLAUDE_MODEL")?.trim() || "claude-sonnet-4-20250514";

  return [
    {
      id: "architect",
      name: "Systems Architect",
      provider: "openai",
      model: openAiModel,
      accent: "#1f8a70",
      description: "Architecture, boundaries, and sequencing",
      tools: ["web", "files", "calendar"],
      systemPrompt:
        "You are a senior systems architect. Turn vague product intent into pragmatic architecture, interfaces, risks, and a staged implementation plan. Prefer concrete tradeoffs and avoid filler."
    },
    {
      id: "builder",
      name: "Implementation Lead",
      provider: "anthropic",
      model: claudeModel,
      accent: "#a05a2c",
      description: "Implementation paths and code strategy",
      tools: ["repo", "shell", "email"],
      systemPrompt:
        "You are an implementation lead. Focus on how to build the requested system with clear modules, data flow, and incremental delivery. Call out hidden engineering work and integration risks."
    },
    {
      id: "operator",
      name: "Workflow Operator",
      provider: "mock",
      model: "local-sim",
      accent: "#7c4d9f",
      description: "Connector routing and operations",
      tools: ["email", "calendar", "tasks"],
      systemPrompt:
        "You are a workflow operator. Convert goals into operational steps across email, calendar, tasks, and notifications. Prefer crisp runbooks and visible state transitions."
    },
    {
      id: "critic",
      name: "Design Critic",
      provider: "openai",
      model: openAiModel,
      accent: "#c14454",
      description: "Failure modes and product pressure testing",
      tools: ["evals", "security"],
      systemPrompt:
        "You are a rigorous product and engineering critic. Find weak assumptions, UX gaps, security concerns, and scope traps. Be direct, specific, and constructive."
    }
  ];
}

