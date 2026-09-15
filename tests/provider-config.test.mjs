import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-devin-provider-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const extension = (await import("../.test-dist/extensions/index.js")).default;

test("keeps catalog URL fixed while inference uses model baseUrl", async () => {
  let provider;
  const pi = {
    registerProvider(value) { provider = value; },
    registerCommand() {},
    on() {},
  };
  extension(pi);
  assert.equal(provider.id, "devin");
  assert.equal(provider.auth.oauth !== undefined, true);

  const credential = {
    type: "oauth",
    refresh: "",
    access: "auth-json-key",
    expires: Date.now() + 60_000,
  };
  assert.deepEqual(await provider.auth.oauth.toAuth(credential), { apiKey: "auth-json-key" });

  const requestedUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    throw new Error("probe stop");
  };
  try {
    await assert.rejects(provider.refreshModels({
      credential,
      allowNetwork: true,
      signal: new AbortController().signal,
      async publish(publication) {
        publication.update?.();
        return true;
      },
    }), /probe stop/);
    assert.equal(
      requestedUrls.shift(),
      "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs",
    );

    const model = {
      ...provider.getModels()[0],
      baseUrl: "http://127.0.0.1:9999/route_to/https://server.codeium.com",
    };
    provider.streamSimple(model, { messages: [] }, { apiKey: "auth-json-key" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      requestedUrls.shift(),
      "http://127.0.0.1:9999/route_to/https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt",
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
