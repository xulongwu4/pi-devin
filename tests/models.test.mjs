import assert from "node:assert/strict";
import test from "node:test";

const { modelsFromCatalog, resolveModelUid } = await import("../.test-dist/src/models.js");

const swe2Catalog = {
  devinClientVersion: "test",
  fetchedAt: new Date().toISOString(),
  families: [
    {
      family_label: "SWE-2",
      family_uid: "swe-2",
      slug: "swe-2",
      aliases: [],
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High" },
        { model_uid: "swe-2-medium", label: "SWE-2 Medium" },
        { model_uid: "swe-2-max", label: "SWE-2 Max" },
      ],
    },
  ],
};

const singleVariantCatalog = {
  devinClientVersion: "test",
  fetchedAt: new Date().toISOString(),
  families: [
    {
      family_label: "SWE-1.6",
      family_uid: "swe-1.6",
      slug: "swe-1.6",
      aliases: [],
      variants: [{ model_uid: "swe-1-6", label: "SWE-1.6" }],
    },
  ],
};

const swe2Map = {
  high: "swe-2-high",
  medium: "swe-2-medium",
  max: "swe-2-max",
};

test("multi-variant families use family_uid as pi model id", () => {
  const models = modelsFromCatalog(swe2Catalog);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "swe-2");
  assert.equal(models[0].name, "SWE-2");
  assert.equal(models[0].reasoning, true);
  assert.deepEqual(models[0].thinkingLevelMap, swe2Map);
});

test("single-variant families keep variant uid as pi model id", () => {
  const models = modelsFromCatalog(singleVariantCatalog);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "swe-1-6");
  assert.equal(models[0].reasoning, false);
  assert.equal(models[0].thinkingLevelMap, undefined);
});

test("enum variants use a family id and preserve backend thinking-level UIDs", () => {
  const levels = ["low", "medium", "none", "high", "xhigh"];
  const variants = ["high-priority", "high-fast", ...levels].map((level) => ({
    model_uid: `MODEL_GPT_5_2_${level.toUpperCase().replaceAll("-", "_")}`,
    label: `GPT-5.2 ${level}`,
  }));
  const [model] = modelsFromCatalog({ families: [{
    family_label: "GPT-5.2", family_uid: "gpt-5.2", slug: "gpt-5.2", variants,
  }] });
  assert.equal(model.id, "gpt-5.2");
  assert.equal(model.name, "GPT-5.2");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, {
    low: "MODEL_GPT_5_2_LOW", medium: "MODEL_GPT_5_2_MEDIUM",
    off: "MODEL_GPT_5_2_NONE", high: "MODEL_GPT_5_2_HIGH", xhigh: "MODEL_GPT_5_2_XHIGH",
  });
  assert.equal(resolveModelUid(model.id, model.thinkingLevelMap), "MODEL_GPT_5_2_HIGH");
  for (const level of levels) {
    assert.equal(resolveModelUid(model.id, model.thinkingLevelMap, level === "none" ? "off" : level),
      `MODEL_GPT_5_2_${level.toUpperCase()}`);
  }
});

test("enum-only families expose readable ids without changing backend routing", () => {
  for (const [familyUid, label, uid, expectedId] of [
    ["claude-opus-4.5", "Claude Opus 4.5", "MODEL_CLAUDE_4_5_OPUS", "claude-opus-4.5"],
    ["MODEL_PRIVATE_11", "Claude Haiku 4.5", "MODEL_PRIVATE_11", "claude-haiku-4.5"],
    ["MODEL_CHAT_GPT_4_1_2025_04_14", "GPT-4.1", "MODEL_CHAT_GPT_4_1_2025_04_14", "gpt-4.1"],
  ]) {
    const [model] = modelsFromCatalog({ families: [{
      family_label: label, family_uid: familyUid, slug: familyUid,
      variants: [{ model_uid: uid, label }],
    }] });
    assert.equal(model.id, expectedId);
    assert.equal(model.name, label);
    assert.equal(model.reasoning, false);
    assert.equal(resolveModelUid(model.id, model.thinkingLevelMap), uid);
    assert.equal(resolveModelUid(model.id, model.thinkingLevelMap, "off"), uid);
  }
});

test("resolveModelUid maps family id through thinking levels", () => {
  assert.equal(resolveModelUid("swe-2", swe2Map), "swe-2-high");
  assert.equal(resolveModelUid("swe-2", swe2Map, "medium"), "swe-2-medium");
  assert.equal(resolveModelUid("swe-2-high", swe2Map), "swe-2-high");
});

test("free catalog models keep their id, add (Free) to the name, and cost zero", () => {
  const [model] = modelsFromCatalog({
    families: [{
      family_label: "SWE-2", family_uid: "swe-2", slug: "swe-2",
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High", cost_tier: "4", cost_summary: "Free" },
        { model_uid: "swe-2-medium", label: "SWE-2 Medium", cost_tier: "4", cost_summary: "Free" },
        { model_uid: "swe-2-max", label: "SWE-2 Max", cost_tier: "4", cost_summary: "Free" },
      ],
    }],
  });
  assert.equal(model.id, "swe-2");
  assert.equal(model.name, "SWE-2 (Free)");
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(resolveModelUid(model.id, model.thinkingLevelMap), "swe-2-high");
  assert.equal(resolveModelUid(model.id, model.thinkingLevelMap, "medium"), "swe-2-medium");
});

test("legacy cache: cost_tier 4 without a summary is treated as free", () => {
  const [model] = modelsFromCatalog({
    families: [{
      family_label: "SWE-2", family_uid: "swe-2", slug: "swe-2",
      variants: [{ model_uid: "swe-2-high", label: "SWE-2 High", cost_tier: "4" }],
    }],
  });
  assert.equal(model.id, "swe-2-high");
  assert.equal(model.name, "SWE-2 (Free)");
  assert.equal(model.thinkingLevelMap, undefined);
  assert.equal(resolveModelUid(model.id, model.thinkingLevelMap), "swe-2-high");
});

test("(Free) is not appended twice", () => {
  for (const [label, expected] of [
    ["Promo (Free)", "Promo (Free)"],
    ["Promo (Free) ", "Promo (Free)"],
    ["Promo [Free]", "Promo [Free]"],
    ["Promo ", "Promo (Free)"],
  ]) {
    const [model] = modelsFromCatalog({
      families: [{
        family_label: label, family_uid: "promo", slug: "promo",
        variants: [{ model_uid: "promo", label: "Promo", is_free: true, cost_summary: "Free" }],
      }],
    });
    assert.equal(model.name, expected);
  }
});

test("price-less sidekick dimensions do not affect cost", () => {
  const [model] = modelsFromCatalog({
    families: [{
      family_label: "Fusion", family_uid: "fusion", slug: "fusion",
      variants: [{
        model_uid: "fusion", label: "Fusion", is_free: false,
        cost_dimensions: [
          { label: "Input", value: 5 }, { label: "Output", value: 25 }, { label: "Sidekick", display: "Free" },
        ],
      }],
    }],
  });
  assert.equal(model.name, "Fusion");
  assert.deepEqual(model.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 5 });
});

test("structured cost_dimensions win over cost_summary", () => {
  const [model] = modelsFromCatalog({
    families: [{
      family_label: "Opus", family_uid: "opus", slug: "opus",
      variants: [{
        model_uid: "opus-high", label: "Opus High", cost_tier: "3", is_free: false,
        cost_summary: "$999 / 1M Input",
        cost_dimensions: [
          { label: "Input", value: 5, unit: "1M tokens" },
          { label: "Cached input", value: 0.5, unit: "1M tokens" },
          { label: "Cache write", value: 6.25, unit: "1M tokens" },
          { label: "Output", value: 25, unit: "1M tokens" },
          { label: "Sidekick input", value: 1.4, unit: "1M tokens" },
          { label: "Sidekick output", value: 4.4, unit: "1M tokens" },
        ],
      }],
    }],
  });
  assert.equal(model.name, "Opus");
  assert.deepEqual(model.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
});

test("missing cache-write dimension bills writes at the input rate", () => {
  const [model] = modelsFromCatalog({
    families: [{
      family_label: "Luna", family_uid: "luna", slug: "luna",
      variants: [{
        model_uid: "luna", label: "Luna", is_free: false,
        cost_dimensions: [{ label: "Input", value: 0.1 }, { label: "Output", value: 0.5 }],
      }],
    }],
  });
  assert.deepEqual(model.cost, { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.1 });
});

test("all-$0 price dimensions count as free", () => {
  const [model] = modelsFromCatalog({
    families: [{
      family_label: "Zero", family_uid: "zero", slug: "zero",
      variants: [{
        model_uid: "zero", label: "Zero", is_free: true, cost_summary: "$0 / 1M Input \u00b7 $0 / 1M Output",
        cost_dimensions: [{ label: "Input", value: 0 }, { label: "Output", value: 0 }],
      }],
    }],
  });
  assert.equal(model.id, "zero");
  assert.equal(model.name, "Zero (Free)");
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(resolveModelUid(model.id, model.thinkingLevelMap), "zero");
});

test("summary regex does not treat other labels as Input/Output", () => {
  const [model] = modelsFromCatalog({
    families: [{
      family_label: "Odd", family_uid: "odd", slug: "odd",
      variants: [{ model_uid: "odd", label: "Odd", cost_summary: "$5 / 1M Internal \u00b7 $7 / 1M Outlier" }],
    }],
  });
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("priced catalog models parse CLI cost_summary", () => {
  const [model] = modelsFromCatalog({
    families: [{
      family_label: "Claude Opus 5", family_uid: "claude-opus-5", slug: "claude-opus-5",
      variants: [{
        model_uid: "claude-opus-5-high", label: "Claude Opus 5 High", cost_tier: "3",
        cost_summary: "$5 / 1M Input \u00b7 $0.5 / 1M Cached input \u00b7 $25 / 1M Output",
      }],
    }],
  });
  assert.equal(model.id, "claude-opus-5-high");
  assert.equal(model.name, "Claude Opus 5");
  assert.deepEqual(model.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
});

test("legacy MTok cost_summary still parses", () => {
  const [model] = modelsFromCatalog({
    families: [{
      family_label: "Legacy", family_uid: "legacy", slug: "legacy",
      variants: [{ model_uid: "legacy", label: "Legacy", cost_summary: "$2 / MTok In $10 / MTok Out" }],
    }],
  });
  assert.equal(model.id, "legacy");
  assert.deepEqual(model.cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
});
