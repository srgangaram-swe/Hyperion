import type { AgentConfig } from "../shared/types.ts";

export function providerConfigured(provider: AgentConfig["provider"]) {
  if (provider === "openai") {
    return Boolean(Deno.env.get("OPENAI_API_KEY")?.trim());
  }

  if (provider === "anthropic") {
    return Boolean(Deno.env.get("ANTHROPIC_API_KEY")?.trim());
  }

  return true;
}

export async function* streamAgentResponse(agent: AgentConfig, prompt: string, signal: AbortSignal) {
  if (agent.provider === "openai" && providerConfigured("openai")) {
    yield* streamOpenAI(agent, prompt, signal);
    return;
  }

  if (agent.provider === "anthropic" && providerConfigured("anthropic")) {
    yield* streamAnthropic(agent, prompt, signal);
    return;
  }

  yield* streamMock(agent, prompt, signal);
}

async function* streamOpenAI(agent: AgentConfig, prompt: string, signal: AbortSignal) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: agent.model,
      instructions: agent.systemPrompt,
      input: prompt,
      stream: true
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
  }

  for await (const event of readSseJson(response, signal)) {
    throwIfAborted(signal);

    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      yield event.delta;
    }

    if (event?.type === "response.refusal.delta" && typeof event.delta === "string") {
      yield event.delta;
    }

    if (event?.type === "error") {
      throw new Error(event.message || event.error?.message || "OpenAI stream error");
    }
  }
}

async function* streamAnthropic(agent: AgentConfig, prompt: string, signal: AbortSignal) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") || "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: Number(Deno.env.get("AGENT_MAX_TOKENS") || 1800),
      system: agent.systemPrompt,
      messages: [{ role: "user", content: prompt }],
      stream: true
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
  }

  for await (const event of readSseJson(response, signal)) {
    throwIfAborted(signal);

    if (
      event?.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      typeof event.delta.text === "string"
    ) {
      yield event.delta.text;
    }

    if (event?.type === "error") {
      throw new Error(event.error?.message || "Anthropic stream error");
    }
  }
}

async function* streamMock(agent: AgentConfig, prompt: string, signal: AbortSignal) {
  const chunks = createMockChunks(agent, prompt);

  for (const chunk of chunks) {
    throwIfAborted(signal);
    await delay(180, signal);
    yield chunk;
  }
}

function createMockChunks(agent: AgentConfig, prompt: string) {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  const shortPrompt = trimmed.length > 140 ? `${trimmed.slice(0, 140)}...` : trimmed;

  const byAgent: Record<string, string[]> = {
    architect: [
      `Mock ${agent.name} pass for: "${shortPrompt}"\n\n`,
      "Architecture slice:\n",
      "- Static Conductor UI for live visibility\n",
      "- Deno orchestrator for session state\n",
      "- Provider adapters for OpenAI, Claude, and local simulations\n",
      "- WebSocket stream for run deltas and event history\n",
      "- Connector boundary for email, calendar, chat, shell, and future OAuth\n\n",
      "Next useful milestone: persist sessions and add a tool permission model.\n"
    ],
    builder: [
      `Mock ${agent.name} pass for: "${shortPrompt}"\n\n`,
      "Implementation path:\n",
      "1. Keep provider SDKs behind one streaming interface.\n",
      "2. Emit every token delta over WebSocket.\n",
      "3. Store runs by session so the GUI can rehydrate after refresh.\n",
      "4. Add connector workers only after the user approves side effects.\n"
    ],
    operator: [
      `Mock ${agent.name} pass for: "${shortPrompt}"\n\n`,
      "Operational route:\n",
      "- Triage incoming requests\n",
      "- Pick agents and tools\n",
      "- Draft email/calendar actions\n",
      "- Require review before sending or modifying real-world data\n"
    ],
    critic: [
      `Mock ${agent.name} pass for: "${shortPrompt}"\n\n`,
      "Pressure test:\n",
      "- Avoid API keys in browser code\n",
      "- Treat email/calendar actions as privileged side effects\n",
      "- Capture audit logs for every tool call\n",
      "- Rate-limit parallel runs before this becomes expensive\n"
    ]
  };

  return byAgent[agent.id] ?? byAgent.operator;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Run cancelled");
  }
}

async function* readSseJson(response: Response, signal: AbortSignal): AsyncGenerator<any> {
  if (!response.body) {
    throw new Error("Provider returned an empty stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    throwIfAborted(signal);
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const parsed = parseSsePart(part);

      if (parsed === "[DONE]") {
        return;
      }

      if (parsed) {
        yield parsed;
      }
    }
  }

  const parsed = parseSsePart(buffer);

  if (parsed && parsed !== "[DONE]") {
    yield parsed;
  }
}

function parseSsePart(part: string): any | "[DONE]" | null {
  const data = part
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data) {
    return null;
  }

  if (data === "[DONE]") {
    return "[DONE]";
  }

  return JSON.parse(data);
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Run cancelled"));
      },
      { once: true }
    );
  });
}
