import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamDevin } from "../.test-dist/src/stream.js";
import { clearCachedUserJwt } from "../.test-dist/src/jwt.js";
import { encodeString, frameConnectStream, iterFields } from "../.test-dist/src/wire.js";

const model = {
  id: "test-model", api: "devin-local", provider: "devin", baseUrl: "https://devin.test",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = () => normalizeContext({
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
});
const eos = Buffer.from([2, 0, 0, 0, 2, 123, 125]);
const successResponse = () => new Response(Buffer.concat([
  frameConnectStream(encodeString(3, "reply")), eos,
]), { headers: { "x-request-id": "request-123" } });

function mockFetch(t, onChat) {
  clearCachedUserJwt();
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/GetUserJwt")) return new Response(encodeString(1, "eyJ.test.jwt"));
    assert.equal(String(url), `${model.baseUrl}/exa.api_server_pb.ApiServerService/GetChatMessage`);
    return onChat(init);
  });
}

function field(proto, num) {
  return [...iterFields(proto)].find((item) => item.num === num)?.value;
}

for (const mode of ["replace", "mutate", "observe"]) {
  test(`awaits ${mode} payload hook before encoding, then response hook before reading`, async (t) => {
    const order = [];
    let sent;
    const response = successResponse();
    const getReader = response.body.getReader.bind(response.body);
    t.mock.method(response.body, "getReader", (...args) => {
      order.push("read");
      return getReader(...args);
    });
    const controller = new AbortController();
    mockFetch(t, (init) => {
      order.push("fetch");
      assert.equal(init.signal, controller.signal);
      sent = gunzipSync(Buffer.from(init.body).subarray(5));
      return response;
    });
    const stream = streamDevin(model, context(), {
      apiKey: "secret-key", signal: controller.signal, maxTokens: 42,
      async onPayload(payload, suppliedModel) {
        assert.equal(suppliedModel, model);
        assert.deepEqual(Object.keys(payload).sort(), ["maxOutputTokens", "messages", "modelUid", "tools"]);
        assert.equal(payload.modelUid, model.id);
        assert.equal(payload.maxOutputTokens, 42);
        assert.equal(payload.messages.at(-1).content, "hello");
        await Promise.resolve();
        order.push("payload");
        const changes = {
          modelUid: "hook-model", messages: [{ role: "user", content: "hook prompt" }],
          tools: [{ name: "hook_tool", description: "test", parameters: { type: "object" } }],
          maxOutputTokens: 17,
        };
        if (mode === "replace") return { ...payload, ...changes };
        if (mode === "mutate") Object.assign(payload, changes);
      },
      async onResponse(info, suppliedModel) {
        assert.equal(suppliedModel, model);
        assert.equal(info.status, 200);
        assert.equal(info.headers["x-request-id"], "request-123");
        assert.equal(response.bodyUsed, false);
        await Promise.resolve();
        order.push("response");
      },
    });
    // Observe emission, not async-iterator delivery (which can lag behind body reads).
    const push = stream.push.bind(stream);
    t.mock.method(stream, "push", (event) => {
      if (event.type === "start") order.push("start");
      push(event);
    });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    assert.equal(events.filter((type) => type === "start").length, 1);
    assert.equal(events[0], "start");
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.content[0].text, "reply");
    assert.deepEqual(order, ["payload", "fetch", "response", "start", "read"]);
    const changed = mode !== "observe";
    assert.equal(field(sent, 21).toString(), changed ? "hook-model" : model.id);
    assert.equal(field(field(sent, 3), 3).toString(), changed ? "hook prompt" : "hello");
    assert.equal(Number(field(field(sent, 8), 3)), changed ? 17 : 42);
    if (changed) assert.equal(field(field(sent, 10), 1).toString(), "hook_tool");
  });
}

test("response hook sees HTTP errors before their body is consumed", async (t) => {
  const response = new Response("rate limited", { status: 429, headers: { "retry-after": "3" } });
  let called = false;
  mockFetch(t, () => response);
  const result = await streamDevin(model, context(), {
    apiKey: "secret-key",
    async onResponse(info) {
      assert.deepEqual(info, { status: 429, headers: Object.fromEntries(response.headers) });
      assert.equal(response.bodyUsed, false);
      await Promise.resolve();
      called = true;
    },
  }).result();
  assert.equal(called, true);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /GetChatMessage HTTP 429: rate limited/);
});

for (const hook of ["onPayload", "onResponse"]) {
  for (const failure of ["reject", "abort"]) {
    test(`${hook} ${failure} terminates before start without consuming the response`, async (t) => {
      const response = successResponse();
      const controller = new AbortController();
      let fetched = false;
      let cancelled = false;
      const cancel = response.body.cancel.bind(response.body);
      t.mock.method(response.body, "cancel", async () => { cancelled = true; await cancel(); });
      mockFetch(t, () => { fetched = true; return response; });
      const events = [];
      for await (const event of streamDevin(model, context(), {
        apiKey: "secret-key", signal: controller.signal,
        async [hook]() {
          await Promise.resolve();
          if (failure === "reject") throw new Error("hook failed");
          controller.abort(new Error("hook aborted"));
          await Promise.resolve();
        },
      })) events.push(event);
      assert.deepEqual(events.map((event) => event.type), ["error"]);
      assert.equal(events[0].reason, failure === "abort" ? "aborted" : "error");
      assert.equal(events[0].error.errorMessage, failure === "abort" ? "hook aborted" : "hook failed");
      assert.equal(fetched, hook === "onResponse");
      assert.equal(cancelled, hook === "onResponse");
    });
  }
}

test("invalid hook payloads fail clearly before any network request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request"); });
  const valid = { modelUid: "test-model", messages: [] };
  const invalid = [
    null, false, 42, "bad", [], {}, { model: "claude", messages: [] },
    { ...valid, modelUid: " " }, { ...valid, messages: null },
    { ...valid, tools: {} }, { ...valid, maxOutputTokens: 0 },
    { ...valid, maxOutputTokens: 1.5 }, { ...valid, maxOutputTokens: Infinity },
  ];
  for (const replacement of invalid) {
    const stream = streamDevin(model, context(), {
      apiKey: "secret-key", onPayload: () => replacement,
    });
    const events = [];
    for await (const event of stream) events.push(event.type);
    assert.deepEqual(events, ["error"]);
    assert.match((await stream.result()).errorMessage, /^Invalid Devin payload:/);
  }
  const mutated = await streamDevin(model, context(), {
    apiKey: "secret-key", onPayload(payload) { delete payload.modelUid; },
  }).result();
  assert.match(mutated.errorMessage, /^Invalid Devin payload:/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("empty response emits start after the response hook, then done", async (t) => {
  mockFetch(t, () => new Response(eos));
  const order = [];
  for await (const event of streamDevin(model, context(), {
    apiKey: "secret-key", onResponse() { order.push("response"); },
  })) order.push(event.type);
  assert.deepEqual(order, ["response", "start", "done"]);
});

test("inference still works without hooks", async (t) => {
  mockFetch(t, () => successResponse());
  const result = await streamDevin(model, context(), { apiKey: "secret-key" }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.content[0].text, "reply");
});

for (const placement of ["before", "after", "interrupted"]) {
  test(`system update with ${placement} tool results preserves encoded prefixes across turns`, async (t) => {
    const requests = [];
    mockFetch(t, (init) => {
      const request = gunzipSync(Buffer.from(init.body).subarray(5));
      requests.push([...iterFields(request)].filter((item) => item.num === 3).map((item) => item.value));
      return successResponse();
    });
    const transcript = normalizeContext({
      systemPrompt: "base prompt",
      messages: [{ role: "user", content: [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ], timestamp: 1 }],
    });
    const originalHead = structuredClone(transcript.messages[0]);
    const first = await streamDevin(model, transcript, { apiKey: "secret-key" }).result();
    assert.equal(first.stopReason, "stop", first.errorMessage);
    const text = (prompt) => field(prompt, 3).toString();
    assert.equal(text(requests[0][0]), "<system>\nbase prompt\n</system>\nhello");
    const image = field(requests[0][0], 10);
    assert.equal(field(image, 1).toString(), "aGVsbG8=");
    assert.equal(field(image, 2).toString(), "image/png");

    const update = { role: "system", content: "", sections: { rules: "new rules", obsolete: null }, timestamp: 2 };
    const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "lookup", content: [{ type: "text", text: "result" }], isError: false, timestamp: 3 };
    const calls = [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }];
    if (placement === "interrupted") calls.push({ ...calls[0], id: "never-ran" });
    transcript.messages.push(
      { ...first, content: calls, stopReason: "toolUse" },
      ...(placement === "before" ? [update, toolResult] : [toolResult, update]),
    );
    const second = await streamDevin(model, transcript, { apiKey: "secret-key" }).result();
    assert.equal(second.stopReason, "stop", second.errorMessage);
    assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0]);
    assert.deepEqual(requests[1].map((prompt) => Number(field(prompt, 2))), [1, 2, 4, 1]);
    assert.equal(text(requests[1][3]),
      '<system>\nUpdated system prompt section "rules":\n\nnew rules\n\nRemoved system prompt section "obsolete".\n</system>');
    assert.equal(text(requests[1][2]), "result");
    assert.equal(field(requests[1][2], 7).toString(), "call-1");

    transcript.messages.push(
      second,
      { role: "system", content: "latest instructions", timestamp: 4 },
    );
    const third = await streamDevin(model, transcript, { apiKey: "secret-key" }).result();
    assert.equal(third.stopReason, "stop", third.errorMessage);
    assert.deepEqual(requests[2].slice(0, requests[1].length), requests[1]);
    assert.equal(text(requests[2].at(-1)), "<system>\nlatest instructions\n</system>");

    transcript.messages.push(third, { role: "user", content: "next", timestamp: 5 });
    const resumed = await streamDevin(model, structuredClone(transcript), { apiKey: "secret-key" }).result();
    assert.equal(resumed.stopReason, "stop", resumed.errorMessage);
    assert.deepEqual(requests[3].slice(0, requests[2].length), requests[2]);
    assert.deepEqual(transcript.messages[0], originalHead);
  });
}
