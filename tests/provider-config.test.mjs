import assert from "node:assert/strict";
import test from "node:test";

const extension = (await import("../.test-dist/extensions/index.js")).default;

test("uses Pi OAuth credentials and the model baseUrl", async () => {
  let provider;
  const pi = {
    registerProvider(value) { provider = value; },
    registerCommand() {},
    on() {},
  };
  extension(pi);
  assert.equal(provider.id, "devin");
  assert.equal(provider.auth.oauth !== undefined, true);

  const auth = await provider.auth.oauth.toAuth({
    type: "oauth",
    refresh: "",
    access: "auth-json-key",
    expires: Date.now() + 60_000,
  });
  assert.deepEqual(auth, { apiKey: "auth-json-key" });

  const model = {
    ...provider.getModels()[0],
    baseUrl: "http://127.0.0.1:9999/route_to/https://server.codeium.com",
  };
  let requestedUrl;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    throw new Error("probe stop");
  };
  try {
    provider.streamSimple(model, { messages: [] }, { apiKey: "auth-json-key" });
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    requestedUrl,
    "http://127.0.0.1:9999/route_to/https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt",
  );
});
