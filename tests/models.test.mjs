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
