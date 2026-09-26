import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodeMessage, encodeString, iterFields } from "./wire.js";

/**
 * One `ClientModelConfig.32` (ModelDimension) row: a price (`Input` / 5 / `1M tokens`)
 * or, for fusion sidekicks, a price-less label (`Sidekick` / display `Free`).
 */
export interface DevinCostDimension {
  label: string;
  value?: number;
  unit?: string;
  display?: string;
}

export interface DevinVariant {
  model_uid: string;
  label: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  cost_tier?: string;
  /** Display string in the Devin CLI format; structured prices live in `cost_dimensions`. */
  cost_summary?: string;
  cost_dimensions?: DevinCostDimension[];
  is_free?: boolean;
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
  costDimensions: DevinCostDimension[];
}

const CACHE_PATH = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi", "devin", "models.json");
const MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
// Minimal metadata version verified live without the CLI's opaque fingerprint fields.
const PROTOCOL_VERSION = "3000.3.27";

function parseCatalog(text: string): DevinCatalog | null {
  const parsed = JSON.parse(text) as DevinCatalog;
  return Array.isArray(parsed?.families) ? parsed : null;
}

export function loadCachedCatalog(): DevinCatalog | null {
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

// Prices are `float` (wire 5) on the wire today; accept `double` (wire 1) too so a
// proto type change cannot silently drop every dimension.
function floatingField(body: Buffer, number: number): number | undefined {
  for (const field of iterFields(body)) {
    if (field.num !== number || !Buffer.isBuffer(field.value)) continue;
    // float32 carries ~7 significant digits; drop the widening noise (0.1 -> 0.10000000149).
    if (field.wire === 5) return Number(field.value.readFloatLE(0).toPrecision(7));
    if (field.wire === 1) return field.value.readDoubleLE(0);
  }
  return undefined;
}

function formatUsd(value: number): string {
  return String(Math.round(value * 1e4) / 1e4);
}

function decodeCostDimension(body: Buffer): DevinCostDimension | null {
  const label = stringField(body, 1).trim();
  if (!label) return null;
  const value = floatingField(body, 2);
  if (value !== undefined && Number.isFinite(value)) {
    const unit = stringField(body, 3).trim();
    return unit ? { label, value, unit } : { label, value };
  }
  // Price-less rows carry a display string in field 8, e.g. fusion `Sidekick` -> `Free`.
  const display = stringField(body, 8).trim();
  return display ? { label, display } : null;
}

function decodeCostDimensions(body: Buffer): DevinCostDimension[] {
  const dims: DevinCostDimension[] = [];
  for (const field of iterFields(body)) {
    if (field.num !== 32 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    const dim = decodeCostDimension(field.value);
    if (dim) dims.push(dim);
  }
  return dims;
}

// Match the Devin CLI: `$5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output`,
// plus price-less rows as `Sidekick: Free`.
function formatCostSummary(dims: DevinCostDimension[]): string {
  return dims.map((dim) => {
    if (dim.value === undefined) return `${dim.label}: ${dim.display}`;
    const unit = (dim.unit ?? "1M tokens").replace(/\s*tokens$/i, "").trim() || "1M";
    return `$${formatUsd(dim.value)} / ${unit} ${dim.label}`;
  }).join(" \u00b7 ");
}

type VariantPricing = Pick<DevinVariant, "cost_summary" | "cost_dimensions" | "is_free">;

function pricingFor(config: LiveModelConfig, old?: DevinVariant): VariantPricing {
  const dims = config.costDimensions;
  if (dims.length > 0) {
    const prices = dims.flatMap((dim) => (dim.value === undefined ? [] : [dim.value]));
    const isFree = prices.length > 0 ? prices.every((value) => value === 0) : config.costTier === 4;
    return { cost_summary: formatCostSummary(dims), cost_dimensions: dims, is_free: isFree };
  }
  // cost_tier 4 + no ModelDimension rows is how the CLI marks SWE-2 as Free.
  if (config.costTier === 4) return { cost_summary: "Free", is_free: true };
  // Only reuse cached pricing when the live tier does not contradict it.
  if (!old || (config.costTier !== undefined && String(config.costTier) !== old.cost_tier)) return {};
  const pricing: VariantPricing = {};
  if (old.cost_summary !== undefined) pricing.cost_summary = old.cost_summary;
  if (old.cost_dimensions !== undefined) pricing.cost_dimensions = old.cost_dimensions;
  if (old.is_free !== undefined) pricing.is_free = old.is_free;
  return pricing;
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
    contextWindow: modelInfo ? varintField(modelInfo, 4) : undefined,
    maxOutputTokens: modelInfo ? varintField(modelInfo, 13) : undefined,
    costTier: varintField(body, 24),
    costDimensions: decodeCostDimensions(body),
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
    Object.assign(variant, pricingFor(config, old));
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
    const catalog = normalizeCatalog(configs, loadCachedCatalog());
    if (catalog.families.length === 0) throw new Error("Devin Local catalog is empty");
    writeCachedCatalog(catalog);
    return catalog;
  } catch (error) {
    const cached = loadCachedCatalog();
    if (cached) return cached;
    throw error;
  } finally {
    timeout.clear();
  }
}
