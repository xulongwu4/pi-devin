import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { DevinCatalog, DevinCostDimension, DevinFamily, DevinVariant } from "./catalog.js";

export type { DevinCatalog, DevinCostDimension, DevinFamily, DevinVariant } from "./catalog.js";

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function parseAmount(summary: string, pattern: RegExp): number | undefined {
  const match = summary.match(pattern);
  return match ? Number(match[1]) : undefined;
}

// Structured ModelDimension rows are authoritative. Labels are matched exactly so
// fusion rows such as `Sidekick input` never overwrite the primary model's price.
function costFromDimensions(dims: DevinCostDimension[]): ProviderModelConfig["cost"] | undefined {
  const byLabel = new Map(dims.flatMap((dim) => (
    dim.value === undefined ? [] : [[dim.label.trim().toLowerCase(), dim.value] as const]
  )));
  const input = byLabel.get("input");
  const output = byLabel.get("output");
  if (input === undefined && output === undefined) return undefined;
  const inCost = input ?? 0;
  return {
    input: inCost,
    output: output ?? 0,
    cacheRead: byLabel.get("cached input") ?? byLabel.get("cache read") ?? Number((inCost * 0.1).toFixed(4)),
    // Devin publishes no cache-write price; bill writes at the input rate unless one appears.
    cacheWrite: byLabel.get("cache write") ?? inCost,
  };
}

// Fallback for caches written before `cost_dimensions` existed.
// CLI: `$5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output`; legacy: `$5 / MTok In`.
const PRICE = String.raw`\$([0-9.]+)\s*\/\s*(?:1M(?:\s+tokens)?|MTok)\s+`;
const INPUT_PRICE = new RegExp(String.raw`${PRICE}In(?:put)?\b`, "i");
const OUTPUT_PRICE = new RegExp(String.raw`${PRICE}Out(?:put)?\b`, "i");
const CACHED_INPUT_PRICE = new RegExp(String.raw`${PRICE}Cached\s+input\b`, "i");

function costFromSummary(summary?: string): ProviderModelConfig["cost"] {
  if (!summary || /^free$/i.test(summary.trim())) return { ...EMPTY_COST };
  const input = parseAmount(summary, INPUT_PRICE);
  const output = parseAmount(summary, OUTPUT_PRICE);
  const cacheRead = parseAmount(summary, CACHED_INPUT_PRICE);
  if (input === undefined && output === undefined) return { ...EMPTY_COST };
  const inCost = input ?? 0;
  return {
    input: inCost,
    output: output ?? 0,
    cacheRead: cacheRead ?? Number((inCost * 0.1).toFixed(4)),
    cacheWrite: Number((inCost * 1.25).toFixed(4)),
  };
}

function parseCost(variant: DevinVariant): ProviderModelConfig["cost"] {
  return (variant.cost_dimensions && costFromDimensions(variant.cost_dimensions))
    ?? costFromSummary(variant.cost_summary);
}

function isFreeVariant(variant: DevinVariant): boolean {
  if (variant.is_free !== undefined) return variant.is_free;
  // Legacy caches: no is_free flag yet.
  const summary = variant.cost_summary?.trim();
  if (summary && /^free$/i.test(summary)) return true;
  if (summary && /\$[0-9]/.test(summary)) return false;
  return variant.cost_tier === "4";
}

// Free status is display-only: the Pi id stays stable (Pi's /model search also matches name).
function freeName(name: string): string {
  const trimmed = name.trim();
  return /[([]\s*free\s*[)\]]$/i.test(trimmed) ? trimmed : `${trimmed} (Free)`;
}

function variantKey(uid: string): string | null {
  uid = uid.toLowerCase().replaceAll("_", "-");
  const suffixes = [
    "none-priority",
    "low-priority",
    "medium-priority",
    "high-priority",
    "xhigh-priority",
    "max-priority",
    "low-fast",
    "medium-fast",
    "high-fast",
    "xhigh-fast",
    "max-fast",
    "thinking-1m",
    "thinking",
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "minimal",
  ];
  for (const suffix of suffixes) {
    if (uid === suffix || uid.endsWith(`-${suffix}`)) return suffix;
  }
  return null;
}

function thinkingFromSuffix(suffix: string | null): keyof ThinkingLevelMap | null {
  if (!suffix) return "high";
  if (suffix === "none" || suffix === "none-priority") return "off";
  if (suffix === "minimal") return "minimal";
  if (suffix.startsWith("low")) return "low";
  if (suffix.startsWith("medium")) return "medium";
  if (suffix.startsWith("high") && !suffix.startsWith("xhigh")) return "high";
  if (suffix.startsWith("xhigh")) return "xhigh";
  if (suffix.startsWith("max")) return "max";
  if (suffix.includes("thinking")) return "high";
  return null;
}

function preferredDefault(map: ThinkingLevelMap): string | undefined {
  for (const level of ["high", "medium", "max", "xhigh", "low", "minimal", "off"] as const) {
    const value = map[level];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function familyToModels(family: DevinFamily): ProviderModelConfig[] {
  const usable = family.variants.filter((variant) => {
    const key = variantKey(variant.model_uid);
    return !key || (!key.includes("priority") && !key.includes("fast") && key !== "thinking-1m");
  });
  const source = usable.length > 0 ? usable : family.variants;
  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const variant of source) {
    const level = thinkingFromSuffix(variantKey(variant.model_uid));
    if (level && thinkingLevelMap[level] === undefined) {
      thinkingLevelMap[level] = variant.model_uid;
    }
  }

  const defaultUid = preferredDefault(thinkingLevelMap) ?? source[0]?.model_uid ?? family.family_uid;
  const sample = source.find((variant) => variant.model_uid === defaultUid) ?? source[0];
  if (!sample) return [];

  const mappedLevels = THINKING_ORDER.filter((level) => typeof thinkingLevelMap[level] === "string");
  const reasoning = mappedLevels.length > 1;
  // Pi's picker displays the id, not the name. Keep wire enums in the routing map.
  const familyId = [family.family_uid, family.slug].find((value) => value && !value.startsWith("MODEL_"))
    || family.family_label.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "")
    || defaultUid;
  const id = reasoning || defaultUid.startsWith("MODEL_") ? familyId : defaultUid;
  const name = family.family_label || family.slug || defaultUid;

  return [
    {
      id,
      name: isFreeVariant(sample) ? freeName(name) : name,
      reasoning,
      thinkingLevelMap: reasoning || id !== defaultUid ? thinkingLevelMap : undefined,
      input: ["text", "image"],
      cost: parseCost(sample),
      contextWindow: sample.max_context_tokens ?? 256_000,
      maxTokens: sample.max_output_tokens ?? 128_000,
    },
  ];
}

export const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    reasoning: true,
    thinkingLevelMap: {
      low: "claude-opus-5-low",
      medium: "claude-opus-5-medium",
      high: "claude-opus-5-high",
      xhigh: "claude-opus-5-xhigh",
      max: "claude-opus-5-max",
    },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-5-fable",
    name: "Claude Fable 5",
    reasoning: true,
    thinkingLevelMap: {
      low: "claude-5-fable-low",
      medium: "claude-5-fable-medium",
      high: "claude-5-fable-high",
      xhigh: "claude-5-fable-xhigh",
      max: "claude-5-fable-max",
    },
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5-6-sol",
    name: "GPT-5.6 Sol",
    reasoning: true,
    thinkingLevelMap: {
      off: "gpt-5-6-sol-none",
      low: "gpt-5-6-sol-low",
      medium: "gpt-5-6-sol-medium",
      high: "gpt-5-6-sol-high",
      xhigh: "gpt-5-6-sol-xhigh",
      max: "gpt-5-6-sol-max",
    },
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "swe-1-7",
    name: "SWE-1.7",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_000,
    maxTokens: 128_000,
  },
];

export function modelsFromCatalog(catalog: DevinCatalog | null): ProviderModelConfig[] {
  if (!catalog?.families?.length) return FALLBACK_MODELS;
  const models = catalog.families.flatMap(familyToModels);
  return models.length > 0 ? models : FALLBACK_MODELS;
}

export function resolveModelUid(
  modelId: string,
  thinkingLevelMap: ThinkingLevelMap | undefined,
  reasoning?: string,
): string {
  if (reasoning && thinkingLevelMap) {
    const mapped = thinkingLevelMap[reasoning as keyof ThinkingLevelMap];
    if (typeof mapped === "string") return mapped;
  }
  if (thinkingLevelMap) {
    const fallback = preferredDefault(thinkingLevelMap);
    if (fallback) return fallback;
  }
  return modelId;
}
