import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routes = [
  "../app/api/transfers/init/route.ts",
  "../app/api/transfers/[id]/route.ts",
  "../app/api/transfers/[id]/part/route.ts",
  "../app/api/transfers/[id]/complete/route.ts",
  "../app/api/transfers/by-code/[code]/route.ts",
];

test("disabled transfer storage fails explicitly before route work", async () => {
  const transferSource = await readFile(
    new URL("../lib/transfers.ts", import.meta.url),
    "utf8",
  );
  assert.match(transferSource, /export function isMediaTransferAvailable/);
  assert.match(transferSource, /現在利用できません。", 503/);

  for (const route of routes) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /if \(!isMediaTransferAvailable\(\)\)/, route);
    assert.match(source, /return mediaTransferUnavailable\(\)/, route);
  }
});

test("disabled transfer storage returns a stable 503 response", async () => {
  globalThis.__cloudflareEnv = {};
  try {
    const routeUrl = new URL(
      "../app/api/transfers/init/route.ts",
      import.meta.url,
    );
    routeUrl.searchParams.set("disabled-media", String(Date.now()));
    const { POST } = await import(routeUrl.href);
    const response = await POST(
      new Request("https://torudake-reel.pages.dev/api/transfers/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "video.mp4",
          contentType: "video/mp4",
          size: 1024,
        }),
      }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "動画の受け渡し機能は現在利用できません。",
    });
  } finally {
    delete globalThis.__cloudflareEnv;
  }
});
