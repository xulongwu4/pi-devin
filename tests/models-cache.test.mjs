import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-devin-catalog-"));
const cacheHome = join(root, "cache");
process.env.XDG_CACHE_HOME = cacheHome;

const { loadCatalog } = await import("../.test-dist/src/catalog.js");
const { modelsFromCatalog } = await import("../.test-dist/src/models.js");
const {
  encodeFixed32Field, encodeFixed64Field, encodeMessage, encodeString, encodeVarintField, iterFields,
} = await import("../.test-dist/src/wire.js");
const cachePath = join(cacheHome, "pi", "devin", "models.json");

// Each test resets the cache dir in `finally`; the temp root goes once, after all tests.
after(() => rmSync(root, { recursive: true, force: true }));

function modelConfig(uid, label, family, disabled = false) {
  // Live rows carry context in ModelInfo.4 (field 18 is absent on ~all rows).
  const info = Buffer.concat([encodeVarintField(4, 200_000), encodeVarintField(13, 64_000), encodeString(23, family)]);
  const familyMetadata = encodeString(1, "Test Family");
  return Buffer.concat([
    encodeString(1, label),
    encodeVarintField(4, disabled ? 1 : 0),
    encodeString(22, uid),
    encodeMessage(23, info),
    encodeMessage(30, familyMetadata),
  ]);
}

const modelsResponse = Buffer.concat([
  encodeMessage(1, modelConfig("test-family-high", "Test Family High", "test-family", true)),
  encodeMessage(1, modelConfig("other-family-medium", "Other Family Medium", "other-family", true)),
]);

function metadataFields(body) {
  const top = [...iterFields(Buffer.from(body))];
  const metadata = top.find((field) => field.num === 1)?.value;
  assert.equal(Buffer.isBuffer(metadata), true);
  return [...iterFields(metadata)];
}

test("fetches Devin Local models and falls back to cache", async () => {
  try {
    const requests = [];
    const fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(modelsResponse, { status: 200 });
    };

    const catalog = await loadCatalog({
      apiKey: "test-key",
      apiServerUrl: "https://example.test",
      fetch,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://example.test/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
    for (const request of requests) {
      assert.equal(request.init.headers.Authorization, "Basic test-key-test-key");
      assert.equal(request.init.headers["Content-Type"], "application/proto");
      assert.equal(request.init.headers["Connect-Protocol-Version"], "1");
      const fields = metadataFields(request.init.body);
      assert.equal(fields.find((field) => field.num === 1)?.value.toString(), "chisel");
      assert.equal(fields.find((field) => field.num === 3)?.value.toString(), "test-key");
      assert.equal(fields.find((field) => field.num === 7)?.value.toString(), "3000.3.27");
    }

    assert.equal(catalog.families.length, 2);
    assert.equal(catalog.families[0].family_uid, "test-family");
    assert.deepEqual(catalog.families.flatMap((family) => family.variants.map((variant) => variant.model_uid)), [
      "test-family-high",
      "other-family-medium",
    ]);
    assert.equal(existsSync(cachePath), true);
    assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), catalog);
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);

    const offline = async () => { throw new Error("network offline"); };
    assert.deepEqual(await loadCatalog({
      apiKey: "test-key",
      apiServerUrl: "https://example.test",
      fetch: offline,
    }), catalog);

    writeFileSync(cachePath, "not json");
    await assert.rejects(loadCatalog({
      apiKey: "test-key",
      apiServerUrl: "https://example.test",
      fetch: offline,
    }), /network offline/);
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
});

function costDimension(label, value, encodeValue = encodeFixed32Field) {
  return Buffer.concat([encodeString(1, label), encodeValue(2, value), encodeString(3, "1M tokens")]);
}

// Real fusion rows: ModelDimension {1: "Sidekick", 6: 4, 8: "Free", 9: 1} with no price (field 2).
function sidekickDimension(display) {
  return Buffer.concat([
    encodeString(1, "Sidekick"), encodeVarintField(6, 4), encodeString(8, display), encodeVarintField(9, 1),
  ]);
}

function pricedConfig(uid, family, tier, dims = []) {
  return Buffer.concat([
    encodeString(1, uid),
    encodeString(22, uid),
    encodeMessage(23, Buffer.concat([encodeVarintField(4, 200_000), encodeString(23, family)])),
    encodeMessage(30, encodeString(1, family)),
    ...(tier === undefined ? [] : [encodeVarintField(24, tier)]),
    ...dims.map((dim) => encodeMessage(32, dim)),
  ]);
}

async function fetchCatalog(...configs) {
  const body = Buffer.concat(configs.map((config) => encodeMessage(1, config)));
  return loadCatalog({
    apiKey: "test-key",
    apiServerUrl: "https://example.test",
    fetch: async () => new Response(body, { status: 200 }),
  });
}

function variantsByUid(catalog) {
  return Object.fromEntries(
    catalog.families.flatMap((family) => family.variants.map((variant) => [variant.model_uid, variant])),
  );
}

test("decodes ModelDimension prices and marks cost_tier 4 as Free", async () => {
  try {
    const catalog = await fetchCatalog(
      pricedConfig("opus-high", "opus", 3, [
        costDimension("Input", 5), costDimension("Cached input", 0.5), costDimension("Output", 25),
      ]),
      // float32 0.1 widens to 0.10000000149; a double-encoded price must also decode.
      pricedConfig("luna-high", "luna", 1, [
        costDimension("Input", 0.1), costDimension("Cached input", 0.01, encodeFixed64Field), costDimension("Output", 0.5),
      ]),
      pricedConfig("swe-2-high", "swe-2", 4),
      pricedConfig("fusion-high", "fusion", 3, [
        costDimension("Input", 5), costDimension("Output", 25), sidekickDimension("Free"),
      ]),
    );
    const variants = variantsByUid(catalog);

    assert.equal(variants["opus-high"].cost_tier, "3");
    assert.equal(variants["opus-high"].cost_summary, "$5 / 1M Input \u00b7 $0.5 / 1M Cached input \u00b7 $25 / 1M Output");
    assert.equal(variants["opus-high"].is_free, false);
    assert.deepEqual(variants["opus-high"].cost_dimensions, [
      { label: "Input", value: 5, unit: "1M tokens" },
      { label: "Cached input", value: 0.5, unit: "1M tokens" },
      { label: "Output", value: 25, unit: "1M tokens" },
    ]);
    assert.equal(variants["luna-high"].cost_summary, "$0.1 / 1M Input \u00b7 $0.01 / 1M Cached input \u00b7 $0.5 / 1M Output");
    assert.equal(variants["swe-2-high"].cost_tier, "4");
    assert.equal(variants["swe-2-high"].cost_summary, "Free");
    assert.equal(variants["swe-2-high"].is_free, true);
    assert.equal(variants["swe-2-high"].cost_dimensions, undefined);
    assert.equal(variants["fusion-high"].cost_summary, "$5 / 1M Input \u00b7 $25 / 1M Output \u00b7 Sidekick: Free");
    assert.equal(variants["fusion-high"].is_free, false);

    const models = Object.fromEntries(modelsFromCatalog(catalog).map((model) => [model.id, model]));
    assert.deepEqual(models["luna-high"].cost, { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.1 });
    assert.equal(models["swe-2-high"].name, "swe-2 (Free)");
    assert.equal(models["fusion-high"].name, "fusion");
    assert.deepEqual(models["fusion-high"].cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 5 });
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
});

test("cached pricing is only inherited when the live cost tier agrees", async () => {
  try {
    // Cached as Free (tier 4); live now reports a paid tier with no dimensions.
    await fetchCatalog(pricedConfig("x-high", "x", 4));
    const flipped = variantsByUid(await fetchCatalog(pricedConfig("x-high", "x", 3)))["x-high"];
    assert.equal(flipped.cost_tier, "3");
    assert.equal(flipped.cost_summary, undefined);
    assert.equal(flipped.is_free, undefined);

    // Same tier and no dimensions this time: keep the cached prices.
    await fetchCatalog(pricedConfig("y-high", "y", 2, [costDimension("Input", 1), costDimension("Output", 2)]));
    const kept = variantsByUid(await fetchCatalog(pricedConfig("y-high", "y", 2)))["y-high"];
    assert.equal(kept.cost_summary, "$1 / 1M Input \u00b7 $2 / 1M Output");
    assert.equal(kept.is_free, false);
    assert.equal(kept.cost_dimensions.length, 2);
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
});
