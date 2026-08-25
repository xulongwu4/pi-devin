import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-devin-catalog-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { loadCatalog } = await import("../.test-dist/src/catalog.js");
const { encodeMessage, encodeString, encodeVarintField, iterFields } = await import("../.test-dist/src/wire.js");
const cachePath = join(agentDir, "devin", "models.json");

function modelConfig(uid, label, family, disabled = false) {
  const info = Buffer.concat([encodeVarintField(13, 64_000), encodeString(23, family)]);
  const familyMetadata = encodeString(1, "Test Family");
  return Buffer.concat([
    encodeString(1, label),
    encodeVarintField(4, disabled ? 1 : 0),
    encodeVarintField(18, 200_000),
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
    rmSync(root, { recursive: true, force: true });
  }
});
