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

  // Later instructions stay after the user message, using Devin's existing text envelope.
  assert.deepEqual(mapped.messages, [
    { role: "user", content: "hello" },
    { role: "user", content: `<system>\n${SENTINEL_PROMPT}\n</system>` },
  ]);
  assert.deepEqual(mapped.tools.map((tool) => tool.name), [SENTINEL_TOOL]);
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

test("section updates and removals preserve the mapped prefix and transcript", () => {
  const transcript = {
    messages: [
      { role: "system", content: "base", sections: { rules: "old rules", obsolete: "old catalog" }, timestamp: 0 },
      { role: "user", content: "hello", timestamp: 1 },
    ],
  };
  const initial = mapContextToChat(transcript);
  transcript.messages.push({
    role: "system", content: [{ type: "text", text: "additional instructions" }],
    sections: { rules: "new rules", obsolete: null, mcp_servers: "new servers" }, timestamp: 2,
  });
  const original = structuredClone(transcript);
  const updated = mapContextToChat(transcript);
  assert.deepEqual(transcript, original);
  assert.deepEqual(updated.messages.slice(0, initial.messages.length), initial.messages);
  assert.equal(updated.messages.at(-1).content,
    '<system>\nadditional instructions\n\nUpdated system prompt section "rules":\n\nnew rules' +
    '\n\nRemoved system prompt section "obsolete".' +
    '\n\nUpdated system prompt section "mcp_servers":\n\nnew servers\n</system>');

  transcript.messages.push(
    { role: "system", content: "", sections: { rules: "" }, timestamp: 3 },
    { role: "user", content: "next turn", timestamp: 4 },
  );
  const resumed = mapContextToChat(JSON.parse(JSON.stringify(transcript)));
  assert.deepEqual(resumed.messages.slice(0, updated.messages.length), updated.messages);
  assert.equal(resumed.messages.at(-2).content, '<system>\nUpdated system prompt section "rules":\n\n\n</system>');
  assert.equal(resumed.messages.at(-1).content, "next turn");
});

test("tool-only system deltas keep current definitions without adding empty messages", () => {
  const oldTool = { name: "old", description: "old", parameters: { type: "object" } };
  const newTool = { ...oldTool, name: "new" };
  const transcript = {
    messages: [
      { role: "system", content: "base", toolsAdded: [oldTool], timestamp: 0 },
      { role: "user", content: "hello", timestamp: 1 },
    ],
  };
  const initial = mapContextToChat(transcript);
  transcript.messages.push(
    { role: "system", content: "", toolsAdded: [newTool], toolsRemoved: [{ name: "old" }], timestamp: 2 },
    { role: "system", content: "", timestamp: 3 },
  );
  const mapped = mapContextToChat(transcript);
  assert.deepEqual(mapped.messages, initial.messages);
  assert.deepEqual(mapped.tools, [newTool]);
});

test("updates wait for all parallel tool results and preserve their order", () => {
  const transcript = normalizeContext({
    systemPrompt: "base",
    messages: [{ role: "user", content: "lookup both", timestamp: 1 }],
  });
  transcript.messages.push(
    { role: "assistant", content: ["a", "b"].map((id) => ({ type: "toolCall", id, name: "lookup", arguments: {} })), timestamp: 2 },
    { role: "system", content: "first update", timestamp: 3 },
    { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "result b" }], timestamp: 4 },
    { role: "system", content: "second update", timestamp: 5 },
    { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "result a" }], timestamp: 6 },
  );
  const original = structuredClone(transcript);
  const mapped = mapContextToChat(transcript);
  assert.deepEqual(mapped.messages.map((message) => message.role), ["system", "user", "assistant", "tool", "tool", "user", "user"]);
  assert.deepEqual(mapped.messages.slice(3).map((message) => message.content), [
    "result b", "result a", "<system>\nfirst update\n</system>", "<system>\nsecond update\n</system>",
  ]);
  assert.deepEqual(transcript, original);
  // A second tool turn must get its own pending-call state.
  transcript.messages.push(
    { role: "assistant", content: [{ type: "toolCall", id: "c", name: "lookup", arguments: {} }], timestamp: 7 },
    { role: "system", content: "third update", timestamp: 8 },
    { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "result c" }], timestamp: 9 },
  );
  const next = mapContextToChat(transcript);
  assert.deepEqual(next.messages.slice(0, mapped.messages.length), mapped.messages);
  assert.deepEqual(next.messages.slice(-2).map((message) => message.content), ["result c", "<system>\nthird update\n</system>"]);
});

test("updates after missing tool results are released at transcript end", () => {
  const mapped = mapContextToChat({ messages: [
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "missing", name: "lookup", arguments: {} }], timestamp: 1 },
    { role: "system", content: "update", timestamp: 2 },
  ] });
  assert.deepEqual(mapped.messages.map((message) => message.role), ["assistant", "user"]);
  assert.equal(mapped.messages[1].content, "<system>\nupdate\n</system>");
});

test("legacy transcripts render the first system snapshot in place and subsequent deltas by name", () => {
  const transcript = { messages: [{ role: "user", content: "old history", timestamp: 1 }] };
  const initial = mapContextToChat(transcript);
  transcript.messages.push(
    { role: "system", content: "base", sections: { rules: "rules", absent: null }, timestamp: 2 },
    { role: "system", content: "", sections: { rules: "replacement" }, timestamp: 3 },
  );
  const mapped = mapContextToChat(transcript);
  assert.deepEqual(mapped.messages.slice(0, initial.messages.length), initial.messages);
  assert.deepEqual(mapped.messages.slice(1).map((message) => message.content), [
    "<system>\nbase\n\nrules\n</system>",
    '<system>\nUpdated system prompt section "rules":\n\nreplacement\n</system>',
  ]);
});

for (const boundary of ["user", "assistant"]) {
  test(`partial tool batches release updates before the next ${boundary} turn`, () => {
    const transcript = normalizeContext({
      systemPrompt: "base",
      messages: [{ role: "user", content: "lookup both", timestamp: 1 }],
    });
    transcript.messages.push(
      { role: "assistant", stopReason: "toolUse", content: ["a", "b"].map((id) => ({ type: "toolCall", id, name: "lookup", arguments: {} })), timestamp: 2 },
      { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "partial" }], timestamp: 3 },
      { role: "system", content: "first update", timestamp: 4 },
      { role: "system", content: "second update", timestamp: 5 },
    );
    const original = structuredClone(transcript);
    // A request ending here must work, despite b never having run.
    const first = mapContextToChat(transcript);
    assert.deepEqual(first.messages.slice(-3).map((message) => message.content), [
      "partial", "<system>\nfirst update\n</system>", "<system>\nsecond update\n</system>",
    ]);
    assert.deepEqual(transcript, original);

    transcript.messages.push(boundary === "user"
      ? { role: "user", content: "retry", timestamp: 6 }
      : { role: "assistant", stopReason: "aborted", content: [], timestamp: 6 });
    // A later completed tool turn must not inherit the orphaned b call.
    transcript.messages.push(
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name: "lookup", arguments: {} }], timestamp: 7 },
      { role: "system", content: "third update", timestamp: 8 },
      { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "complete" }], timestamp: 9 },
    );
    const resumed = mapContextToChat(JSON.parse(JSON.stringify(transcript)));
    assert.deepEqual(resumed.messages.slice(0, first.messages.length), first.messages);
    assert.equal(resumed.messages[first.messages.length].role, boundary);
    assert.deepEqual(resumed.messages.slice(-2).map((message) => message.content), [
      "complete", "<system>\nthird update\n</system>",
    ]);
  });
}

for (const stopReason of ["aborted", "error"]) {
  test(`${stopReason} tool calls never block later prompt updates`, () => {
    const transcript = normalizeContext({
      systemPrompt: "base",
      messages: [{ role: "user", content: "lookup", timestamp: 1 }],
    });
    transcript.messages.push({
      role: "assistant", stopReason,
      content: [{ type: "toolCall", id: "interrupted", name: "lookup", arguments: {} }], timestamp: 2,
    });
    const initial = mapContextToChat(transcript);
    transcript.messages.push(
      { role: "system", content: "new rules", timestamp: 3 },
      { role: "user", content: "try again", timestamp: 4 },
    );
    const resumed = mapContextToChat(transcript);
    assert.deepEqual(resumed.messages.slice(0, initial.messages.length), initial.messages);
    assert.deepEqual(resumed.messages.slice(-2).map((message) => message.content), [
      "<system>\nnew rules\n</system>", "try again",
    ]);

    transcript.messages.push(
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "normal", name: "lookup", arguments: {} }], timestamp: 5 },
      { role: "system", content: "latest rules", timestamp: 6 },
      { role: "toolResult", toolCallId: "normal", content: [{ type: "text", text: "result" }], timestamp: 7 },
    );
    const next = mapContextToChat(transcript);
    assert.deepEqual(next.messages.slice(0, resumed.messages.length), resumed.messages);
    assert.deepEqual(next.messages.slice(-2).map((message) => message.content), [
      "result", "<system>\nlatest rules\n</system>",
    ]);
  });
}
