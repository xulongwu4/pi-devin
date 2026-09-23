import assert from "node:assert/strict";
import test from "node:test";

const { mapContextToChat } = await import("../.test-dist/src/context-map.js");
const { normalizeContext } = await import("@earendil-works/pi-ai");

const SENTINEL_PROMPT = "SENTINEL-SYSTEM-PROMPT-9f3a";
const SENTINEL_TOOL = "sentinel_tool_9f3a";

test("transcript system message and toolsAdded reach the mapped request", () => {
  const transcript = normalizeContext({
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  });
  // Prompt/tool updates arrive as later system messages in a Pi 0.87 transcript.
  transcript.messages.push({
    role: "system",
    content: SENTINEL_PROMPT,
    toolsAdded: [
      {
        name: SENTINEL_TOOL,
        description: "sentinel",
        parameters: { type: "object", properties: {} },
      },
    ],
    timestamp: 2,
  });

  const mapped = mapContextToChat(transcript);

  // Devin's wire format gets one collapsed leading system message, not a mid-conversation one.
  assert.equal(mapped.messages.filter((message) => message.role === "system").length, 1);
  assert.match(mapped.messages[0].content, new RegExp(SENTINEL_PROMPT));
  assert.deepEqual(mapped.tools.map((tool) => tool.name), [SENTINEL_TOOL]);
  assert.equal(mapped.messages.at(-1).content, "hello");
});

test("leading system message survives without duplicate system entries", () => {
  const transcript = normalizeContext({
    systemPrompt: "base prompt",
    messages: [
      { role: "user", content: "hi", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok", timestamp: 1 }],
        api: "devin",
        provider: "devin",
        model: "swe-1-6",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 2,
      },
    ],
  });

  const mapped = mapContextToChat(transcript);

  assert.equal(mapped.messages.filter((message) => message.role === "system").length, 1);
  assert.equal(mapped.messages[0].content, "base prompt");
  assert.deepEqual(
    mapped.messages.slice(1).map((message) => message.role),
    ["user", "assistant"],
  );
});