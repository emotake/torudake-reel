import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyzePhotoReelAudioFileBeats,
  detectPhotoReelBeatCandidates,
  repeatPhotoReelBeatCandidates,
  snapPhotoReelPlanToBeats,
} from "../lib/photo-reel-beats.ts";
import {
  PHOTO_REEL_TEMPLATES,
  createPhotoReelPlan,
} from "../lib/photo-reel.ts";

function assets(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `photo-${index}`,
    name: `photo-${index}.jpg`,
    width: 3024,
    height: 4032,
  }));
}

test("detects nearby percussive onsets from local PCM", () => {
  const sampleRate = 1_000;
  const samples = new Float32Array(sampleRate * 4);
  for (const beat of [0.5, 1, 1.5, 2, 2.5, 3]) {
    samples.fill(0.85, beat * sampleRate, beat * sampleRate + 20);
  }
  const beats = detectPhotoReelBeatCandidates([samples], sampleRate, 4);

  assert.ok(beats.length >= 5);
  for (const expected of [0.5, 1, 1.5, 2.5, 3]) {
    assert.ok(
      beats.some((beat) => Math.abs(beat.time - expected) <= 0.03),
      `missing onset near ${expected}s`,
    );
  }
  assert.ok(beats.every((beat) => beat.strength > 0 && beat.strength <= 1));
});

test("does not mistake a steady sound or silence for a beat grid", () => {
  const sampleRate = 1_000;
  const steady = new Float32Array(sampleRate * 2);
  for (let index = 0; index < steady.length; index += 1) {
    steady[index] = Math.sin((index / sampleRate) * Math.PI * 2 * 40) * 0.12;
  }
  assert.deepEqual(detectPhotoReelBeatCandidates([steady], sampleRate), []);
  assert.deepEqual(
    detectPhotoReelBeatCandidates([new Float32Array(sampleRate)], sampleRate),
    [],
  );
});

test("snaps only close transitions while preserving duration and photo order", () => {
  for (const template of PHOTO_REEL_TEMPLATES) {
    const plan = createPhotoReelPlan(assets(6), {
      duration: 15,
      templateId: template.id,
    });
    const beats = plan.slides.slice(1).map((slide, index) => ({
      time: slide.start + (index % 2 === 0 ? 0.12 : -0.1),
      strength: 1,
    }));
    const synced = snapPhotoReelPlanToBeats(plan, beats);

    assert.equal(synced.slides[0].start, 0);
    assert.equal(synced.slides.at(-1).end, 15);
    assert.deepEqual(
      synced.slides.map((slide) => slide.assetId),
      plan.slides.map((slide) => slide.assetId),
    );
    synced.slides.forEach((slide, index) => {
      assert.ok(slide.duration >= 0.72);
      assert.ok(slide.transitionDuration <= slide.duration * 0.28 + 1e-12);
      if (index > 0) {
        assert.equal(slide.start, synced.slides[index - 1].end);
        assert.ok(Math.abs(slide.start - plan.slides[index].start) <= 0.18);
      }
    });
  }
});

test("leaves silent and distant-beat plans byte-for-byte unchanged", () => {
  const plan = createPhotoReelPlan(assets(4), {
    duration: 15,
    templateId: "cinematic",
  });
  assert.equal(snapPhotoReelPlanToBeats(plan, []), plan);
  assert.equal(
    snapPhotoReelPlanToBeats(plan, [{ time: 14.4, strength: 1 }]),
    plan,
  );
});

test("repeats a short BGM beat map without crossing the video boundary", () => {
  assert.deepEqual(
    repeatPhotoReelBeatCandidates(
      [
        { time: 0.5, strength: 0.8 },
        { time: 1.5, strength: 1 },
      ],
      2,
      5,
    ),
    [
      { time: 0.5, strength: 0.8 },
      { time: 1.5, strength: 1 },
      { time: 2.5, strength: 0.8 },
      { time: 3.5, strength: 1 },
      { time: 4.5, strength: 0.8 },
    ],
  );
  assert.deepEqual(repeatPhotoReelBeatCandidates([], 2, 15), []);
});

test("closes the temporary audio decoder after successful and failed analysis", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  let closeCount = 0;
  let shouldFail = false;
  class MockAudioContext {
    async decodeAudioData() {
      if (shouldFail) throw new Error("unsupported codec");
      const samples = new Float32Array(2_000);
      samples.fill(0.9, 500, 520);
      samples.fill(0.9, 1_000, 1_020);
      samples.fill(0.9, 1_500, 1_520);
      return {
        duration: 2,
        numberOfChannels: 1,
        sampleRate: 1_000,
        getChannelData: () => samples,
      };
    }

    async close() {
      closeCount += 1;
    }
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: MockAudioContext,
  });
  try {
    const file = new File([new Uint8Array([1, 2, 3])], "bgm.m4a", {
      type: "audio/mp4",
    });
    const result = await analyzePhotoReelAudioFileBeats(file, 2);
    assert.equal(result?.duration, 2);
    assert.ok((result?.beats.length ?? 0) >= 2);
    assert.equal(closeCount, 1);

    shouldFail = true;
    assert.equal(await analyzePhotoReelAudioFileBeats(file, 2), null);
    assert.equal(closeCount, 2);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "AudioContext", descriptor);
    } else {
      delete globalThis.AudioContext;
    }
  }
});

test("uses one beat-snapped plan for photo preview and export", async () => {
  const beatCandidates = [
    { time: 2.62, strength: 1 },
    { time: 5.08, strength: 1 },
    { time: 7.58, strength: 1 },
    { time: 10.12, strength: 1 },
    { time: 12.58, strength: 1 },
  ];
  const base = createPhotoReelPlan(assets(6), {
    duration: 15,
    templateId: "cinematic",
  });
  const shared = createPhotoReelPlan(assets(6), {
    duration: 15,
    templateId: "cinematic",
    beatCandidates,
  });
  assert.deepEqual(shared, snapPhotoReelPlanToBeats(base, beatCandidates));

  const [clientSource, exportSource] = await Promise.all([
    readFile(
      new URL("../app/photo-reel/photo-reel-client.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/photo-reel-export.ts", import.meta.url), "utf8"),
  ]);
  assert.match(clientSource, /analyzePhotoReelAudioFileBeats\(/);
  assert.match(clientSource, /beatCandidates: repeatedBeatCandidates/);
  assert.match(clientSource, /exportPhotoReel\(photos, settings/);
  assert.match(clientSource, /setAudioBeatAnalysis\(null\)/);
  assert.match(
    clientSource,
    /beatAnalysis \?\? \{ duration: audioDuration, beats: \[\] \}/,
  );
  assert.match(exportSource, /beatCandidatesWereProvided/);
  assert.match(exportSource, /beatCandidatesWereProvided\s*\?\s*basePlan/);
});
