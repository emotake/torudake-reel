import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HOME_SHOWCASE_SLIDE_COUNT,
  clampHomeShowcaseIndex,
  homeShowcaseIndexForKey,
  nearestHomeShowcaseIndex,
} from "../lib/home-showcase-carousel.ts";

const [landingSource, carouselSource, carouselCss, pageSource] = await Promise.all([
  readFile(new URL("../app/landing-router.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-showcase-carousel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-showcase-carousel.module.css", import.meta.url), "utf8"),
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
]);

const APPROVED_CAROUSEL_ASSETS = [
  {
    name: "torudake-demo-scene-rain.jpg",
    width: 360,
    height: 640,
    bytes: 40_214,
    sha256: "b3c2f7cd7e9e5b02482a8f64601148ae2645892362ae699ffaf6b55bdf091217",
  },
  {
    name: "torudake-demo-scene-sea.jpg",
    width: 360,
    height: 640,
    bytes: 52_960,
    sha256: "609af0437340532b8a95aee17e0025dadbbd316cb4bfc00713183936ac705f0c",
  },
  {
    name: "torudake-demo-scene-river.jpg",
    width: 360,
    height: 640,
    bytes: 28_190,
    sha256: "905f95d500f2c158db1fed050eae2c5562426508b2aad2c0165a66687c62e338",
  },
  {
    name: "torudake-photo-flowers-v1.jpg",
    width: 600,
    height: 400,
    bytes: 33_795,
    sha256: "f79ed3f3a0c3bbc2a87c2a87df7a744aa3999d6a3274de0e6db0ec3ae55e0697",
  },
  {
    name: "torudake-photo-brunch-v1.jpg",
    width: 600,
    height: 400,
    bytes: 31_847,
    sha256: "e8842a7b095cef513c6aeb4638477cd876809e1dd1f9279ea245b8879554ff8b",
  },
  {
    name: "torudake-photo-dog-v1.jpg",
    width: 600,
    height: 400,
    bytes: 34_483,
    sha256: "91553147d4f075497787ce93fea504efcd4ab665b42fc3c23091575756975008",
  },
];

function jpegDimensions(bytes) {
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += segmentLength + 2;
  }
  throw new Error("JPEG size marker not found");
}

test("clamps finite carousel navigation and maps scoped keyboard keys", () => {
  assert.equal(HOME_SHOWCASE_SLIDE_COUNT, 3);
  assert.equal(clampHomeShowcaseIndex(-1), 0);
  assert.equal(clampHomeShowcaseIndex(3), 2);
  assert.equal(homeShowcaseIndexForKey("ArrowRight", 2), 2);
  assert.equal(homeShowcaseIndexForKey("ArrowLeft", 0), 0);
  assert.equal(homeShowcaseIndexForKey("Home", 2), 0);
  assert.equal(homeShowcaseIndexForKey("End", 0), 2);
  assert.equal(homeShowcaseIndexForKey("Enter", 1), null);
});

test("selects the nearest slide after native scrolling", () => {
  const offsets = [0, 548, 1096];
  assert.equal(nearestHomeShowcaseIndex(0, offsets), 0);
  assert.equal(nearestHomeShowcaseIndex(500, offsets), 1);
  assert.equal(nearestHomeShowcaseIndex(1080, offsets), 2);
  assert.equal(nearestHomeShowcaseIndex(Number.NaN, offsets), 0);
  assert.equal(nearestHomeShowcaseIndex(50, []), 0);
});

test("places the manual showcase inside the TOP result and before creation choices", () => {
  const homeStart = landingSource.indexOf("export function HomeLanding");
  const homeEnd = landingSource.indexOf("export function VideoEditLanding");
  const home = landingSource.slice(homeStart, homeEnd);
  const resultIndex = home.indexOf('className="landingHeroResult"');
  const carouselIndex = home.indexOf("<HomeShowcaseCarousel", resultIndex);
  const demoIndex = home.indexOf("demo={props.demo}", carouselIndex);
  const chooserIndex = home.indexOf("<CreationChooser", carouselIndex);

  assert.ok(resultIndex >= 0);
  assert.ok(resultIndex < carouselIndex && carouselIndex <= demoIndex);
  assert.ok(demoIndex < chooserIndex);
  assert.match(landingSource, /import \{ HomeShowcaseCarousel \}/);
  assert.match(landingSource, /作り方の例/);
  assert.match(landingSource, /手元の素材に合う作り方を、3つから。/);
  assert.match(
    landingSource,
    /実際の完成動画と、複数動画・写真から作る場合のイメージを切り替えて見られます。/,
  );
});

test("renders three named inertable slides with manual controls", () => {
  assert.match(carouselSource, /aria-roledescription="カルーセル"/);
  assert.match(carouselSource, /aria-label="作り方の例"/);
  assert.equal(
    (carouselSource.match(/<article[\s\S]*?role="group"/g) ?? []).length,
    3,
  );
  assert.equal(
    (carouselSource.match(/aria-roledescription="スライド"/g) ?? []).length,
    3,
  );
  for (const label of [
    "1 / 3：実際の完成動画",
    "2 / 3：動画2〜5本・構成イメージ",
    "3 / 3：写真2〜10枚・構成イメージ",
  ]) {
    assert.match(carouselSource, new RegExp(`aria-label="${label}"`));
  }
  assert.equal((carouselSource.match(/\binert=\{/g) ?? []).length, 3);
  assert.equal((carouselSource.match(/aria-hidden=\{/g) ?? []).length, 3);
  assert.match(carouselSource, /aria-label="前の作り方を表示"/);
  assert.match(carouselSource, /aria-label="次の作り方を表示"/);
  assert.match(carouselSource, /disabled=\{activeIndex === 0\}/);
  assert.match(
    carouselSource,
    /disabled=\{activeIndex === HOME_SHOWCASE_SLIDE_COUNT - 1\}/,
  );
  assert.match(
    carouselSource,
    /className=\{styles\.viewport\}[\s\S]*?role="group"[\s\S]*?aria-label="作り方の例。左右の矢印キーでも切り替えられます。"/,
  );
  assert.match(
    carouselSource,
    /className=\{styles\.indicators\}[\s\S]*?role="group"[\s\S]*?aria-label="作り方を選ぶ"/,
  );
  assert.match(carouselSource, /aria-current=\{/);
  assert.match(carouselSource, /aria-live="polite"/);
  assert.match(carouselSource, /event\.currentTarget !== event\.target/);
  assert.match(carouselSource, /video\.pause\(\)/);
});

test("keeps promotional carousel copy factual and labels illustrative slides", () => {
  assert.match(carouselSource, /02 \/ 動画2〜5本・構成イメージ/);
  assert.match(carouselSource, /03 \/ 写真2〜10枚・構成イメージ/);
  assert.match(carouselSource, /音声・テロップ付き、約10秒の完成動画です。/);
  assert.match(
    carouselSource,
    /各動画から使う場面を1〜2か所選び、つなぎ方も調整できます。/,
  );
  assert.match(
    carouselSource,
    /5つの仕上がりから選べます。写真ごとの表示時間を自動で整えます。/,
  );
  assert.doesNotMatch(
    carouselSource,
    /撮った順番|選ぶだけ|ひと続きの物語|完全自動|ワンタップ|プロ級|必ず/,
  );
  assert.doesNotMatch(carouselSource, /design\.canva\.ai|media\.canva\.com|torudake-canva/);
});

test("uses only the approved lightweight media without Canva runtime assets", async () => {
  const carouselRuntimeSource = `${carouselSource}\n${carouselCss}`;
  const referencedAssets = Array.from(
    new Set(
      Array.from(
        carouselRuntimeSource.matchAll(/\/demo\/([A-Za-z0-9._-]+)/g),
        (match) => match[1],
      ),
    ),
  ).sort();
  assert.deepEqual(
    referencedAssets,
    APPROVED_CAROUSEL_ASSETS.map((asset) => asset.name).sort(),
  );
  assert.doesNotMatch(
    carouselRuntimeSource,
    /(?:https?:\/\/|data:|canva|596\s*[x×]\s*335)/i,
  );
  assert.doesNotMatch(carouselCss, /(?:url|image-set)\s*\(/i);

  for (const asset of APPROVED_CAROUSEL_ASSETS) {
    const bytes = await readFile(
      new URL(`../public/demo/${asset.name}`, import.meta.url),
    );
    assert.equal(bytes.length, asset.bytes, `${asset.name} byte size changed`);
    assert.deepEqual(jpegDimensions(bytes), {
      width: asset.width,
      height: asset.height,
    });
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
      `${asset.name} content changed`,
    );
  }
  assert.equal((carouselSource.match(/<img\b/g) ?? []).length, 4);
  assert.equal((carouselSource.match(/loading="lazy"/g) ?? []).length, 4);
  assert.equal((carouselSource.match(/decoding="async"/g) ?? []).length, 4);
  assert.doesNotMatch(carouselSource, /\bautoPlay\b|\bautoplay\b|\bloop\b/);
  assert.doesNotMatch(carouselSource, /setInterval|setTimeout/);
  assert.match(
    pageSource,
    /<video[\s\S]*?preload="none"[\s\S]*?<source src="\/demo\/torudake-demo\.mp4"/,
  );
});

test("provides peek, snap, touch, focus and reduced-motion styling", () => {
  assert.match(
    carouselCss,
    /\.viewport\s*\{[\s\S]*?grid-auto-columns:\s*calc\(100% - 52px\)[\s\S]*?overflow-x:\s*auto[\s\S]*?scroll-snap-type:\s*x mandatory/,
  );
  assert.match(carouselCss, /touch-action:\s*pan-x pan-y pinch-zoom/);
  assert.match(
    carouselCss,
    /\.slide\s*\{[\s\S]*?min-height:\s*558px[\s\S]*?scroll-snap-align:\s*start[\s\S]*?scroll-snap-stop:\s*always/,
  );
  assert.match(
    carouselCss,
    /\.arrowButtons button\s*\{[\s\S]*?width:\s*44px[\s\S]*?height:\s*44px/,
  );
  assert.match(
    carouselCss,
    /\.indicators button\s*\{[\s\S]*?min-width:\s*44px[\s\S]*?min-height:\s*44px/,
  );
  assert.match(carouselCss, /:focus-visible/);
  assert.match(carouselCss, /@media \(max-width:\s*760px\)/);
  assert.match(carouselCss, /grid-auto-columns:\s*calc\(100% - 24px\)/);
  assert.match(carouselCss, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(carouselCss, /@keyframes\b|\banimation(?:-[a-z-]+)?\s*:/i);
});
