import assert from "node:assert/strict";
import test from "node:test";

const {
  pkcePair,
  buildLoginUrl,
  startCallbackServer,
  exchangePkceCode,
  encodeExchangeRequest,
  decodeExchangeResponse,
} = await import("../.test-dist/src/login.js");
const { encodeString, iterFields } = await import("../.test-dist/src/wire.js");

test("pkce verifier/challenge follow S256 PKCE shape", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.ok(!/[+/=]/.test(verifier) && !/[+/=]/.test(challenge));
});

test("login URL carries PKCE params over /auth/cli/continue", () => {
  const url = new URL(buildLoginUrl("http://127.0.0.1:49152/callback", "abc123", "explicit-state"));
  assert.equal(url.origin + url.pathname, "https://app.devin.ai/auth/cli/continue");
  assert.equal(url.searchParams.get("cli_pkce_marker"), "1");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:49152/callback");
  assert.equal(url.searchParams.get("redirect_parameters_type"), "query");
  assert.equal(url.searchParams.get("code_challenge"), "abc123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "explicit-state");
  assert.equal(url.searchParams.get("prompt"), "select_account");
});

test("callback server validates state and returns the code", async () => {
  const controller = new AbortController();
  const pending = startCallbackServer("st4te", controller.signal);
  const redirectUri = await pending.redirectUri;
  const codePromise = pending.code;
  const rejected = assert.rejects(codePromise, /state mismatch/);
  const bad = await fetch(redirectUri + "?code=x&state=wrong");
  assert.equal(bad.status, 400);
  await rejected;

  const second = startCallbackServer("ok-state", controller.signal);
  const uri2 = await second.redirectUri;
  const codeP = second.code;
  const good = await fetch(uri2 + "?code=the-code&state=ok-state");
  assert.equal(good.status, 200);
  assert.equal(await codeP, "the-code");
  second.close();
  controller.abort();
});

test("encodeExchangeRequest is code=1, verifier=2, redirect_uri=3", () => {
  const buf = encodeExchangeRequest("the-code", "the-verifier", "http://127.0.0.1/callback");
  const fields = Object.fromEntries(
    [...iterFields(buf)].map((f) => [f.num, Buffer.isBuffer(f.value) ? f.value.toString("utf8") : f.value]),
  );
  assert.deepEqual(fields, {
    1: "the-code",
    2: "the-verifier",
    3: "http://127.0.0.1/callback",
  });
});

test("decodeExchangeResponse reads session token from proto field 1", () => {
  const buf = encodeString(1, "devin-session-token$abc");
  assert.deepEqual(decodeExchangeResponse(buf), { apiKey: "devin-session-token$abc", apiServerUrl: undefined });
});

test("decodeExchangeResponse reads api_server_url from proto field 3 when it is a URL", () => {
  const buf = Buffer.concat([
    encodeString(1, "k"),
    encodeString(3, "https://server.eu.codeium.com"),
  ]);
  assert.deepEqual(decodeExchangeResponse(buf), {
    apiKey: "k",
    apiServerUrl: "https://server.eu.codeium.com",
  });
});

test("decodeExchangeResponse ignores a non-URL field 3", () => {
  const buf = Buffer.concat([encodeString(1, "k"), encodeString(3, "primary-org-id")]);
  assert.deepEqual(decodeExchangeResponse(buf), { apiKey: "k", apiServerUrl: undefined });
});

test("decodeExchangeResponse throws when field 1 is missing", () => {
  assert.throws(() => decodeExchangeResponse(encodeString(2, "nope")), /no session token/);
});

async function withMockedFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("exchangePkceCode posts Connect unary proto and decodes field 1", async () => {
  let requestUrl = "";
  let requestInit;
  await withMockedFetch(async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(encodeString(1, "devin-session-token$abc"), {
      status: 200,
      headers: { "Content-Type": "application/proto" },
    });
  }, async () => {
    const got = await exchangePkceCode("code", "verifier", "http://127.0.0.1/callback");
    assert.equal(got.apiKey, "devin-session-token$abc");
  });
  assert.equal(
    requestUrl,
    "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode",
  );
  assert.equal(requestInit.method, "POST");
  assert.equal(requestInit.headers["Content-Type"], "application/proto");
  assert.equal(requestInit.headers["Connect-Protocol-Version"], "1");
  const sent = Buffer.from(requestInit.body);
  const fields = Object.fromEntries(
    [...iterFields(sent)].map((f) => [f.num, Buffer.isBuffer(f.value) ? f.value.toString("utf8") : f.value]),
  );
  assert.deepEqual(fields, { 1: "code", 2: "verifier", 3: "http://127.0.0.1/callback" });
});

test("exchangePkceCode throws on HTTP 500", async () => {
  await withMockedFetch(async () => new Response("boom", { status: 500 }), async () => {
    await assert.rejects(() => exchangePkceCode("code", "verifier", "http://127.0.0.1/callback"), /PKCE exchange HTTP 500/);
  });
});
