import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("keeps creation-mode quantities parallel", async () => {
  const landing = await source("app/landing-router.tsx");

  assert.match(landing, />動画 1本</);
  assert.match(landing, />動画 2〜5本</);
  assert.match(landing, />写真 2〜10枚</);
  assert.match(landing, /動画を1本選ぶ/);
  assert.match(landing, /動画を2〜5本選ぶ/);
  assert.match(landing, /写真を2〜10枚選ぶ/);
});

test("rejects known counter and price notation drift", async () => {
  const paths = [
    "app/account/account-client.tsx",
    "app/commercial-disclosure/page.tsx",
    "app/landing-router.tsx",
    "app/page.tsx",
    "app/photo-reel/photo-reel-client.tsx",
    "app/pricing/page.tsx",
    "app/terms/page.tsx",
    "app/video-mix/video-mix-client.tsx",
    "lib/seo.ts",
  ];
  const combined = (await Promise.all(paths.map(source))).join("\n");

  assert.doesNotMatch(combined, /最大\d+動画/);
  assert.doesNotMatch(combined, /1動画(?:につき|あたり|分|\d)/);
  assert.doesNotMatch(combined, /最大10枚まで/);
  assert.doesNotMatch(combined, /写真 最大10枚/);
  assert.doesNotMatch(combined, /18\.4 MB/);
  assert.doesNotMatch(combined, /MP4 \/ MOV/);
  assert.doesNotMatch(combined, /(?:^|[^／])\/ ?1か月/u);
  assert.match(combined, /／1か月（税込）/);
  assert.match(combined, /／1本（税込）/);
});
