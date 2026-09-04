import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const campaignRoot = new URL("../public/campaign/recognition-202609/", import.meta.url);

test("ships all six recognition campaign videos and three posters", async () => {
  const videoNames = [
    "daily-a.mp4",
    "daily-b.mp4",
    "talking-a.mp4",
    "talking-b.mp4",
    "shop-a.mp4",
    "shop-b.mp4",
  ];
  const posterNames = [
    "daily-poster.jpg",
    "talking-poster.jpg",
    "shop-poster.jpg",
  ];

  const videoStats = await Promise.all(
    videoNames.map((name) => stat(new URL(name, campaignRoot))),
  );
  const posterStats = await Promise.all(
    posterNames.map((name) => stat(new URL(name, campaignRoot))),
  );

  assert.ok(videoStats.every((value) => value.size > 1_000_000));
  assert.ok(posterStats.every((value) => value.size > 10_000));
});

test("keeps the campaign render manifest out of the publishable directory", async () => {
  await assert.rejects(readFile(new URL("manifest.json", campaignRoot), "utf8"));
});
