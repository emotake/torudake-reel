import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [landingSource, motionSource, motionCss, visualCss] = await Promise.all([
  readFile(new URL("../app/landing-router.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-premium-motion.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-premium-motion.module.css", import.meta.url), "utf8"),
  readFile(new URL("../app/home-rich-visuals.module.css", import.meta.url), "utf8"),
]);

const homeSource = `${landingSource}\n${motionSource}`;

function balancedCalls(source, marker) {
  const calls = [];
  let markerIndex = source.indexOf(marker);

  while (markerIndex >= 0) {
    const openIndex = markerIndex + marker.length - 1;
    let depth = 0;
    let quote = null;
    let escaped = false;

    for (let index = openIndex; index < source.length; index += 1) {
      const character = source[index];

      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }

      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        continue;
      }
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push(source.slice(markerIndex, index + 1));
          markerIndex = source.indexOf(marker, index + 1);
          break;
        }
      }

      if (index === source.length - 1) {
        throw new Error(`Unclosed call beginning with ${marker}`);
      }
    }
  }

  return calls;
}

test("integrates a client-side motion layer without changing the home information order", () => {
  assert.match(motionSource, /^\s*["']use client["'];/);
  assert.match(
    motionSource,
    /export\s+(?:function|const)\s+HomeMotionExperience\b/,
  );
  assert.match(
    motionSource,
    /export\s+(?:function|const)\s+HomeTransformationCompare\b/,
  );

  for (const attribute of [
    "data-home-motion-root",
    "data-home-motion",
    "data-home-reveal",
    "data-home-revealed",
    "data-home-depth",
    "data-home-compare",
    "data-home-compare-before",
    "data-home-compare-after",
    "data-home-compare-range",
  ]) {
    assert.match(homeSource, new RegExp(attribute));
  }

  assert.match(landingSource, /HomeMotionExperience/);
  assert.match(landingSource, /HomeTransformationCompare/);
  assert.ok(
    landingSource.indexOf("<HomeMotionExperience") <
      landingSource.indexOf("<CreationChooser"),
  );
  assert.ok(
    landingSource.indexOf("<HomeTransformationCompare") <
      landingSource.indexOf("{props.demo}"),
  );
});

test("reveals content once and only enhances fine-pointer devices", () => {
  assert.match(
    motionSource,
    /matchMedia\(["']\(prefers-reduced-motion:\s*reduce\)["']\)/,
  );
  assert.match(
    motionSource,
    /matchMedia\(["'][^"']*hover:\s*hover[^"']*["']\)/,
  );
  assert.match(
    motionSource,
    /matchMedia\(["'][^"']*pointer:\s*fine[^"']*["']\)/,
  );
  assert.match(motionSource, /new\s+IntersectionObserver\s*\(/);
  assert.match(motionSource, /threshold\s*:/);
  assert.match(motionSource, /\.unobserve\s*\(/);
  assert.match(motionSource, /\.disconnect\s*\(/);
  assert.match(motionSource, /\.animate\s*\(/);
  assert.match(motionSource, /requestAnimationFrame\s*\(/);
  assert.match(motionSource, /cancelAnimationFrame\s*\(/);
  assert.match(motionSource, /document\.visibilityState/);
  assert.match(motionSource, /new\s+Set<Animation>\(\)/);
  assert.match(motionSource, /trackMotionAnimation\s*\(/);
  assert.match(motionSource, /animation\.addEventListener\(["']finish["']/);
  assert.match(motionSource, /animation\.addEventListener\(["']cancel["']/);
  assert.match(
    motionSource,
    /typeof\s+root\.getAnimations\s*===\s*["']function["']/,
  );
  assert.match(motionSource, /getAnimations\(\{\s*subtree:\s*true\s*\}\)/);
  assert.ok(
    (motionSource.match(/cancelMotionAnimations\(root, activeAnimations\)/g) ?? [])
      .length >= 4,
    "Reduced motion, visibility, pagehide, and cleanup must cancel tracked animations",
  );
  assert.match(motionSource, /let\s+disposed\s*=\s*false/);
  assert.match(motionSource, /if\s*\(disposed\)\s*return/);
  assert.match(motionSource, /generation\s*!==\s*observerGeneration/);
  assert.match(motionSource, /observer\s*!==\s*currentObserver/);
  assert.match(motionSource, /disposed\s*=\s*true/);
  assert.match(motionSource, /reducedQuery\.matches \|\| paused/);
  assert.match(
    motionSource,
    /if \(heroVisual && !heroPlayed\) currentObserver\.observe\(heroVisual\)/,
  );

  for (const eventName of [
    "pointermove",
    "visibilitychange",
    "pagehide",
    "pageshow",
  ]) {
    assert.match(
      motionSource,
      new RegExp(`addEventListener\\(["']${eventName}["']`),
    );
    assert.match(
      motionSource,
      new RegExp(`removeEventListener\\(["']${eventName}["']`),
    );
  }

  assert.match(
    motionSource,
    /(?:setAttribute\(["']data-home-revealed["']\s*,\s*["']true["']|dataset\.homeRevealed\s*=\s*["']true["'])/,
  );
  assert.match(motionSource, /["']reduced["']/);
  assert.match(motionSource, /["']enhanced["']/);
  assert.doesNotMatch(motionSource, /addEventListener\(["']scroll["']/);
  assert.doesNotMatch(motionSource, /setInterval\s*\(/);
  assert.match(motionSource, /dataset\.homeRevealOrder/);
  for (const order of ["0", "1", "2"]) {
    assert.match(landingSource, new RegExp(`data-home-reveal-order="${order}"`));
  }
});

test("offers an accessible, controllable before-and-after comparison", () => {
  assert.match(motionSource, /type=["']range["']/);
  assert.match(motionSource, /min=(?:\{0\}|["']0["'])/);
  assert.match(motionSource, /max=(?:\{100\}|["']100["'])/);
  assert.match(motionSource, /value=\{/);
  assert.match(motionSource, /onChange=\{/);
  assert.match(motionSource, /aria-valuetext=\{/);

  assert.match(motionSource, /編集前に選んだ3つの場面/);
  assert.match(motionSource, /10秒の完成動画へ/);
  assert.match(motionSource, /編集前/);
  assert.match(motionSource, /編集後/);

  for (const asset of [
    "torudake-demo-scene-rain.jpg",
    "torudake-demo-scene-sea.jpg",
    "torudake-demo-scene-river.jpg",
    "torudake-demo-poster.jpg",
  ]) {
    assert.match(motionSource, new RegExp(asset.replace(".", "\\.")));
  }

  assert.doesNotMatch(motionSource, /\bautoPlay\b|\bautoplay\b/i);
  assert.match(motionCss, /translate3d\(var\(--home-compare-offset\),\s*0,\s*0\)/);
  assert.match(
    motionCss,
    /translate3d\(var\(--home-compare-inner-offset\),\s*0,\s*0\)/,
  );
  assert.doesNotMatch(motionCss, /calc\([^)]*\*/);
});

test("keeps premium motion finite, composited, and safe when motion is reduced", () => {
  assert.match(motionCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(motionCss, /:focus-visible/);
  assert.match(motionCss, /(?:min-)?height:\s*(?:44px|2\.75rem)\b/);

  assert.doesNotMatch(
    motionCss,
    /\[data-home-reveal\][^{]*\{[^}]*(?:opacity:\s*0\b|visibility:\s*hidden\b|display:\s*none\b)/s,
  );
  assert.doesNotMatch(
    `${motionCss}\n${visualCss}`,
    /animation(?:-iteration-count)?\s*:[^;]*\binfinite\b/i,
  );
  const reducedCss = motionCss.slice(
    motionCss.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(reducedCss, /\[data-home-depth\][^}]*transform:\s*none !important/s);
  assert.match(
    reducedCss,
    /\.before,\s*\.after,\s*\.afterInner\s*\{[^}]*transition:\s*none !important/s,
  );
  assert.doesNotMatch(
    reducedCss,
    /\.before,\s*\.after,\s*\.afterInner\s*\{[^}]*transform:\s*none/s,
  );

  const transitions = motionCss.match(/transition(?:-property)?\s*:[^;]+;/gi) ?? [];
  for (const transition of transitions) {
    assert.doesNotMatch(
      transition,
      /\b(?:width|height|filter|box-shadow)\b/i,
      `Non-composited transition found: ${transition}`,
    );
  }

  const animations = balancedCalls(motionSource, ".animate(");
  assert.ok(animations.length > 0, "Expected at least one WAAPI reveal animation");
  for (const animation of animations) {
    assert.doesNotMatch(
      animation,
      /\b(?:width|height|filter|boxShadow|box-shadow)\s*:/,
      "WAAPI keyframes must animate only composited visual properties",
    );
  }
});
