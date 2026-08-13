import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readProjectFile = (path, encoding = "utf8") =>
  readFile(new URL(`../${path}`, import.meta.url), encoding);

const relativeLuminance = (hex) => {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};

const contrastRatio = (foreground, background) => {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
};

const pngDimensions = (buffer) => ({
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
});

test("uses an accessible local font stack and coral surface color", async () => {
  const css = await readProjectFile("app/globals.css");
  assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(css, /--font-sans:\s*system-ui,/);
  assert.match(css, /font-family:\s*var\(--font-sans\)/);

  const accentColors = [
    css.match(/--coral:\s*(#[0-9a-f]{6})/i)?.[1],
    css.match(/--mix-coral:\s*(#[0-9a-f]{6})/i)?.[1],
  ];
  for (const coral of accentColors) {
    assert.ok(coral);
    assert.ok(
      contrastRatio("#ffffff", coral) >= 4.5,
      `white text on ${coral} must meet WCAG AA`,
    );
    assert.ok(
      contrastRatio(coral, "#ffe5dd") >= 4.5,
      `${coral} text on the lightest peach surface must meet WCAG AA`,
    );
  }
});

test("publishes keyboard skip navigation from the shared layout", async () => {
  const [layout, css] = await Promise.all([
    readProjectFile("app/layout.tsx"),
    readProjectFile("app/globals.css"),
  ]);

  assert.match(layout, /className="skipToContent" href="#main-content"/);
  assert.match(layout, /id="main-content" tabIndex=\{-1\}/);
  assert.match(css, /\.skipToContent:focus-visible\s*\{[\s\S]*?transform:\s*translateY\(0\)/);
});

test("uses opaque focus indicators with at least 3:1 contrast on light UI", async () => {
  const css = await readProjectFile("app/globals.css");
  const focusColor = css.match(/--coral-dark:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(focusColor);
  assert.ok(contrastRatio(focusColor, "#ffffff") >= 3);
  assert.match(
    css,
    /\.siteShell,[\s\S]*?\[role="button"\]\):focus-visible\s*\{\s*outline:\s*3px solid var\(--coral-dark\)/,
  );
  assert.match(
    css,
    /\.videoMixShell :is\(button, a, input, select, textarea, summary\):focus-visible\s*\{\s*outline:\s*3px solid #8f251c/,
  );
  assert.doesNotMatch(
    css,
    /:focus-visible\s*\{[^}]*outline:\s*[23]px solid (?:rgba\([^)]*,\s*0\.[0-6]\)|#[0-9a-f]{8})/gi,
  );
});

test("provides installable and Apple PWA icons at their declared sizes", async () => {
  const [manifestSource, layout] = await Promise.all([
    readProjectFile("public/manifest.webmanifest"),
    readProjectFile("app/layout.tsx"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const expected = [
    ["public/icon-192.png", 192],
    ["public/icon-512.png", 512],
    ["public/icon-maskable-512.png", 512],
    ["public/apple-touch-icon.png", 180],
  ];

  for (const [path, size] of expected) {
    const image = await readProjectFile(path, null);
    assert.deepEqual(pngDimensions(image), { width: size, height: size });
  }

  assert.ok(
    manifest.icons.some(
      (icon) =>
        icon.src === "/icon-192.png" &&
        icon.sizes === "192x192" &&
        icon.purpose === "any",
    ),
  );
  assert.ok(
    manifest.icons.some(
      (icon) =>
        icon.src === "/icon-512.png" &&
        icon.sizes === "512x512" &&
        icon.purpose === "any",
    ),
  );
  assert.ok(
    manifest.icons.some(
      (icon) =>
        icon.src === "/icon-maskable-512.png" &&
        icon.sizes === "512x512" &&
        icon.purpose === "maskable",
    ),
  );
  assert.match(layout, /url:\s*"\/icon-192\.png"[^\n]+sizes:\s*"192x192"/);
  assert.match(layout, /url:\s*"\/icon-512\.png"[^\n]+sizes:\s*"512x512"/);
  assert.match(
    layout,
    /url:\s*"\/apple-touch-icon\.png"[\s\S]*?sizes:\s*"180x180"/,
  );
});

test("emits the skip link and target on every primary HTML route", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const routes = [
    "/",
    "/video-mix",
    "/photo-reel",
    "/guide/iphone-mov-reel",
    "/privacy",
    "/terms",
    "/commercial-disclosure",
    "/account",
  ];

  for (const path of routes) {
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, {
        headers: { accept: "text/html" },
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /href="#main-content"[^>]*>本文へ移動<\/a>/, path);
    assert.match(html, /id="main-content" tabindex="-1"/, path);
  }
});
