import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { encodeMessage, encodeString, iterFields } from "./wire.js";

export interface DevinVariant {
  model_uid: string;
  label: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  cost_tier?: string;
  cost_summary?: string;
  is_new?: boolean;
  is_beta?: boolean;
}

export interface DevinFamily {
  family_label: string;
  family_uid: string;
  slug: string;
  aliases?: string[];
  variants: DevinVariant[];
}

export interface DevinCatalog {
  families: DevinFamily[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LoadCatalogOptions {
  apiKey: string;
  apiServerUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface LiveModelConfig {
  uid: string;
  label: string;
  familyUid: string;
  familyLabel: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  costTier?: number;
}

const CACHE_PATH = join(getAgentDir(), "devin", "models.json");
const MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
// Minimal metadata version verified live without the CLI's opaque fingerprint fields.
const PROTOCOL_VERSION = "3000.3.27";

function parseCatalog(text: string): DevinCatalog | null {
  const parsed = JSON.parse(text) as DevinCatalog;
  return Array.isArray(parsed?.families) ? parsed : null;
}

function readCachedCatalog(): DevinCatalog | null {
  try {
    return parseCatalog(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeCachedCatalog(catalog: DevinCatalog): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(catalog, null, 2), { mode: 0o600 });
  } catch {
    // A cache write failure must not hide a valid live catalog.
  }
}

function metadata(apiKey: string): Buffer {
  return Buffer.concat([
    encodeString(1, "chisel"),
    encodeString(2, PROTOCOL_VERSION),
    encodeString(3, apiKey),
    encodeString(4, "en"),
    encodeString(5, process.platform),
    encodeString(7, PROTOCOL_VERSION),
  ]);
}

async function postUnary(
  path: string,
  options: LoadCatalogOptions,
  signal: AbortSignal,
): Promise<Buffer> {
  const baseUrl = options.apiServerUrl.replace(/\/$/, "");
  const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${options.apiKey}-${options.apiKey}`,
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
    },
    body: new Uint8Array(encodeMessage(1, metadata(options.apiKey))),
    signal,
  });
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) throw new Error(`${path} returned an empty response`);
  return body;
}

function messageField(body: Buffer, number: number): Buffer | undefined {
  for (const field of iterFields(body)) {
    if (field.num === number && field.wire === 2 && Buffer.isBuffer(field.value)) return field.value;
  }
  return undefined;
}

function stringField(body: Buffer, number: number): string {
  return messageField(body, number)?.toString("utf8") ?? "";
}

function varintField(body: Buffer, number: number): number | undefined {
  for (const field of iterFields(body)) {
    if (field.num === number && field.wire === 0) return Number(field.value);
  }
  return undefined;
}

function decodeModelConfig(body: Buffer): LiveModelConfig | null {
  // field 4 `disabled` is Cascade/cloud availability. The Devin CLI deliberately
  // lists these rows because they remain routable through Devin Local.
  const uid = stringField(body, 22).trim();
  if (!uid) return null;
  const modelInfo = messageField(body, 23);
  const familyMetadata = messageField(body, 30);
  return {
    uid,
    label: stringField(body, 1).trim() || uid,
    familyUid: modelInfo ? stringField(modelInfo, 23).trim() : "",
    familyLabel: familyMetadata ? stringField(familyMetadata, 1).trim() : "",
    contextWindow: varintField(body, 18),
    maxOutputTokens: modelInfo ? varintField(modelInfo, 13) : undefined,
    costTier: varintField(body, 24),
  };
}

function decodeModelConfigs(body: Buffer): LiveModelConfig[] {
  const configs: LiveModelConfig[] = [];
  for (const field of iterFields(body)) {
    if (field.num !== 1 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    const config = decodeModelConfig(field.value);
    if (config) configs.push(config);
  }
  return configs;
}

function deriveFamilyUid(uid: string): string {
  return uid.replace(/-(?:none|minimal|low|medium|high|xhigh|max|thinking)(?:-(?:priority|fast))?$/, "");
}

function deriveFamilyLabel(label: string): string {
  return label.replace(/\s+(?:No Thinking|Minimal|Low|Medium|High|XHigh|Max)(?: Thinking)?$/i, "");
}

function normalizeCatalog(configs: LiveModelConfig[], cached: DevinCatalog | null): DevinCatalog {
  const cachedVariants = new Map<string, { family: DevinFamily; variant: DevinVariant }>();
  for (const family of cached?.families ?? []) {
    for (const variant of family.variants) cachedVariants.set(variant.model_uid, { family, variant });
  }

  const groups = new Map<string, DevinFamily>();
  const add = (config: LiveModelConfig, cachedEntry?: { family: DevinFamily; variant: DevinVariant }) => {
    const familyUid = cachedEntry?.family.family_uid || config.familyUid || deriveFamilyUid(config.uid);
    let family = groups.get(familyUid);
    if (!family) {
      family = {
        family_label: cachedEntry?.family.family_label || config.familyLabel || deriveFamilyLabel(config.label),
        family_uid: familyUid,
        slug: cachedEntry?.family.slug || familyUid,
        aliases: cachedEntry?.family.aliases ?? [],
        variants: [],
      };
      groups.set(familyUid, family);
    }
    const old = cachedEntry?.variant;
    const variant: DevinVariant = { model_uid: config.uid, label: config.label };
    const contextWindow = config.contextWindow || old?.max_context_tokens;
    const maxOutputTokens = config.maxOutputTokens || old?.max_output_tokens;
    const costTier = config.costTier === undefined ? old?.cost_tier : String(config.costTier);
    if (contextWindow !== undefined) variant.max_context_tokens = contextWindow;
    if (maxOutputTokens !== undefined) variant.max_output_tokens = maxOutputTokens;
    if (costTier !== undefined) variant.cost_tier = costTier;
    if (old?.cost_summary !== undefined) variant.cost_summary = old.cost_summary;
    if (old?.is_new !== undefined) variant.is_new = old.is_new;
    if (old?.is_beta !== undefined) variant.is_beta = old.is_beta;
    family.variants.push(variant);
  };

  for (const config of configs) add(config, cachedVariants.get(config.uid));
  return { families: [...groups.values()] };
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`catalog timeout after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export async function loadCatalog(options: LoadCatalogOptions): Promise<DevinCatalog> {
  const timeout = timeoutSignal(options.signal, options.timeoutMs ?? 15_000);
  try {
    const configsBody = await postUnary(MODEL_CONFIGS_PATH, options, timeout.signal);
    const configs = decodeModelConfigs(configsBody);
    if (configs.length === 0) throw new Error("GetCliModelConfigs returned no routable models");
    const catalog = normalizeCatalog(configs, readCachedCatalog());
    if (catalog.families.length === 0) throw new Error("Devin Local catalog is empty");
    writeCachedCatalog(catalog);
    return catalog;
  } catch (error) {
    const cached = readCachedCatalog();
    if (cached) return cached;
    throw error;
  } finally {
    timeout.clear();
  }
}
