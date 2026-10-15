import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { normalizeContext } from "@earendil-works/pi-ai";
import { normalizeSchema, streamDevin } from "../.test-dist/src/stream.js";
import { clearCachedUserJwt } from "../.test-dist/src/jwt.js";
import { encodeMessage, encodeString, encodeVarintField, frameConnectStream, iterFields } from "../.test-dist/src/wire.js";

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
        assert.deepEqual(Object.keys(payload).sort(), ["maxOutputTokens", "messages", "modelUid", "temperature", "tools"]);
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
    assert.equal(Number(field(field(sent, 8), 2)), changed ? 17 : 42);
    if (changed) assert.equal(field(field(sent, 10), 1).toString(), "hook_tool");
  });
}

test("sends Pi temperature (clamped above 0) as temperature and first_temperature, defaults otherwise", async (t) => {
  for (const [temperature, want5, want6] of [[0.2, 0.2, 0.2], [0, 0.01, 0.01], [-1, 0.01, 0.01], [undefined, 0.7, 0.95]]) {
    let sent;
    mockFetch(t, (init) => {
      sent = gunzipSync(Buffer.from(init.body).subarray(5));
      return successResponse();
    });
    const result = await streamDevin(model, context(), { apiKey: "secret-key", temperature }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    const config = field(sent, 8);
    assert.equal(field(config, 5).readDoubleLE(0), want5);
    assert.equal(field(config, 6).readDoubleLE(0), want6);
    assert.equal(Number(field(config, 2)), 64_000);
    assert.equal(Number(field(config, 3)), 128_000);
    t.mock.restoreAll();
  }
});

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
    { ...valid, temperature: Number.NaN }, { ...valid, temperature: "0.5" },
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

test("aborting mid-body resolves aborted without an unhandled rejection", async (t) => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const controller = new AbortController();
  // highWaterMark 0: pull runs only once the provider is reading the body, so the abort lands mid-read.
  mockFetch(t, (init) => new Response(new ReadableStream({
    start(c) { init.signal.addEventListener("abort", () => c.error(init.signal.reason)); },
    pull() { controller.abort(new Error("stop")); },
  }, { highWaterMark: 0 })));
  const result = await streamDevin(model, context(), { apiKey: "secret-key", signal: controller.signal }).result();
  await new Promise((r) => setImmediate(r));
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(unhandled, []);
});

test("normalizeSchema rewrites type arrays as anyOf everywhere without touching data or the input", () => {
  const input = {
    type: "object",
    properties: {
      n: { type: ["number", "null"], description: "kept" },
      constrained: { type: ["string", "null"], description: "d", default: null, minLength: 1, enum: ["a", null] },
      excludesNull: { type: ["string", "null"], enum: ["a"], not: { type: "null" }, if: { minLength: 1 }, then: { maxLength: 3 } },
      single: { type: ["string", "string"], minLength: 1 },
      keyed: {
        type: "object", patternProperties: { "^x": { type: ["string", "null"] } }, propertyNames: { type: ["string", "null"] },
        dependentSchemas: { k: { type: ["object", "null"] } }, else: { type: ["object", "null"] },
      },
      arr: { type: "array", contains: { type: ["string", "null"] } },
      opts: { type: ["object", "null"], properties: { k: { type: ["integer", "null"] } }, required: ["k"] },
      empty: { type: [] },
      tail: { type: "array", items: [true], additionalItems: { type: ["string", "null"] } },
      uneval: { unevaluatedItems: { type: ["string", "null"] }, unevaluatedProperties: { type: ["string", "null"] } },
      content: { type: "string", contentSchema: { type: ["string", "null"] } },
      list: { type: "array", items: { type: ["string", "integer"] } },
      tuple: { type: "array", items: [{ type: ["string", "null"] }, true] },
      both: { type: ["string", "null"], anyOf: [{ minLength: 1 }], allOf: [{ maxLength: 9 }] },
      data: { enum: [{ type: ["x", "y"] }], const: { type: ["a"] }, default: { type: ["b"] } },
      ref: { $ref: "#/$defs/d" },
    },
    additionalProperties: { type: ["boolean", "null"] },
    $defs: { d: { oneOf: [{ type: ["string", "null"] }] } },
    definitions: { e: { type: ["integer", "null"] } },
    dependencies: { n: ["list"], list: { properties: { m: { type: ["number", "null"] } } } },
    if: { type: ["object", "null"] }, not: { prefixItems: [{ type: ["string", "null"] }] },
  };
  const before = structuredClone(input);
  const out = normalizeSchema(input);
  assert.deepEqual(input, before);
  const sn = [{ type: "string" }, { type: "null" }];
  assert.deepEqual(out.properties.n, { description: "kept", anyOf: [{ type: "number" }, { type: "null" }] });
  assert.deepEqual(out.properties.constrained, {
    description: "d", default: null, anyOf: [{ type: "string", minLength: 1, enum: ["a", null] }, { type: "null", enum: ["a", null] }],
  });
  const ex = { enum: ["a"], not: { type: "null" }, if: { minLength: 1 }, then: { maxLength: 3 } };
  assert.deepEqual(out.properties.excludesNull, { anyOf: [{ type: "string", ...ex }, { type: "null", ...ex }] });
  assert.deepEqual(out.properties.single, { type: "string", minLength: 1 });
  const on = [{ type: "object" }, { type: "null" }];
  assert.deepEqual(out.properties.keyed.patternProperties["^x"], { anyOf: sn });
  assert.deepEqual(out.properties.keyed.propertyNames, { anyOf: sn });
  assert.deepEqual(out.properties.keyed.dependentSchemas.k, { anyOf: on });
  assert.deepEqual(out.properties.keyed.else, { anyOf: on });
  assert.deepEqual(out.properties.arr.contains, { anyOf: sn });
  assert.deepEqual(out.properties.opts, {
    anyOf: [{ type: "object", properties: { k: { anyOf: [{ type: "integer" }, { type: "null" }] } }, required: ["k"] }, { type: "null" }],
  });
  assert.deepEqual(out.properties.empty, { type: [] });
  assert.deepEqual(out.properties.tail.additionalItems, { anyOf: sn });
  assert.deepEqual(out.properties.uneval, { unevaluatedItems: { anyOf: sn }, unevaluatedProperties: { anyOf: sn } });
  assert.deepEqual(out.properties.content.contentSchema, { anyOf: sn });
  assert.deepEqual(out.properties.list.items, { anyOf: [{ type: "string" }, { type: "integer" }] });
  assert.deepEqual(out.properties.tuple.items, [{ anyOf: sn }, true]);
  assert.deepEqual(out.properties.both, {
    anyOf: [{ type: "string", allOf: [{ maxLength: 9 }], minLength: 1 }, { type: "null", allOf: [{ maxLength: 9 }] }],
  });
  assert.deepEqual(out.properties.data, input.properties.data);
  assert.deepEqual(out.properties.ref, { $ref: "#/$defs/d" });
  assert.deepEqual(out.additionalProperties, { anyOf: [{ type: "boolean" }, { type: "null" }] });
  assert.deepEqual(out.$defs.d.oneOf[0], { anyOf: sn });
  assert.deepEqual(out.definitions.e, { anyOf: [{ type: "integer" }, { type: "null" }] });
  assert.deepEqual(out.dependencies.n, ["list"]);
  assert.deepEqual(out.dependencies.list.properties.m, { anyOf: [{ type: "number" }, { type: "null" }] });
  assert.deepEqual(out.if, { anyOf: [{ type: "object" }, { type: "null" }] });
  assert.deepEqual(out.not.prefixItems[0], { anyOf: sn });
});

test("normalizeSchema leaves schemas with refs into moved nodes unchanged", () => {
  const holder = { type: ["object", "null"], properties: { id: { type: "string" } } };
  const moved = { type: "object", properties: { holder, alias: { $ref: "#/properties/holder/properties/id" } } };
  assert.equal(normalizeSchema(moved), moved);
  // Identifiers would be duplicated across branches or dropped from the null branch.
  for (const pinned of [
    { type: ["string", "number"], $anchor: "a" },
    { type: ["string", "number"], $dynamicAnchor: "a" },
    { type: ["object", "string"], properties: { a: { $id: "urn:example:a", type: "integer" } } },
    { type: "null", anyOf: [{ $defs: { a: { $id: "urn:example:a", const: null } }, $ref: "urn:example:a" }] },
    { $id: "https://example.com/s.json", type: "object", properties: { holder } },
  ]) assert.equal(normalizeSchema(pinned), pinned);
  for (const unsafe of [{ $ref: "#/$defs/x%2Fproperties%2Fid" }, { $ref: "https://example.com/s.json#/properties/holder/properties/id" }, { $ref: "#/$defs/%E0%A4%A" }, { $dynamicRef: "#/$defs/s" }, { $recursiveRef: "#" }]) {
    const schema = { type: "object", properties: { holder, alias: unsafe } };
    assert.equal(normalizeSchema(schema), schema);
  }
  for (const ref of ["#", "#/$defs/x", "#/definitions/x", "#/$defs/a%20b", "https://example.com/s.json", "https://example.com/s.json#/$defs/x"]) {
    const stable = { type: "object", properties: { holder, alias: { $ref: ref } } };
    assert.deepEqual(normalizeSchema(stable).properties.holder.anyOf[1], { type: "null" });
  }
});

test("normalizeSchema moves type next to anyOf into the branches", () => {
  const out = normalizeSchema({
    type: "string", description: "d", maxLength: 5, anyOf: [{ minLength: 1 }, { pattern: "x", properties: {} }],
  });
  assert.deepEqual(out, {
    description: "d", anyOf: [{ type: "string", maxLength: 5, minLength: 1 }, { type: "string", maxLength: 5, pattern: "x", properties: {} }],
  });
  const nullable = normalizeSchema({ type: ["object", "null"], anyOf: [{ required: ["a"] }, { enum: [null] }] });
  assert.deepEqual(nullable.anyOf, [
    { type: "object", required: ["a"] }, { type: "object", enum: [null] }, { type: "null" }, { type: "null", enum: [null] },
  ]);
  for (const branch of [{ type: "string" }, { anyOf: [{}] }, { maxLength: 3 }, true, { $id: "s" }, { $anchor: "a" }]) {
    const schema = { type: "string", maxLength: 5, anyOf: [{ minLength: 1 }, branch] };
    assert.deepEqual(normalizeSchema(schema), schema);
  }
  // Each split changes accepted values (Ajv-verified in review), so the node must stay as-is.
  for (const schema of [
    { type: "object", additionalProperties: false, anyOf: [{ properties: { b: {} } }] },
    { type: "object", properties: { a: {} }, anyOf: [{ additionalProperties: false }] },
    { type: "string", then: { maxLength: 1 }, anyOf: [{ if: { minLength: 1 } }] },
    { type: ["string", "null"], if: { const: null }, anyOf: [{ then: { not: { const: null } } }] },
    { type: "array", minContains: 2, anyOf: [{ contains: { const: 1 } }] },
    { type: "array", items: { type: "string" }, anyOf: [{ prefixItems: [{ type: "number" }] }] },
    { type: "string", contentMediaType: "application/json", anyOf: [{ contentSchema: { type: "object" } }] },
    { type: "object", unevaluatedProperties: false, anyOf: [{ properties: { a: {} } }, { properties: { b: {} } }] },
    { type: "array", unevaluatedItems: false, anyOf: [{ minItems: 1 }] },
    { type: "object", allOf: [{ properties: { a: true } }], anyOf: [{ unevaluatedProperties: false }] },
    { type: "array", allOf: [{ prefixItems: [true] }], anyOf: [{ unevaluatedItems: false }] },
  ]) assert.deepEqual(normalizeSchema(schema), schema);
  assert.deepEqual(normalizeSchema({ type: "string", anyOf: {} }), { type: "string", anyOf: {} });
  assert.deepEqual(normalizeSchema({ anyOf: [{ minLength: 1 }] }), { anyOf: [{ minLength: 1 }] });
});

test("normalizeSchema ignores $ref-shaped data and collapses single types next to anyOf", () => {
  const data = { $ref: "#/properties/holder" };
  const out = normalizeSchema({
    type: "object", default: data, examples: [data],
    properties: { n: { type: ["number", "null"], enum: [data, 1, null], const: data }, s: { type: ["string"], anyOf: [{ minLength: 1 }] } },
    dependencies: { n: ["s"] },
  });
  assert.equal(out.properties.n.anyOf.length, 2);
  assert.deepEqual(out.properties.s, { anyOf: [{ type: "string", minLength: 1 }] });
});

test("sends normalized tool schemas", async (t) => {
  let sent;
  mockFetch(t, (init) => { sent = gunzipSync(Buffer.from(init.body).subarray(5)); return successResponse(); });
  const ctx = normalizeContext({
    systemPrompt: "s",
    tools: [{ name: "t", description: "d", parameters: { type: "object", properties: { n: { type: ["number", "null"] } } } }],
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  });
  const result = await streamDevin(model, ctx, { apiKey: "secret-key" }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(JSON.parse(field(field(sent, 10), 3).toString()).properties.n, { anyOf: [{ type: "number" }, { type: "null" }] });
});

test("onPayload can override temperature, which is sent clamped", async (t) => {
  let sent;
  mockFetch(t, (init) => { sent = gunzipSync(Buffer.from(init.body).subarray(5)); return successResponse(); });
  const result = await streamDevin(model, context(), {
    apiKey: "secret-key", temperature: 0.9,
    onPayload(payload) { assert.equal(payload.temperature, 0.9); payload.temperature = 0; },
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(field(field(sent, 8), 5).readDoubleLE(), 0.01);
  assert.equal(field(field(sent, 8), 6).readDoubleLE(), 0.01);
});

test("errors after the response name the model and request id", async (t) => {
  for (const [headers, tag] of [[{ "x-request-id": "req-9" }, "[model=test-model, request=req-9]"], [{}, "[model=test-model]"]]) {
    for (const [status, body, want] of [[500, "boom", "GetChatMessage HTTP 500: boom"], [500, "", "GetChatMessage HTTP 500:"],
      [200, null, "GetChatMessage returned an empty body"],
      [200, Buffer.alloc(0), "Devin stream ended without an EOS trailer"]]) {
      mockFetch(t, () => new Response(body, { status, headers }));
      assert.equal((await streamDevin(model, context(), { apiKey: "secret-key" }).result()).errorMessage, `${want} ${tag}`);
      t.mock.restoreAll();
    }
  }
});

test("trailer errors name the model and request id", async (t) => {
  const trailer = (json) => { const b = Buffer.from(JSON.stringify(json)); const h = Buffer.alloc(5); h[0] = 2; h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };
  for (const [headers, suffix] of [[{ "x-request-id": "req-9" }, "[model=test-model, request=req-9]"], [{}, "[model=test-model]"]]) {
    mockFetch(t, () => new Response(trailer({ error: { code: "internal", message: "an internal error occurred" } }), { headers }));
    const result = await streamDevin(model, context(), { apiKey: "secret-key" }).result();
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, `an internal error occurred ${suffix}`);
    t.mock.restoreAll();
  }
});

for (const [finish, want] of [[undefined, "toolUse"], [0, "toolUse"], [10, "toolUse"], [3, "length"], [11, "error"]]) {
  test(`tool calls with finish ${finish} end as ${want}`, async (t) => {
    const call = encodeMessage(6, Buffer.concat([encodeString(1, "call-1"), encodeString(2, "lookup"), encodeString(3, "{}")]));
    const frames = [frameConnectStream(call)];
    if (finish !== undefined) frames.push(frameConnectStream(encodeVarintField(5, finish)));
    mockFetch(t, () => new Response(Buffer.concat([...frames, eos])));
    const result = await streamDevin(model, context(), { apiKey: "secret-key" }).result();
    assert.equal(result.stopReason, want, result.errorMessage);
    assert.equal(result.content.find((block) => block.type === "toolCall")?.name, "lookup");
  });
}

for (const [finish, want] of [[0, "stop"], [11, "error"]]) {
  test(`text-only replies with finish ${finish} end as ${want}`, async (t) => {
    mockFetch(t, () => new Response(Buffer.concat([frameConnectStream(Buffer.concat([encodeString(3, "hi"), encodeVarintField(5, finish)])), eos])));
    const stream = streamDevin(model, context(), { apiKey: "secret-key" });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    assert.equal(result.stopReason, want);
    assert.ok(events.indexOf("text_end") >= 0 && events.indexOf("text_end") < events.length - 1);
    if (want === "error") assert.equal(result.errorMessage, "Provider finish_reason: content_filter [model=test-model]");
  });
}

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
