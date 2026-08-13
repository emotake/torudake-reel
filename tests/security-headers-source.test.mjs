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
  assert.match(source, /default-src 'self'/);
  assert.match(source, /script-src 'self' 'unsafe-inline'/);
  assert.match(source, /'wasm-unsafe-eval'/);
  assert.match(source, /connect-src 'self'/);
  assert.match(source, /connect-src 'self' blob:/);
  assert.match(source, /media-src 'self' blob:/);
  assert.match(source, /form-action 'self'/);
  assert.match(source, /frame-ancestors 'none'/);
  assert.match(source, /Strict-Transport-Security/);
  assert.match(source, /Permissions-Policy/);
  assert.match(source, /X-Robots-Tag/);
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /url\.pathname\.startsWith\("\/internal\/"\)/);
  assert.match(source, /url\.hostname !== "torudake-reel\.pages\.dev"/);
});
