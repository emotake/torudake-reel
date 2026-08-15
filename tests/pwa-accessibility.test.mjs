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

test("uses the site brand mark for browser and installed-app icons", async () => {
  const [favicon, faviconAlias, faviconPng, faviconIco, layout, manifestSource] =
    await Promise.all([
      readProjectFile("public/favicon-v2.svg"),
      readProjectFile("public/favicon.svg"),
      readProjectFile("public/favicon-v2-32.png", null),
      readProjectFile("public/favicon.ico", null),
      readProjectFile("app/layout.tsx"),
      readProjectFile("public/manifest.webmanifest"),
    ]);

  for (const color of ["#162033", "#bd3825", "#b9f5d0", "#fff"]) {
    assert.match(favicon, new RegExp(color, "i"));
  }
  assert.equal(faviconAlias, favicon);
  assert.doesNotMatch(favicon, /#2e9eff|#0c79d8|#68c4ff/i);
  assert.deepEqual(pngDimensions(faviconPng), { width: 32, height: 32 });
  assert.equal(faviconIco.readUInt16LE(0), 0);
  assert.equal(faviconIco.readUInt16LE(2), 1);
  assert.equal(faviconIco.readUInt16LE(4), 1);
  assert.equal(faviconIco.readUInt8(6), 32);
  assert.equal(faviconIco.readUInt8(7), 32);
  assert.equal(faviconIco.readUInt32LE(18), 22);
  assert.equal(faviconIco.subarray(22, 30).toString("hex"), "89504e470d0a1a0a");
  assert.doesNotMatch(layout, /url:\s*"\/favicon\.svg"/);
  assert.doesNotMatch(manifestSource, /"\/favicon\.svg"/);

  const compatibilityAliases = [
    ["public/icon-192.png", "public/icon-192-v2.png"],
    ["public/icon-512.png", "public/icon-512-v2.png"],
    ["public/icon-maskable-512.png", "public/icon-maskable-512-v2.png"],
    ["public/apple-touch-icon.png", "public/apple-touch-icon-v2.png"],
  ];
  for (const [legacyPath, currentPath] of compatibilityAliases) {
    const [legacy, current] = await Promise.all([
      readProjectFile(legacyPath, null),
      readProjectFile(currentPath, null),
    ]);
    assert.deepEqual(legacy, current);
  }
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
    ["public/favicon-v2-32.png", 32],
    ["public/icon-192-v2.png", 192],
    ["public/icon-512-v2.png", 512],
    ["public/icon-maskable-512-v2.png", 512],
    ["public/apple-touch-icon-v2.png", 180],
  ];

  for (const [path, size] of expected) {
    const image = await readProjectFile(path, null);
    assert.deepEqual(pngDimensions(image), { width: size, height: size });
  }

  assert.ok(
    manifest.icons.some(
      (icon) =>
        icon.src === "/icon-192-v2.png" &&
        icon.sizes === "192x192" &&
        icon.purpose === "any",
    ),
  );
  assert.ok(
    manifest.icons.some(
      (icon) =>
        icon.src === "/icon-512-v2.png" &&
        icon.sizes === "512x512" &&
        icon.purpose === "any",
    ),
  );
  assert.ok(
    manifest.icons.some(
      (icon) =>
        icon.src === "/icon-maskable-512-v2.png" &&
        icon.sizes === "512x512" &&
        icon.purpose === "maskable",
    ),
  );
  assert.match(layout, /url:\s*"\/favicon-v2\.svg"[^\n]+type:\s*"image\/svg\+xml"/);
  assert.match(layout, /url:\s*"\/favicon-v2-32\.png"[^\n]+sizes:\s*"32x32"/);
  assert.match(layout, /url:\s*"\/icon-192-v2\.png"[^\n]+sizes:\s*"192x192"/);
  assert.match(layout, /url:\s*"\/icon-512-v2\.png"[^\n]+sizes:\s*"512x512"/);
  assert.match(layout, /shortcut:\s*"\/favicon\.ico"/);
  assert.match(
    layout,
    /url:\s*"\/apple-touch-icon-v2\.png"[\s\S]*?sizes:\s*"180x180"/,
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
