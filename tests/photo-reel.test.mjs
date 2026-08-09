import assert from "node:assert/strict";
import test from "node:test";

import {
  PHOTO_REEL_FRAME_RATE,
  PHOTO_REEL_MAX_MOTION_SCALE,
  PHOTO_REEL_MAX_PHOTOS,
  PHOTO_REEL_MIN_PHOTOS,
  PHOTO_REEL_MOTION_SAFE_AREA_RATIO,
  PHOTO_REEL_OUTPUT_HEIGHT,
  PHOTO_REEL_OUTPUT_WIDTH,
  PHOTO_REEL_TEMPLATES,
  buildPhotoReelFrameSchedule,
  computePhotoReelForegroundRect,
  computePhotoReelImageLayout,
  createPhotoReelPlan,
  getPhotoReelFrameState,
  validatePhotoReelAssets,
} from "../lib/photo-reel.ts";

function getTransformedBounds(rect, layer) {
  const centerX = PHOTO_REEL_OUTPUT_WIDTH / 2;
  const centerY = PHOTO_REEL_OUTPUT_HEIGHT / 2;
  const translateX = layer.translateX * PHOTO_REEL_OUTPUT_WIDTH;
  const translateY = layer.translateY * PHOTO_REEL_OUTPUT_HEIGHT;
  const cosine = Math.cos(layer.rotation);
  const sine = Math.sin(layer.rotation);
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ].map(([x, y]) => {
    const offsetX = (x - centerX) * layer.scale;
    const offsetY = (y - centerY) * layer.scale;
    return {
      x: centerX + translateX + cosine * offsetX - sine * offsetY,
      y: centerY + translateY + sine * offsetX + cosine * offsetY,
    };
  });
  return {
    left: Math.min(...corners.map(({ x }) => x)),
    right: Math.max(...corners.map(({ x }) => x)),
    top: Math.min(...corners.map(({ y }) => y)),
    bottom: Math.max(...corners.map(({ y }) => y)),
  };
}

function makeAssets(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `photo-${index}`,
    name: `photo-${index}.jpg`,
    width: index % 2 === 0 ? 4032 : 3024,
    height: index % 2 === 0 ? 3024 : 4032,
  }));
}

test("offers exactly five distinct premium photo reel templates", () => {
  assert.deepEqual(
    PHOTO_REEL_TEMPLATES.map((template) => template.id),
    ["cinematic", "upbeat", "editorial", "memories", "gallery"],
  );
  assert.equal(new Set(PHOTO_REEL_TEMPLATES.map(({ label }) => label)).size, 5);
  assert.equal(
    new Set(PHOTO_REEL_TEMPLATES.map(({ transition }) => transition)).size,
    4,
  );
  for (const template of PHOTO_REEL_TEMPLATES) {
    assert.ok(template.label.length > 0);
    assert.ok(template.description.length > 20);
  }
});

test("requires 2-10 valid, uniquely identified photos for a reel", () => {
  assert.equal(PHOTO_REEL_MIN_PHOTOS, 2);
  assert.equal(PHOTO_REEL_MAX_PHOTOS, 10);
  assert.doesNotThrow(() => validatePhotoReelAssets(makeAssets(2)));
  assert.doesNotThrow(() => validatePhotoReelAssets(makeAssets(10)));
  assert.throws(() => validatePhotoReelAssets(makeAssets(1)), /2-10/);
  assert.throws(() => validatePhotoReelAssets(makeAssets(11)), /2-10/);
  assert.throws(
    () =>
      validatePhotoReelAssets([
        { id: "same", name: "a.jpg", width: 100, height: 100 },
        { id: "same", name: "b.jpg", width: 100, height: 100 },
      ]),
    /unique/,
  );
});

test("creates gap-free 15 and 30 second plans at fixed vertical Full HD", () => {
  for (const duration of [15, 30]) {
    const plan = createPhotoReelPlan(makeAssets(10), {
      duration,
      templateId: "cinematic",
    });
    assert.equal(plan.width, PHOTO_REEL_OUTPUT_WIDTH);
    assert.equal(plan.height, PHOTO_REEL_OUTPUT_HEIGHT);
    assert.equal(plan.frameRate, PHOTO_REEL_FRAME_RATE);
    assert.equal(plan.slides[0].start, 0);
    assert.equal(plan.slides.at(-1).end, duration);
    assert.equal(
      plan.slides.reduce((sum, slide) => sum + slide.duration, 0),
      duration,
    );
    plan.slides.forEach((slide, index) => {
      assert.ok(slide.duration > 0);
      assert.ok(slide.transitionDuration < slide.duration / 3);
      if (index > 0) assert.equal(slide.start, plan.slides[index - 1].end);
    });
  }
});

test("rejects a duration other than the two product choices", () => {
  assert.throws(
    () =>
      createPhotoReelPlan(makeAssets(3), {
        duration: 20,
        templateId: "cinematic",
      }),
    /15 or 30/,
  );
});

test("keeps all timing and motion deterministic when seeking in either direction", () => {
  const plan = createPhotoReelPlan(makeAssets(6), {
    duration: 15,
    templateId: "gallery",
    title: "  旅の   思い出  ",
  });
  const later = getPhotoReelFrameState(plan, 9.375);
  getPhotoReelFrameState(plan, 1.25);
  const repeated = getPhotoReelFrameState(plan, 9.375);
  assert.deepEqual(repeated, later);
  assert.equal(plan.title, "旅の 思い出");
  for (const layer of later.layers) {
    assert.ok(Number.isFinite(layer.scale));
    assert.ok(Number.isFinite(layer.translateX));
    assert.ok(Number.isFinite(layer.translateY));
    assert.ok(Number.isFinite(layer.rotation));
  }
});

test("transitions remain seek-safe at every slide boundary for all templates", () => {
  for (const template of PHOTO_REEL_TEMPLATES) {
    const plan = createPhotoReelPlan(makeAssets(5), {
      duration: 15,
      templateId: template.id,
    });
    const boundary = plan.slides[1].start;
    const start = getPhotoReelFrameState(plan, boundary);
    const middle = getPhotoReelFrameState(
      plan,
      boundary + plan.slides[1].transitionDuration / 2,
    );
    const complete = getPhotoReelFrameState(
      plan,
      boundary + plan.slides[1].transitionDuration,
    );
    assert.equal(start.slideIndex, 1);
    assert.equal(start.transitionProgress, 0);
    assert.ok(middle.transitionProgress > 0 && middle.transitionProgress < 1);
    assert.equal(complete.transitionProgress, 1);
    assert.equal(complete.layers.at(-1).assetIndex, 1);
  }
});

test("maps exact start and end positions to the first and last photo", () => {
  const plan = createPhotoReelPlan(makeAssets(4), {
    duration: 15,
    templateId: "memories",
  });
  const start = getPhotoReelFrameState(plan, -50);
  const end = getPhotoReelFrameState(plan, 99);
  assert.equal(start.time, 0);
  assert.equal(start.slideIndex, 0);
  assert.equal(end.time, 15);
  assert.equal(end.slideIndex, 3);
  assert.equal(end.slideProgress, 1);
});

test("builds exact 30fps schedules without an extra frame past the duration", () => {
  const shortPlan = createPhotoReelPlan(makeAssets(3), {
    duration: 15,
    templateId: "upbeat",
  });
  const longPlan = createPhotoReelPlan(makeAssets(3), {
    duration: 30,
    templateId: "upbeat",
  });
  const shortSchedule = buildPhotoReelFrameSchedule(shortPlan);
  const longSchedule = buildPhotoReelFrameSchedule(longPlan);
  assert.equal(shortSchedule.length, 450);
  assert.equal(longSchedule.length, 900);
  assert.equal(shortSchedule[0].time, 0);
  assert.ok(shortSchedule.at(-1).time < 15);
  assert.equal(
    shortSchedule.at(-1).time + shortSchedule.at(-1).duration,
    15,
  );
});

test("preserves a landscape photo inside a motion-safe blurred background", () => {
  const layout = computePhotoReelImageLayout(4032, 2268);
  assert.equal(layout.mode, "blur-fit");
  assert.equal(PHOTO_REEL_MOTION_SAFE_AREA_RATIO, 0.86);
  assert.ok(layout.foreground.x > 0);
  assert.ok(layout.foreground.y > 600);
  assert.ok(layout.foreground.width < PHOTO_REEL_OUTPUT_WIDTH);
  assert.equal(
    layout.foreground.width,
    PHOTO_REEL_OUTPUT_WIDTH * PHOTO_REEL_MOTION_SAFE_AREA_RATIO,
  );
  assert.ok(layout.background.x < 0);
  assert.equal(layout.background.y, 0);
  assert.equal(layout.background.height, 1920);
});

test("keeps landscape photo edges visible throughout every template motion", () => {
  const landscapeDimensions = [
    [1001, 1000],
    [4032, 3024],
    [4032, 2268],
    [12000, 1000],
  ];

  for (const [width, height] of landscapeDimensions) {
    const assets = Array.from({ length: 2 }, (_, index) => ({
      id: `landscape-${width}-${height}-${index}`,
      name: `landscape-${index}.jpg`,
      width,
      height,
    }));
    for (const template of PHOTO_REEL_TEMPLATES) {
      const plan = createPhotoReelPlan(assets, {
        duration: 15,
        templateId: template.id,
      });
      const firstSlide = plan.slides[0];
      const foreground = computePhotoReelForegroundRect(
        width,
        height,
        template.id,
      );
      for (let step = 0; step <= 100; step += 1) {
        const time =
          firstSlide.start +
          ((firstSlide.duration - 0.0001) * step) / 100;
        const layer = getPhotoReelFrameState(plan, time).layers[0];
        const label = `${template.id} ${width}x${height}`;
        assert.ok(
          layer.scale <= PHOTO_REEL_MAX_MOTION_SCALE,
          `${label} exceeded the decode headroom`,
        );
        const bounds = getTransformedBounds(foreground, layer);
        assert.ok(bounds.left >= -0.01, `${label} clipped the left edge`);
        assert.ok(
          bounds.right <= PHOTO_REEL_OUTPUT_WIDTH + 0.01,
          `${label} clipped the right edge`,
        );
        assert.ok(bounds.top >= -0.01, `${label} clipped the top edge`);
        assert.ok(
          bounds.bottom <= PHOTO_REEL_OUTPUT_HEIGHT + 0.01,
          `${label} clipped the bottom edge`,
        );
      }
    }
  }
});

test("uses edge-to-edge cover only when a photo already matches 9:16", () => {
  const portrait = computePhotoReelImageLayout(1080, 1920);
  assert.deepEqual(portrait, {
    mode: "cover",
    foreground: { x: 0, y: 0, width: 1080, height: 1920 },
    background: { x: 0, y: 0, width: 1080, height: 1920 },
  });
  const square = computePhotoReelImageLayout(2000, 2000);
  assert.equal(square.mode, "blur-fit");
  assert.ok(Math.abs(square.foreground.x - 75.6) < 0.001);
  assert.ok(Math.abs(square.foreground.y - 495.6) < 0.001);
  assert.ok(Math.abs(square.foreground.width - 928.8) < 0.001);
  assert.ok(Math.abs(square.foreground.height - 928.8) < 0.001);
});
