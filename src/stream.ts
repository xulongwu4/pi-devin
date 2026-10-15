import { randomUUID } from "node:crypto";
import * as zlib from "node:zlib";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type TranscriptContext,
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { mapContextToChat, type ChatHistoryItem, type ContentPart, type ToolDef } from "./context-map.js";
import { getCachedUserJwt } from "./jwt.js";
import { buildMetadata } from "./metadata.js";
import { resolveModelUid } from "./models.js";
import {
  encodeFixed64Field,
  encodeMessage,
  encodeString,
  encodeVarintField,
  frameConnectStream,
  iterFields,
} from "./wire.js";

const SOURCE_BY_ROLE: Record<string, number> = {
  user: 1,
  assistant: 2,
  system: 1,
  tool: 4,
};

export type CloudChatEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "tool_call_args"; argsDelta: string; id?: string }
  | { kind: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" }
  | {
      kind: "usage";
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
      cacheCreationInputTokens?: number;
    };

function normalizeContent(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

function collapseSystemIntoUser(messages: ChatHistoryItem[]): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = [];
  let pending: string[] = [];
  const textOf = (content: string | ContentPart[]) =>
    normalizeContent(content)
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text as string)
      .join("\n");

  for (const message of messages) {
    if (message.role === "system") {
      const text = textOf(message.content);
      if (text) pending.push(text);
      continue;
    }
    if (message.role === "user" && pending.length > 0) {
      const userParts = normalizeContent(message.content);
      const userText = textOf(userParts);
      const images = userParts.filter((part) => part.type === "image");
      out.push({
        role: "user",
        content: [{ type: "text", text: `<system>\n${pending.join("\n\n")}\n</system>\n${userText}` }, ...images],
      });
      pending = [];
      continue;
    }
    out.push(message);
  }
  if (pending.length > 0) {
    out.push({ role: "user", content: `<system>\n${pending.join("\n\n")}\n</system>` });
  }
  return out;
}

function encodeImageData(img: { mimeType?: string; base64Data?: string }): Buffer {
  return Buffer.concat([
    encodeString(1, img.base64Data ?? ""),
    encodeString(2, img.mimeType ?? "image/png"),
  ]);
}

function encodeChatToolCall(tc: { id: string; name: string; arguments: string }): Buffer {
  return Buffer.concat([encodeString(1, tc.id), encodeString(2, tc.name), encodeString(3, tc.arguments)]);
}

function encodeChatMessagePrompt(
  content: ContentPart[],
  source: number,
  opts?: { toolCallId?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> },
): Buffer {
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  const parts: Buffer[] = [
    encodeVarintField(2, source),
    encodeString(3, text),
    encodeVarintField(4, Math.max(1, Math.floor(text.length / 4))),
    encodeVarintField(5, 1),
  ];
  if (opts?.toolCallId) parts.push(encodeString(7, opts.toolCallId));
  for (const tc of opts?.toolCalls ?? []) parts.push(encodeMessage(6, encodeChatToolCall(tc)));
  for (const img of content.filter((part) => part.type === "image")) {
    parts.push(encodeMessage(10, encodeImageData(img)));
  }
  return Buffer.concat(parts);
}

// Field names from oh-my-pi's reverse-engineered omp-llm-devin wire.rs: 1 num_completions, 2 max_tokens,
// 3 max_newlines, 5 temperature, 6 first_temperature, 7 top_k, 8 top_p, 11 fim_eot_prob_threshold.
// Live 2026-10-15 (this field layout): the server ignored max_tokens; temperature reached GLM but not GPT/Claude/SWE-2.
function encodeCompletionConfiguration(maxOutputTokens?: number, temperature?: number): Buffer {
  // Devin rejects temperature 0 (also the proto3 default) with "an internal error occurred".
  if (temperature !== undefined) temperature = Math.max(temperature, 0.01);
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, maxOutputTokens ?? 64_000),
    encodeVarintField(3, 128_000),
    encodeFixed64Field(5, temperature ?? 0.7),
    encodeFixed64Field(6, temperature ?? 0.95),
    encodeVarintField(7, 50),
    encodeFixed64Field(8, 1.0),
    encodeFixed64Field(11, 1.0),
  ]);
}

const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];
const SUBSCHEMAS = [
  "additionalProperties", "additionalItems", "unevaluatedProperties", "unevaluatedItems", "items", "contains",
  "propertyNames", "contentSchema", "if", "then", "else", "not",
];
// Annotations stay on the rewritten node; every other keyword moves into the anyOf branches.
const ANNOTATIONS = new Set([
  "title", "description", "default", "examples", "$comment", "deprecated", "readOnly", "writeOnly",
  "$schema", "$defs", "definitions",
]);
const SUBSCHEMA_LISTS = ["prefixItems", "anyOf", "oneOf", "allOf"];
// Keywords read with a same-object sibling; merging a node keyword with a branch keyword from one group
// would pair them where the input kept them apart (e.g. additionalProperties seeing branch properties).
const LINKED = [
  ["properties", "patternProperties", "additionalProperties"],
  ["prefixItems", "items", "additionalItems", "contains", "minContains", "maxContains"],
  ["if", "then", "else"],
  ["contentMediaType", "contentEncoding", "contentSchema"],
];
// Branch keys that block merging: unevaluated* would start seeing the node's applicators (allOf, $ref, ...).
const UNMERGEABLE = ["type", "anyOf", "unevaluatedProperties", "unevaluatedItems"];
// Dynamic refs and resource identifiers would be dropped from the null branch or duplicated across branches.
const PINNED = ["$dynamicRef", "$recursiveRef", "$id", "$anchor", "$dynamicAnchor"];
// Keywords that can reject null; the null branch keeps only these (Gemini rejects e.g. properties there).
const ANY_TYPE = ["enum", "const", "not", "allOf", "oneOf", "if", "then", "else", "$ref"];
// Local refs other than "#", "#/$defs/x", "#/definitions/x" may point into nodes the rewrite moves.
const STABLE_REF = /^#(\/(\$defs|definitions)\/[^/]+)?$/;

// Fragments are URI-encoded: "#/$defs/x%2Fy" points at "#/$defs/x/y", inside a node that may move.
function isStableRef(ref: string): boolean {
  try {
    return STABLE_REF.test(decodeURIComponent(ref));
  } catch {
    return false;
  }
}

// Walks schema positions only, so "$ref" inside data (enum, const, default, examples) is not a reference.
function mustSendUnchanged(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(mustSendUnchanged);
  if (!schema || typeof schema !== "object") return false;
  const node = schema as Record<string, unknown>;
  // Check the fragment of absolute refs too: "<root $id>#/properties/x" points into this document.
  const hash = typeof node.$ref === "string" ? node.$ref.indexOf("#") : -1;
  if (hash >= 0 && !isStableRef((node.$ref as string).slice(hash))) return true;
  if (PINNED.some((key) => key in node)) return true;
  const maps = SUBSCHEMA_MAPS.map((key) => node[key]).filter((map) => map && typeof map === "object" && !Array.isArray(map));
  return maps.some((map) => Object.values(map as object).some(mustSendUnchanged)) ||
    [...SUBSCHEMAS, ...SUBSCHEMA_LISTS].some((key) => mustSendUnchanged(node[key]));
}

/**
 * Devin-hosted Gemini rejects JSON Schema type arrays (e.g. ["number","null"]) and anyOf with type or
 * type-specific siblings (minLength, properties, enum, ...), so rewrite to anyOf branches that carry them.
 */
export function normalizeSchema(schema: unknown): unknown {
  // shortcut: schemas with pointer refs into moved nodes or PINNED keywords are sent unchanged; upgrade by
  // rewriting the refs / identifiers if such tool schemas show up.
  return mustSendUnchanged(schema) ? schema : normalizeNode(schema);
}

// The result shares nested values across branches and with the input; treat it as read-only.
function normalizeNode(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeNode);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  for (const key of SUBSCHEMA_MAPS) {
    const map = out[key];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      // dependencies may hold string arrays (property dependencies); normalizeSchema leaves those intact.
      out[key] = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, normalizeNode(v)]));
    }
  }
  for (const key of SUBSCHEMAS) if (key in out) out[key] = normalizeNode(out[key]);
  for (const key of SUBSCHEMA_LISTS) if (Array.isArray(out[key])) out[key] = normalizeNode(out[key]);
  const types = Array.isArray(out.type) ? [...new Set(out.type as unknown[])] : "type" in out ? [out.type] : [];
  const branches = "anyOf" in out ? out.anyOf : [{}];
  if (types.length === 0 || !Array.isArray(branches)) return out;
  if (types.length === 1 && !("anyOf" in out)) return { ...out, type: types[0] };
  const root: Record<string, unknown> = {};
  const constraints: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out)) {
    if (key !== "type" && key !== "anyOf") (ANNOTATIONS.has(key) ? root : constraints)[key] = value;
  }
  // Gemini rejects type next to anyOf (even one type) and allOf:[{anyOf}], but accepts type in each branch.
  // shortcut: branches with an UNMERGEABLE key, a keyword also on the node, or a LINKED keyword split from
  // the node are not intersected and the node is sent as-is; upgrade if such schemas show up.
  // unevaluated* on the node sees all passing branches at once, so it blocks splitting.
  const linked = (branch: object): boolean =>
    LINKED.some((group) => group.some((key) => key in branch) && group.some((key) => key in constraints));
  const mergeable = (branch: unknown): boolean =>
    !!branch && typeof branch === "object" && !Array.isArray(branch) && !linked(branch) &&
    Object.keys(branch).every((key) => !UNMERGEABLE.includes(key) && !(key in constraints));
  if ("anyOf" in out && ("unevaluatedProperties" in constraints || "unevaluatedItems" in constraints)) return out;
  if (!branches.every(mergeable)) return out;
  root.anyOf = types.flatMap((type) => branches.map((branch) => {
    const merged = Object.entries({ ...constraints, ...(branch as object) });
    return { type, ...Object.fromEntries(type === "null" ? merged.filter(([key]) => ANY_TYPE.includes(key)) : merged) };
  }));
  return root;
}

function encodeToolDef(tool: ToolDef): Buffer {
  // shortcut: 6998-UTF-16-unit cap inherited from upstream, rationale unverified; revisit if the server limit is found.
  const description = tool.description.length > 6_998 ? `${tool.description.slice(0, 6_995)}...` : tool.description;
  return Buffer.concat([
    encodeString(1, tool.name),
    encodeString(2, description),
    encodeString(3, JSON.stringify(normalizeSchema(tool.parameters ?? {}))),
  ]);
}

function buildGetChatMessageRequest(args: {
  apiKey: string;
  userJwt: string;
  modelUid: string;
  messages: ChatHistoryItem[];
  tools?: ToolDef[];
  cascadeId: string;
  promptId: string;
  sessionId: string;
  requestId: bigint;
  triggerId: string;
  maxOutputTokens?: number;
  temperature?: number;
}): Buffer {
  const metadata = buildMetadata({
    apiKey: args.apiKey,
    userJwt: args.userJwt,
    sessionId: args.sessionId,
    requestId: args.requestId,
    triggerId: args.triggerId,
  });
  const prompts = collapseSystemIntoUser(args.messages).map((message) =>
    encodeMessage(
      3,
      encodeChatMessagePrompt(normalizeContent(message.content), SOURCE_BY_ROLE[message.role] ?? 1, {
        toolCallId: message.role === "tool" ? message.tool_call_id : undefined,
        toolCalls: message.role === "assistant" ? message.tool_calls : undefined,
      }),
    ),
  );
  return Buffer.concat([
    encodeMessage(1, metadata),
    ...prompts,
    encodeVarintField(7, 5),
    encodeMessage(8, encodeCompletionConfiguration(args.maxOutputTokens, args.temperature)),
    ...(args.tools ?? []).map((tool) => encodeMessage(10, encodeToolDef(tool))),
    encodeString(16, args.cascadeId),
    encodeString(21, args.modelUid),
    encodeString(22, args.promptId),
  ]);
}

function* decodeChatFrame(proto: Buffer): Generator<CloudChatEvent> {
  for (const field of iterFields(proto)) {
    if (field.num === 3 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) yield { kind: "text", text };
    } else if (field.num === 9 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) yield { kind: "reasoning", text };
    } else if (field.num === 6 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      let id: string | undefined;
      let name: string | undefined;
      let argsDelta: string | undefined;
      for (const inner of iterFields(field.value)) {
        if (inner.wire === 2 && Buffer.isBuffer(inner.value)) {
          const text = inner.value.toString("utf8");
          if (inner.num === 1) id = text;
          else if (inner.num === 2) name = text;
          else if (inner.num === 3) argsDelta = text;
        }
      }
      if (id !== undefined && name !== undefined) yield { kind: "tool_call_start", id, name };
      if (argsDelta !== undefined) yield { kind: "tool_call_args", argsDelta, ...(id ? { id } : {}) };
    } else if (field.num === 5 && field.wire === 0) {
      const value = Number(field.value);
      let reason: Extract<CloudChatEvent, { kind: "finish" }>['reason'] = "stop";
      if (value === 10) reason = "tool_calls";
      else if (value === 11) reason = "content_filter";
      else if (value === 1 || value === 3) reason = "length";
      yield { kind: "finish", reason };
    } else if (field.num === 28 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const usage = decodeUsage(field.value);
      if (usage) yield usage;
    }
  }
}

function decodeUsage(buf: Buffer): CloudChatEvent | null {
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  for (const field of iterFields(buf)) {
    if (field.num !== 2 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    let metric: string | undefined;
    let value: number | undefined;
    for (const inner of iterFields(field.value)) {
      if (inner.num === 5 && inner.wire === 2 && Buffer.isBuffer(inner.value)) {
        metric = inner.value.toString("utf8");
      } else if (inner.num === 4 && inner.wire === 2 && Buffer.isBuffer(inner.value)) {
        for (const dim of iterFields(inner.value)) {
          if (dim.num === 2 && dim.wire === 5 && Buffer.isBuffer(dim.value)) {
            value = dim.value.readFloatLE(0);
          }
        }
      }
    }
    if (!metric || value === undefined || !Number.isFinite(value)) continue;
    const n = Math.round(value);
    if (metric === "input_tokens") promptTokens = n;
    else if (metric === "output_tokens") completionTokens = n;
    else if (metric.includes("cached") || metric.includes("cache_read")) cachedInputTokens = n;
    else if (metric.includes("cache_creation")) cacheCreationInputTokens = n;
  }
  if (promptTokens === undefined && completionTokens === undefined) return null;
  return {
    kind: "usage",
    promptTokens,
    completionTokens,
    totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
    cachedInputTokens,
    cacheCreationInputTokens,
  };
}

const sessionCache = new Map<string, { sessionId: string; cascadeId: string }>();

function sessionIds(apiKey: string, host: string) {
  const key = `${host}\x1f${apiKey}`;
  let ids = sessionCache.get(key);
  if (!ids) {
    ids = { sessionId: randomUUID(), cascadeId: randomUUID() };
    sessionCache.set(key, ids);
  }
  return ids;
}

async function* streamChatEvents(args: {
  apiKey: string;
  host: string;
  modelUid: string;
  messages: ChatHistoryItem[];
  tools?: ToolDef[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}, model: Model<Api>, options?: SimpleStreamOptions): AsyncGenerator<CloudChatEvent | { kind: "start" }> {
  // Keep credentials and transport metadata out of the inspectable payload.
  let payload = {
    modelUid: args.modelUid,
    messages: args.messages,
    tools: args.tools,
    maxOutputTokens: args.maxOutputTokens,
    temperature: args.temperature,
  };
  const replacement = await options?.onPayload?.(payload, model);
  args.signal?.throwIfAborted();
  if (replacement !== undefined) payload = replacement as typeof payload;
  if (
    !payload || typeof payload !== "object" || Array.isArray(payload) ||
    typeof payload.modelUid !== "string" || !payload.modelUid.trim() ||
    !Array.isArray(payload.messages) ||
    (payload.tools !== undefined && !Array.isArray(payload.tools)) ||
    (payload.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(payload.maxOutputTokens) || payload.maxOutputTokens <= 0)) ||
    (payload.temperature !== undefined && !Number.isFinite(payload.temperature))
  ) {
    throw new Error("Invalid Devin payload: expected a non-empty modelUid string, messages array, " +
      "optional tools array, optional positive safe-integer maxOutputTokens, and optional finite temperature");
  }

  const host = args.host.replace(/\/$/, "");
  const userJwt = await getCachedUserJwt(args.apiKey, host, args.signal);
  const ids = sessionIds(args.apiKey, host);
  const proto = buildGetChatMessageRequest({
    apiKey: args.apiKey,
    userJwt,
    modelUid: payload.modelUid,
    messages: payload.messages,
    tools: payload.tools,
    cascadeId: ids.cascadeId,
    promptId: randomUUID(),
    sessionId: ids.sessionId,
    requestId: BigInt(Date.now()),
    triggerId: randomUUID(),
    maxOutputTokens: payload.maxOutputTokens,
    temperature: payload.temperature,
  });

  const resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Connect-Content-Encoding": "gzip",
      "Connect-Accept-Encoding": "gzip",
    },
    body: new Uint8Array(frameConnectStream(proto, true)),
    signal: args.signal,
  });
  try {
    await options?.onResponse?.({ status: resp.status, headers: Object.fromEntries(resp.headers) }, model);
    args.signal?.throwIfAborted();
  } catch (error) {
    // A failed hook must not leave the unread response streaming in the background.
    await resp.body?.cancel().catch(() => {});
    throw error;
  }
  const requestId = resp.headers.get("x-request-id");
  const tag = `[model=${payload.modelUid}${requestId ? `, request=${requestId}` : ""}]`;
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 300);
    throw new Error(`GetChatMessage HTTP ${resp.status}:${body ? ` ${body}` : ""} ${tag}`);
  }
  if (!resp.body) throw new Error(`GetChatMessage returned an empty body ${tag}`);

  yield { kind: "start" };
  const reader = resp.body.getReader();
  const queue: Buffer[] = [];
  let queued = 0;
  let sawEos = false;
  let filtered = false;
  let trailerError: string | null = null;

  const peek = (n: number): Buffer | null => {
    if (queued < n) return null;
    if (queue.length === 1 && queue[0].length >= n) return queue[0].subarray(0, n);
    const parts: Buffer[] = [];
    let remaining = n;
    for (const chunk of queue) {
      if (remaining <= 0) break;
      if (chunk.length <= remaining) {
        parts.push(chunk);
        remaining -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, remaining));
        remaining = 0;
      }
    }
    return Buffer.concat(parts, n);
  };

  const drop = (n: number): void => {
    queued -= n;
    let remaining = n;
    while (remaining > 0 && queue.length > 0) {
      const head = queue[0];
      if (head.length <= remaining) {
        queue.shift();
        remaining -= head.length;
      } else {
        queue[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        queue.push(Buffer.from(value));
        queued += value.length;
      }
      while (queued >= 5) {
        const header = peek(5);
        if (!header) break;
        const flags = header[0];
        const len = header.readUInt32BE(1);
        if (queued < 5 + len) break;
        drop(5);
        const raw = peek(len) ?? Buffer.alloc(0);
        drop(len);
        let payload = raw;
        if (flags & 0x01) payload = zlib.gunzipSync(raw);
        if (flags & 0x02) {
          sawEos = true;
          const text = payload.toString("utf8");
          if (text.includes('"error"')) {
            try {
              const parsed = JSON.parse(text) as { error?: { message?: string } };
              trailerError = parsed.error?.message ?? text;
            } catch {
              trailerError = text;
            }
          }
          continue;
        }
        for (const event of decodeChatFrame(payload)) {
          if (event.kind === "finish" && event.reason === "content_filter") filtered = true;
          yield event;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    // cancel() rejects (async) when the body already errored, e.g. on abort.
    resp.body.cancel().catch(() => {});
  }
  // Same message as pi-ai's OpenAI adapter, plus the tag; streamDevin closes open blocks first.
  if (filtered) throw new Error(`Provider finish_reason: content_filter ${tag}`);

  if (trailerError) throw new Error(`${trailerError} ${tag}`);
  if (!sawEos) throw new Error(`Devin stream ended without an EOS trailer ${tag}`);
}

export function streamDevin(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let textOpen = false;
    let thinkingOpen = false;
    let toolIndex = -1;
    let partialJson = "";
    let toolId = "";
    let toolName = "";

    const closeText = () => {
      if (!textOpen) return;
      const idx = output.content.length - 1;
      const block = output.content[idx];
      if (block.type === "text") {
        stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
      }
      textOpen = false;
    };
    const closeThinking = () => {
      if (!thinkingOpen) return;
      const idx = output.content.length - 1;
      const block = output.content[idx];
      if (block.type === "thinking") {
        stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
      }
      thinkingOpen = false;
    };
    const closeTool = () => {
      if (toolIndex < 0) return;
      const block = output.content[toolIndex];
      if (block.type === "toolCall") {
        try {
          block.arguments = JSON.parse(partialJson);
        } catch {
          // keep last parsed object
        }
        stream.push({
          type: "toolcall_end",
          contentIndex: toolIndex,
          toolCall: { type: "toolCall", id: toolId, name: toolName, arguments: block.arguments },
          partial: output,
        });
      }
      toolIndex = -1;
    };

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) throw new Error("No Devin credentials. Run /login devin.");
      const host = model.baseUrl || "https://server.codeium.com";
      const modelUid = resolveModelUid(model.id, model.thinkingLevelMap, options?.reasoning);
      const mapped = mapContextToChat(context);

      for await (const event of streamChatEvents({
        apiKey,
        host,
        modelUid,
        messages: mapped.messages,
        tools: mapped.tools.length > 0 ? mapped.tools : undefined,
        maxOutputTokens: options?.maxTokens,
        temperature: options?.temperature,
        signal: options?.signal,
      }, model, options)) {
        if (event.kind === "start") {
          stream.push({ type: "start", partial: output });
        } else if (event.kind === "text") {
          closeThinking();
          if (!textOpen) {
            output.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
            textOpen = true;
          }
          const idx = output.content.length - 1;
          const block = output.content[idx];
          if (block.type === "text") {
            block.text += event.text;
            stream.push({ type: "text_delta", contentIndex: idx, delta: event.text, partial: output });
          }
        } else if (event.kind === "reasoning") {
          closeText();
          if (!thinkingOpen) {
            output.content.push({ type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
            thinkingOpen = true;
          }
          const idx = output.content.length - 1;
          const block = output.content[idx];
          if (block.type === "thinking") {
            block.thinking += event.text;
            stream.push({ type: "thinking_delta", contentIndex: idx, delta: event.text, partial: output });
          }
        } else if (event.kind === "tool_call_start") {
          closeText();
          closeThinking();
          closeTool();
          toolId = event.id;
          toolName = event.name;
          partialJson = "";
          output.content.push({ type: "toolCall", id: event.id, name: event.name, arguments: {} });
          toolIndex = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
        } else if (event.kind === "tool_call_args") {
          if (toolIndex < 0) continue;
          partialJson += event.argsDelta;
          const block = output.content[toolIndex];
          if (block.type === "toolCall") {
            try {
              block.arguments = JSON.parse(partialJson);
            } catch {
              // incomplete json
            }
          }
          stream.push({ type: "toolcall_delta", contentIndex: toolIndex, delta: event.argsDelta, partial: output });
        } else if (event.kind === "finish") {
          closeText();
          closeThinking();
          closeTool();
          // streamChatEvents throws next, so a cut-off tool call never runs with {} args.
          if (event.reason === "content_filter") continue;
          output.stopReason =
            event.reason === "tool_calls" ? "toolUse" : event.reason === "length" ? "length" : "stop";
        } else if (event.kind === "usage") {
          output.usage.input = event.promptTokens ?? 0;
          output.usage.output = event.completionTokens ?? 0;
          output.usage.cacheRead = event.cachedInputTokens ?? 0;
          output.usage.cacheWrite = event.cacheCreationInputTokens ?? 0;
          output.usage.totalTokens = event.totalTokens ?? output.usage.input + output.usage.output;
          calculateCost(model, output.usage);
        }
      }

      closeText();
      closeThinking();
      closeTool();
      // Gemini finishes tool-call replies as plain "stop"; report toolUse like the other models do.
      if (output.stopReason !== "length" && output.content.some((block) => block.type === "toolCall")) {
        output.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
      stream.end();
    }
  })();

  return stream;
}
