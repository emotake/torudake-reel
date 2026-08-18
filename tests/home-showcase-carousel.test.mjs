import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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
  assert.match(landingSource, /作れるリール/);
  assert.match(landingSource, /素材に合う作り方を、見比べられます。/);
});

test("renders three named inertable slides with manual controls", () => {
  assert.match(carouselSource, /aria-roledescription="カルーセル"/);
  assert.match(carouselSource, /aria-label="作れるリールの例"/);
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
    "2 / 3：動画2〜5本",
    "3 / 3：写真2〜10枚",
  ]) {
    assert.match(carouselSource, new RegExp(`aria-label="${label}"`));
  }
  assert.equal((carouselSource.match(/\binert=\{/g) ?? []).length, 3);
  assert.equal((carouselSource.match(/aria-hidden=\{/g) ?? []).length, 3);
  assert.match(carouselSource, /aria-label="前の仕上がり例を表示"/);
  assert.match(carouselSource, /aria-label="次の仕上がり例を表示"/);
  assert.match(carouselSource, /disabled=\{activeIndex === 0\}/);
  assert.match(
    carouselSource,
    /disabled=\{activeIndex === HOME_SHOWCASE_SLIDE_COUNT - 1\}/,
  );
  assert.match(
    carouselSource,
    /className=\{styles\.viewport\}[\s\S]*?role="group"[\s\S]*?aria-label="仕上がり例。左右の矢印キーでも切り替えられます。"/,
  );
  assert.match(
    carouselSource,
    /className=\{styles\.indicators\}[\s\S]*?role="group"[\s\S]*?aria-label="仕上がり例を選ぶ"/,
  );
  assert.match(carouselSource, /aria-current=\{/);
  assert.match(carouselSource, /aria-live="polite"/);
  assert.match(carouselSource, /event\.currentTarget !== event\.target/);
  assert.match(carouselSource, /video\.pause\(\)/);
});

test("uses the approved lightweight media without adding eager video playback", async () => {
  const assets = [
    "torudake-demo-scene-rain.jpg",
    "torudake-demo-scene-sea.jpg",
    "torudake-demo-scene-river.jpg",
    "torudake-photo-flowers-v1.jpg",
    "torudake-photo-brunch-v1.jpg",
    "torudake-photo-dog-v1.jpg",
  ];
  for (const asset of assets) {
    assert.match(carouselSource, new RegExp(asset.replace(".", "\\.")));
    const metadata = await stat(new URL(`../public/demo/${asset}`, import.meta.url));
    assert.ok(metadata.size < 100_000, `${asset} must stay below 100 KB`);
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
