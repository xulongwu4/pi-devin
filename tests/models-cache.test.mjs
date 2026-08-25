import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-devin-cache-"));
const cacheHome = join(root, "cache");
const fakeCli = join(root, "devin");
const catalog = {
  families: [
    {
      family_label: "Test Family",
      family_uid: "test-family",
      slug: "test-family",
      variants: [{ model_uid: "test-family-high", label: "Test High" }],
    },
  ],
};

writeFileSync(
  fakeCli,
  `#!/usr/bin/env node
if (process.env.PI_DEVIN_TEST_CLI_FAIL) {
  console.error("fake CLI unavailable");
  process.exit(1);
}
console.log(${JSON.stringify(JSON.stringify(catalog))});
`,
);
chmodSync(fakeCli, 0o755);
process.env.XDG_CACHE_HOME = cacheHome;
process.env.DEVIN_CLI = fakeCli;

const { loadCliCatalog } = await import("../.test-dist/src/models.js");
const cachePath = join(cacheHome, "pi-devin", "models.json");

test("uses the cached catalog when the Devin CLI is unavailable", async () => {
  try {
    assert.deepEqual(await loadCliCatalog(), catalog);
    assert.equal(existsSync(cachePath), true);
    assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), catalog);
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);

    process.env.PI_DEVIN_TEST_CLI_FAIL = "1";
    assert.deepEqual(await loadCliCatalog(), catalog);

    writeFileSync(cachePath, "not json");
    await assert.rejects(loadCliCatalog(), /fake CLI unavailable/);
  } finally {
    delete process.env.PI_DEVIN_TEST_CLI_FAIL;
    rmSync(root, { recursive: true, force: true });
  }
});
