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

test("resolveModelUid maps family id through thinking levels", () => {
  assert.equal(resolveModelUid("swe-2", swe2Map), "swe-2-high");
  assert.equal(resolveModelUid("swe-2", swe2Map, "medium"), "swe-2-medium");
  assert.equal(resolveModelUid("swe-2-high", swe2Map), "swe-2-high");
});
