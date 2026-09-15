import assert from "node:assert/strict";
import test from "node:test";

const { pkcePair, buildLoginUrl, startCallbackServer, exchangePkceCode } = await import("../.test-dist/src/login.js");

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

async function withMockedFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("exchangePkceCode reads sessionToken", async () => {
  await withMockedFetch(async () => jsonResponse({ sessionToken: "devin-session-token$abc" }), async () => {
    const got = await exchangePkceCode("code", "verifier", "http://127.0.0.1/callback");
    assert.equal(got.apiKey, "devin-session-token$abc");
  });
});

test("exchangePkceCode reads api_key", async () => {
  await withMockedFetch(async () => jsonResponse({ api_key: "k" }), async () => {
    const got = await exchangePkceCode("code", "verifier", "http://127.0.0.1/callback");
    assert.equal(got.apiKey, "k");
  });
});

test("exchangePkceCode throws on HTTP 500", async () => {
  await withMockedFetch(async () => new Response("boom", { status: 500 }), async () => {
    await assert.rejects(() => exchangePkceCode("code", "verifier", "http://127.0.0.1/callback"), /PKCE exchange HTTP 500/);
  });
});

test("exchangePkceCode rejects UUID userId without a known key field", async () => {
  await withMockedFetch(async () => jsonResponse({ userId: "550e8400-e29b-41d4-a716-446655440000" }), async () => {
    await assert.rejects(
      () => exchangePkceCode("code", "verifier", "http://127.0.0.1/callback"),
      /no recognizable API key/,
    );
  });
});

test("exchangePkceCode missing-key error includes truncated response shape", async () => {
  await withMockedFetch(async () => jsonResponse({ userId: "550e8400-e29b-41d4-a716-446655440000" }), async () => {
    await assert.rejects(
      () => exchangePkceCode("code", "verifier", "http://127.0.0.1/callback"),
      (err) => {
        assert.match(String(err), /no recognizable API key/);
        assert.match(String(err), /550e8400-e29b-41.../);
        return true;
      },
    );
  });
});
