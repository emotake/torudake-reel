import assert from "node:assert/strict";
import test from "node:test";

import { createVideoCompositionPlan } from "../lib/video-composition.ts";
import {
  buildVideoMixSceneNarrationTimeline,
  createVideoMixNarrationSceneTimeline,
  describeVideoMixNarrationImage,
  ensureVideoMixNarrationSceneAssignments,
  normalizeVideoMixNarrationSceneTimeline,
  videoMixNarrationScenePromptRules,
} from "../lib/video-mix-scene-timeline.ts";

function scenePlan() {
  return createVideoCompositionPlan({
    sources: [
      {
        id: "private-file-name-is-not-used",
        fileSize: 1,
        duration: 6,
        clips: [
          { start: 0, end: 2 },
          { start: 3, end: 5 },
        ],
      },
      {
        id: "second-private-file-name-is-not-used",
        fileSize: 1,
        duration: 4,
        clips: [{ start: 0, end: 4 }],
      },
    ],
    transition: { type: "crossfade", duration: 0.4 },
  });
}

test("builds non-overlapping semantic windows at transition midpoints", () => {
  const scenes = createVideoMixNarrationSceneTimeline(scenePlan());

  assert.deepEqual(
    scenes.map(({ id, startSeconds, endSeconds }) => ({
      id,
      startSeconds,
      endSeconds,
    })),
    [
      { id: "scene-1", startSeconds: 0, endSeconds: 1.8 },
      { id: "scene-2", startSeconds: 1.8, endSeconds: 3.4 },
      { id: "scene-3", startSeconds: 3.4, endSeconds: 7.2 },
    ],
  );
  assert.deepEqual(
    scenes.map(({ imageIndex, cellIndex, cellCount }) => ({
      imageIndex,
      cellIndex,
      cellCount,
    })),
    [
      { imageIndex: 0, cellIndex: 0, cellCount: 2 },
      { imageIndex: 0, cellIndex: 1, cellCount: 2 },
      { imageIndex: 1, cellIndex: 0, cellCount: 1 },
    ],
  );
});

test("accepts a bounded privacy-minimal scene manifest", () => {
  const plan = scenePlan();
  const scenes = createVideoMixNarrationSceneTimeline(plan);
  const result = normalizeVideoMixNarrationSceneTimeline(scenes, {
    frameCount: 2,
    durationSeconds: plan.duration,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.scenes : [], scenes);
  assert.equal(JSON.stringify(scenes).includes("private-file-name"), false);
});

test("rejects forged ordering, cell mappings, and more than five images", () => {
  const plan = scenePlan();
  const scenes = createVideoMixNarrationSceneTimeline(plan);

  assert.equal(
    normalizeVideoMixNarrationSceneTimeline(scenes, {
      frameCount: 6,
      durationSeconds: plan.duration,
    }).ok,
    false,
  );
  assert.equal(
    normalizeVideoMixNarrationSceneTimeline(
      scenes.map((scene, index) =>
        index === 1 ? { ...scene, cellIndex: 0 } : scene,
      ),
      { frameCount: 2, durationSeconds: plan.duration },
    ).ok,
    false,
  );
  assert.equal(
    normalizeVideoMixNarrationSceneTimeline(
      scenes.map((scene, index) =>
        index === 1 ? { ...scene, id: "scene-3" } : scene,
      ),
      { frameCount: 2, durationSeconds: plan.duration },
    ).ok,
    false,
  );
});

test("describes each image immediately with scene timing and a local budget", () => {
  const scenes = createVideoMixNarrationSceneTimeline(scenePlan());
  const firstImage = describeVideoMixNarrationImage(scenes, 0, 4);
  const rules = videoMixNarrationScenePromptRules(scenes);

  assert.match(firstImage, /画像1/);
  assert.match(firstImage, /scene-1: 左セル、完成映像 0\.0〜1\.8秒/);
  assert.match(firstImage, /scene-2: 右セル、完成映像 1\.8〜3\.4秒/);
  assert.doesNotMatch(firstImage, /private-file-name/);
  assert.match(rules, /segmentsの各要素にはsceneIdを必ず付け/);
  assert.match(rules, /まだ映っていない内容を先に話したり/);
});

test("keeps valid scene grounding and repairs missing or backward ids", () => {
  const scenes = createVideoMixNarrationSceneTimeline(scenePlan());
  const valid = {
    title: "test",
    script: "朝です。昼です。夜です。",
    socialCaption: "",
    segments: [
      { text: "朝です。", sceneId: "scene-1" },
      { text: "昼です。", sceneId: "scene-2" },
      { text: "夜です。", sceneId: "scene-3" },
    ],
  };
  assert.equal(ensureVideoMixNarrationSceneAssignments(valid, scenes), valid);

  const repaired = ensureVideoMixNarrationSceneAssignments(
    {
      ...valid,
      segments: [
        { text: "朝です。", sceneId: "scene-3" },
        { text: "昼です。" },
        { text: "夜です。", sceneId: "scene-1" },
      ],
    },
    scenes,
  );
  const sceneIndexes = repaired.segments.map((segment) =>
    scenes.findIndex((scene) => scene.id === segment.sceneId),
  );
  assert.ok(sceneIndexes.every((index) => index >= 0));
  assert.ok(
    sceneIndexes.every(
      (index, position) => position === 0 || index >= sceneIndexes[position - 1],
    ),
  );
});

test("builds a playable caption timeline inside grounded scene windows", () => {
  const scenes = createVideoMixNarrationSceneTimeline(scenePlan());
  const audioDuration = 6.5;
  const captions = buildVideoMixSceneNarrationTimeline(
    [
      { text: "海辺を歩きます。", sceneId: "scene-1" },
      { text: "食事を楽しみます。", sceneId: "scene-2" },
      { text: "最後は夜景です。", sceneId: "scene-3" },
    ],
    scenes,
    7.2,
    audioDuration,
  );

  assert.deepEqual(
    captions.map(({ start, end }) => ({ start, end })),
    [
      { start: 0, end: 1.8 },
      { start: 1.8, end: 3.4 },
      { start: 3.4, end: 6.5 },
    ],
  );
  assert.ok(
    Math.abs(
      captions.reduce((total, caption) => total + caption.end - caption.start, 0) -
        audioDuration,
    ) < 0.001,
  );
});

test("uses continuous timing when invalid scene ids cannot cover every scene", () => {
  const scenes = createVideoMixNarrationSceneTimeline(scenePlan());
  const audioDuration = 6.5;
  const captions = buildVideoMixSceneNarrationTimeline(
    [
      { text: "最初の場面です。" },
      { text: "次の場面です。", sceneId: "scene-3" },
      { text: "最後の場面です。", sceneId: "scene-1" },
    ],
    scenes,
    7.2,
    audioDuration,
  );

  assert.equal(captions.length, 3);
  assert.equal(captions[0].start, 0);
  assert.equal(captions.at(-1).end, audioDuration);
  assert.ok(
    captions.every(
      (caption, index) =>
        index === 0 || caption.start >= captions[index - 1].end - 0.001,
    ),
  );
  assert.ok(
    Math.abs(
      captions.reduce((total, caption) => total + caption.end - caption.start, 0) -
        audioDuration,
    ) < 0.001,
  );
});

test("keeps continuous TTS timing when the model omits an active scene", () => {
  const scenes = createVideoMixNarrationSceneTimeline(scenePlan());
  const audioDuration = 6.5;
  const captions = buildVideoMixSceneNarrationTimeline(
    [
      { text: "最初の場面です。", sceneId: "scene-1" },
      { text: "最後の場面です。", sceneId: "scene-3" },
    ],
    scenes,
    7.2,
    audioDuration,
  );

  assert.equal(captions[0].start, 0);
  assert.equal(captions.at(-1).end, audioDuration);
  assert.ok(
    Math.abs(
      captions.reduce((total, caption) => total + caption.end - caption.start, 0) -
        audioDuration,
    ) < 0.001,
  );
  assert.ok(
    captions.every(
      (caption, index) =>
        index === 0 || caption.start >= captions[index - 1].end - 0.001,
    ),
  );
});
