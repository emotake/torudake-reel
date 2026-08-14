import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_MIX_SCENE_ANALYSIS_MAX_FRAMES,
  VIDEO_MIX_SCENE_ANALYSIS_THUMBNAIL_COUNT,
  analyzeClientVideoMixSourceScenes,
} from "../lib/client-video-mix-scene-analysis.ts";

class FakeEventTarget {
  listeners = new Map();

  addEventListener(name, listener, options) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push({ listener, once: options?.once === true });
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) {
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((entry) => entry.listener !== listener),
    );
  }

  dispatch(name) {
    const listeners = [...(this.listeners.get(name) ?? [])];
    for (const entry of listeners) {
      entry.listener();
      if (entry.once) this.removeEventListener(name, entry.listener);
    }
  }
}

test("analyzes at most twenty-four local frames and returns six thumbnails", async (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const videos = [];
  const canvases = [];
  let frameCallbackId = 0;
  let frameCallbackRequests = 0;
  let seekCount = 0;
  let thumbnailId = 0;
  let abortAtSeek = Number.POSITIVE_INFINITY;
  let activeAbortController = null;

  const fakeWindow = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame(callback) {
      return globalThis.setTimeout(() => callback(performance.now()), 0);
    },
    cancelAnimationFrame(id) {
      globalThis.clearTimeout(id);
    },
  };

  class FakeVideo extends FakeEventTarget {
    duration = 180;
    videoWidth = 640;
    videoHeight = 360;
    readyState = 4;
    muted = false;
    playsInline = false;
    preload = "";
    paused = true;
    removedSource = false;
    #source = "";
    #currentTime = 0;

    get src() {
      return this.#source;
    }

    set src(value) {
      this.#source = value;
    }

    get currentTime() {
      return this.#currentTime;
    }

    set currentTime(value) {
      this.#currentTime = value;
      seekCount += 1;
      if (seekCount === abortAtSeek) activeAbortController?.abort();
      queueMicrotask(() => this.dispatch("seeked"));
    }

    load() {
      if (this.#source) queueMicrotask(() => this.dispatch("loadedmetadata"));
    }

    pause() {
      this.paused = true;
    }

    removeAttribute(name) {
      if (name === "src") {
        this.#source = "";
        this.removedSource = true;
      }
    }

    requestVideoFrameCallback(callback) {
      frameCallbackRequests += 1;
      const id = ++frameCallbackId;
      queueMicrotask(callback);
      return id;
    }

    cancelVideoFrameCallback() {}
  }

  class FakeCanvas {
    width = 0;
    height = 0;
    lastVideo = null;

    getContext() {
      return {
        drawImage: (video) => {
          this.lastVideo = video;
        },
        getImageData: () => {
          const data = new Uint8ClampedArray(this.width * this.height * 4);
          const scene = (this.lastVideo?.currentTime ?? 0) < 90 ? 0 : 1;
          for (let index = 0; index < data.length; index += 4) {
            const pixel = index / 4;
            const detail = pixel % 2 === 0 ? 46 : -46;
            data[index] = 122 + detail + scene * 24;
            data[index + 1] = 126 - detail / 2 + scene * 12;
            data[index + 2] = 132 + detail / 3 - scene * 20;
            data[index + 3] = 255;
          }
          return { data, width: this.width, height: this.height };
        },
      };
    }

    toDataURL() {
      thumbnailId += 1;
      return `data:image/jpeg;base64,frame-${thumbnailId}`;
    }
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(name) {
        if (name === "video") {
          const video = new FakeVideo();
          videos.push(video);
          return video;
        }
        if (name === "canvas") {
          const canvas = new FakeCanvas();
          canvases.push(canvas);
          return canvas;
        }
        throw new Error(`Unexpected element ${name}`);
      },
    },
  });
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  });

  const result = await analyzeClientVideoMixSourceScenes(
    "blob:local-video",
    180,
    new AbortController().signal,
  );

  assert.equal(result.thumbnails.length, VIDEO_MIX_SCENE_ANALYSIS_THUMBNAIL_COUNT);
  assert.ok(result.thumbnails.every((thumbnail) => thumbnail.startsWith("data:image/jpeg")));
  assert.ok(result.recommendation.analyzedFrameCount <= VIDEO_MIX_SCENE_ANALYSIS_MAX_FRAMES);
  assert.ok(seekCount <= VIDEO_MIX_SCENE_ANALYSIS_MAX_FRAMES);
  assert.equal(frameCallbackRequests, 0);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].removedSource, true);
  assert.ok(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));

  activeAbortController = new AbortController();
  abortAtSeek = seekCount + 3;
  await assert.rejects(
    analyzeClientVideoMixSourceScenes(
      "blob:second-local-video",
      180,
      activeAbortController.signal,
    ),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(videos[1].removedSource, true);
  assert.ok(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test("fails immediately with AbortError when analysis is already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    analyzeClientVideoMixSourceScenes("blob:local-video", 30, controller.signal),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
});
