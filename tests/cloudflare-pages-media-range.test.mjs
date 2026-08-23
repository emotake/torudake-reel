import assert from "node:assert/strict";
import test from "node:test";

const bytes = Uint8Array.from({ length: 10 }, (_, index) => index);
const assetRequests = [];

const env = {
  ASSETS: {
    async fetch(request) {
      assetRequests.push(request);
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: {
          "Content-Length": String(bytes.byteLength),
          "Content-Type": "video/mp4",
          ETag: '"demo-v1"',
        },
      });
    },
  },
};

const context = {
  passThroughOnException() {},
  waitUntil() {},
};

const { default: pagesWorker } = await import(
  new URL("../cloudflare-pages-entry.mjs", import.meta.url).href
);

async function requestMedia({
  method = "GET",
  path = "/demo/sample.mp4",
  range,
} = {}) {
  const headers = range ? { Range: range } : undefined;
  return pagesWorker.fetch(
    new Request(new URL(path, "https://torudake-reel.pages.dev"), {
      headers,
      method,
    }),
    env,
    context,
  );
}

test("returns 410 for every retired party preview without reading Pages assets", async () => {
  const retiredPaths = [
    "/demo/voices/party.wav",
    "/demo/voices/party-v2.wav",
    "/demo/voices/party-v3.wav",
    "/demo/voices/party-v4.wav",
    "/demo/voices/party-v5.wav",
    "/demo/voices/party-v6.wav",
  ];

  for (const path of retiredPaths) {
    const assetRequestCount = assetRequests.length;
    const response = await requestMedia({ path });
    assert.equal(response.status, 410, path);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(
      response.headers.get("cloudflare-cdn-cache-control"),
      "no-store",
    );
    assert.equal(response.headers.get("content-length"), "0");
    assert.equal(response.headers.get("content-type"), null);
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(assetRequests.length, assetRequestCount, path);
  }
});

test("keeps retired preview variants blocked for HEAD, Range, query, and encoded paths", async () => {
  for (const options of [
    { method: "HEAD", path: "/demo/voices/party-v6.wav" },
    { path: "/demo/voices/party-v6.wav", range: "bytes=0-9" },
    { path: "/demo/voices/party-v6.wav?cache-bust=1" },
    { path: "/demo/voices/%70arty-v6.wav" },
  ]) {
    const assetRequestCount = assetRequests.length;
    const response = await requestMedia(options);
    assert.equal(response.status, 410, JSON.stringify(options));
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("content-range"), null);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(assetRequests.length, assetRequestCount, JSON.stringify(options));
  }
});

test("continues to serve current public media through Pages assets", async () => {
  const assetRequestCount = assetRequests.length;
  const response = await requestMedia({
    path: "/demo/voices/comedy-v6.wav",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(assetRequests.length, assetRequestCount + 1);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=86400, stale-while-revalidate=604800",
  );
});

test("streams full public media with seek and cache metadata", async () => {
  const response = await requestMedia();

  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=86400, stale-while-revalidate=604800",
  );
});

test("returns a bounded single byte range as 206", async () => {
  const response = await requestMedia({ range: "bytes=2-5" });

  assert.equal(response.status, 206);
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    Uint8Array.from([2, 3, 4, 5]),
  );
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(assetRequests.at(-1).headers.get("range"), null);
  assert.equal(assetRequests.at(-1).method, "GET");
});

test("supports open-ended, clamped, and suffix byte ranges", async () => {
  for (const [range, expectedRange, expectedBytes] of [
    ["bytes=7-", "bytes 7-9/10", [7, 8, 9]],
    ["bytes=8-99", "bytes 8-9/10", [8, 9]],
    ["bytes=-3", "bytes 7-9/10", [7, 8, 9]],
    ["bytes=-99", "bytes 0-9/10", [...bytes]],
  ]) {
    const response = await requestMedia({ range });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get("content-range"), expectedRange, range);
    assert.deepEqual(
      [...new Uint8Array(await response.arrayBuffer())],
      expectedBytes,
      range,
    );
  }
});

test("HEAD returns range headers without a response body", async () => {
  const response = await requestMedia({ method: "HEAD", range: "bytes=1-3" });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 1-3/10");
  assert.equal(response.headers.get("content-length"), "3");
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(assetRequests.at(-1).method, "GET");
});

test("rejects unsatisfiable, reversed, malformed, and multiple ranges", async () => {
  for (const range of [
    "bytes=10-",
    "bytes=7-3",
    "items=0-1",
    "bytes=0-1,4-5",
    "bytes=-0",
  ]) {
    const response = await requestMedia({ range });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get("content-range"), "bytes */10", range);
    assert.equal(response.headers.get("content-length"), "0", range);
    assert.equal((await response.arrayBuffer()).byteLength, 0, range);
  }
});

test("HEAD without Range preserves the full representation metadata", async () => {
  const response = await requestMedia({ method: "HEAD" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(assetRequests.at(-1).method, "HEAD");
});
