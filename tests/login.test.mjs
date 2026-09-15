import assert from "node:assert/strict";
import test from "node:test";

const { pkcePair, buildLoginUrl, startCallbackServer } = await import("../.test-dist/src/login.js");

test("pkce verifier/challenge follow S256 PKCE shape", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.ok(!/[+/=]/.test(verifier) && !/[+/=]/.test(challenge));
});

test("login URL carries PKCE params over /devin/account/login", () => {
  const url = new URL(buildLoginUrl("http://127.0.0.1:49152/callback", "abc123"));
  assert.equal(url.origin + url.pathname, "https://app.devin.ai/auth/cli/continue");
  assert.equal(url.searchParams.get("cli_pkce_marker"), "1");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:49152/callback");
  assert.equal(url.searchParams.get("redirect_parameters_type"), "query");
  assert.equal(url.searchParams.get("code_challenge"), "abc123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("state"));
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
