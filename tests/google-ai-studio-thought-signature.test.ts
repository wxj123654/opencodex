import { beforeEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { __resetAntigravityReplayCache } from "../src/adapters/google-antigravity-replay";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const SIGNATURE = "CiQAx-ai-studio-thought-signature-0123456789abcdef";
const MODEL = "gemini-3.7-flash";
const BASE_URL = "https://generativelanguage.googleapis.com";

const provider = {
  adapter: "google",
  googleMode: "ai-studio",
  baseUrl: BASE_URL,
  apiKey: "ai-studio-test-key",
} as OcxProviderConfig;

// Existing configs predate googleMode and omit it; undefined must mean the same direct path.
const legacyProvider = { ...provider, googleMode: undefined } as OcxProviderConfig;

function request(messages: OcxParsedRequest["context"]["messages"], stream: boolean): OcxParsedRequest {
  return {
    modelId: MODEL,
    stream,
    context: {
      messages,
      systemPrompt: [],
      tools: [{ name: "shell_command", description: "run a command", parameters: { type: "object" } }],
    },
    options: {},
  } as unknown as OcxParsedRequest;
}

const firstTurn = (stream: boolean) => request([{ role: "user", content: "run pwd" }], stream);

const continuation = () => request([
  { role: "user", content: "run pwd" },
  {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call_shell_1",
      name: "shell_command",
      arguments: { command: "pwd" },
    }],
  },
  {
    role: "toolResult",
    toolCallId: "call_shell_1",
    toolName: "shell_command",
    content: "/workspace",
  },
], false);

function geminiResponseBody(): Record<string, unknown> {
  return {
    candidates: [{
      content: {
        role: "model",
        parts: [{
          functionCall: { name: "shell_command", args: { command: "pwd" } },
          thoughtSignature: SIGNATURE,
        }],
      },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  };
}

function replayedFunctionCall(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as { contents: Array<{ role?: string; parts?: Record<string, unknown>[] }> };
  const model = parsed.contents.find(content => content.role === "model");
  const part = model?.parts?.find(candidate => "functionCall" in candidate);
  if (!part) throw new Error("compiled direct request omitted the replayed functionCall");
  return part;
}

/**
 * Direct AI Studio stays OUT of the thought-signature replay cache, matching upstream:
 * observeAntigravityReplay is gated on googleMode "vertex" or "cloud-code-assist" on both
 * the streaming and non-streaming parse paths. A signature the model attaches to a
 * functionCall part is therefore not re-attached when the client replays the call on the
 * next tool-result turn. These tests pin that boundary so the mode gate is not widened by
 * accident; the replayed behavior itself is pinned in google-vertex-thought-signature.test.ts.
 */
describe("Direct AI Studio thought-signature replay", () => {
  beforeEach(() => __resetAntigravityReplayCache());

  test("streaming functionCall signature is not replayed on the next tool-result turn", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(firstTurn(true));
    const response = new Response(`data: ${JSON.stringify(geminiResponseBody())}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
    const events: AdapterEvent[] = [];
    for await (const event of firstAdapter.parseStream(response)) events.push(event);
    expect(events.some(event => event.type === "tool_call_start")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");

    const followup = await createGoogleAdapter(provider).buildRequest(continuation());
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBeUndefined();
  });

  test("non-streaming functionCall signature is not replayed", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(firstTurn(false));
    const events = await firstAdapter.parseResponse!(new Response(JSON.stringify(geminiResponseBody())));
    expect(events.some(event => event.type === "tool_call_start")).toBe(true);

    const followup = await createGoogleAdapter(provider).buildRequest(continuation());
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBeUndefined();
  });

  test("googleMode omitted (legacy configs) behaves the same way", async () => {
    const firstAdapter = createGoogleAdapter(legacyProvider);
    await firstAdapter.buildRequest(firstTurn(false));
    await firstAdapter.parseResponse!(new Response(JSON.stringify(geminiResponseBody())));

    const followup = await createGoogleAdapter(legacyProvider).buildRequest(continuation());
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBeUndefined();
  });

  test("signatures do not leak across direct-mode baseUrls", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(firstTurn(false));
    await firstAdapter.parseResponse!(new Response(JSON.stringify(geminiResponseBody())));

    const otherBackend = createGoogleAdapter({
      ...provider,
      baseUrl: "https://gemini-compatible-gateway.example.com",
    } as OcxProviderConfig);
    const followup = await otherBackend.buildRequest(continuation());
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBeUndefined();
  });

  test("a same-turn signature rejection does not poison later direct requests", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(firstTurn(false));
    await firstAdapter.parseResponse!(new Response(JSON.stringify(geminiResponseBody())));

    const rejecting = createGoogleAdapter(provider);
    await rejecting.buildRequest(firstTurn(true));
    const errorStream = new Response(
      `data: ${JSON.stringify({ error: { code: 400, message: "Function call is missing a thought_signature in functionCall parts", status: "INVALID_ARGUMENT" } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    const events: AdapterEvent[] = [];
    for await (const event of rejecting.parseStream(errorStream)) events.push(event);
    expect(events.some(event => event.type === "error")).toBe(true);

    const followup = await createGoogleAdapter(provider).buildRequest(continuation());
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBeUndefined();
  });
});
