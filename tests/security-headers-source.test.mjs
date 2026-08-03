import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("adds baseline browser security headers at the public Pages entry", async () => {
  const source = await readFile(
    new URL("../cloudflare-pages-entry.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /X-Content-Type-Options/);
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /frame-ancestors 'none'/);
  assert.match(source, /Strict-Transport-Security/);
  assert.match(source, /Permissions-Policy/);
});
