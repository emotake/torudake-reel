import assert from "node:assert/strict";
import test from "node:test";

import {
  PHOTO_REEL_THUMBNAIL_MAX_EDGE,
  computePhotoReelThumbnailDimensions,
  disposePhotoAssets,
  preparePhotoAssets,
} from "../lib/photo-reel-assets.ts";

function replaceGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  };
}

test("bounds thumbnail dimensions without changing the photo aspect ratio", () => {
  assert.equal(PHOTO_REEL_THUMBNAIL_MAX_EDGE, 192);
  assert.deepEqual(computePhotoReelThumbnailDimensions(4032, 2268), {
    width: 192,
    height: 108,
  });
  assert.deepEqual(computePhotoReelThumbnailDimensions(120, 80), {
    width: 120,
    height: 80,
  });
  assert.throws(
    () => computePhotoReelThumbnailDimensions(0, 100),
    /must be positive/,
  );
});

test("returns a lightweight thumbnail URL and revokes the original decode URL", async (t) => {
  const revokedUrls = [];
  const createdValues = [];
  const thumbnailSnapshots = [];
  let bitmapCloseCount = 0;

  const restoreDocument = replaceGlobal("document", {
    createElement(name) {
      assert.equal(name, "canvas");
      const canvas = {
        width: 1,
        height: 1,
        getContext() {
          return {
            canvas,
            imageSmoothingEnabled: false,
            imageSmoothingQuality: "low",
            fillStyle: "",
            filter: "none",
            save() {},
            restore() {},
            fillRect() {},
            drawImage() {},
          };
        },
        toBlob(callback, type, quality) {
          thumbnailSnapshots.push({
            width: canvas.width,
            height: canvas.height,
            type,
            quality,
          });
          callback(new Blob(["thumbnail"], { type }));
        },
      };
      return canvas;
    },
  });
  const restoreCreateImageBitmap = replaceGlobal(
    "createImageBitmap",
    async () => ({
      width: 4032,
      height: 2268,
      close() {
        bitmapCloseCount += 1;
      },
    }),
  );
  t.after(restoreDocument);
  t.after(restoreCreateImageBitmap);
  t.mock.method(URL, "createObjectURL", (value) => {
    createdValues.push(value);
    return createdValues.length === 1 ? "blob:original" : "blob:thumbnail";
  });
  t.mock.method(URL, "revokeObjectURL", (url) => revokedUrls.push(url));

  const file = new File(["photo"], "landscape.jpg", { type: "image/jpeg" });
  const [asset] = await preparePhotoAssets([file]);

  assert.equal(asset.previewUrl, "blob:thumbnail");
  assert.equal(asset.source.width, 1022);
  assert.equal(asset.source.height, 575);
  assert.equal(asset.blurredBackground.width, 270);
  assert.equal(asset.blurredBackground.height, 480);
  assert.deepEqual(thumbnailSnapshots, [
    { width: 192, height: 108, type: "image/jpeg", quality: 0.82 },
  ]);
  assert.equal(createdValues[0], file);
  assert.ok(createdValues[1] instanceof Blob);
  assert.deepEqual(revokedUrls, ["blob:original"]);
  assert.equal(bitmapCloseCount, 1);

  disposePhotoAssets([asset]);
  assert.deepEqual(revokedUrls, ["blob:original", "blob:thumbnail"]);
  assert.equal(asset.source.width, 1);
  assert.equal(asset.source.height, 1);
});

test("keeps overscan pixels when a cover photo will zoom during motion", async (t) => {
  const restoreDocument = replaceGlobal("document", {
    createElement() {
      const canvas = {
        width: 1,
        height: 1,
        getContext() {
          return {
            canvas,
            imageSmoothingEnabled: false,
            imageSmoothingQuality: "low",
            fillStyle: "",
            filter: "none",
            save() {},
            restore() {},
            fillRect() {},
            drawImage() {},
          };
        },
        toBlob(callback, type) {
          callback(new Blob(["thumbnail"], { type }));
        },
      };
      return canvas;
    },
  });
  const restoreCreateImageBitmap = replaceGlobal(
    "createImageBitmap",
    async () => ({ width: 2160, height: 3840, close() {} }),
  );
  t.after(restoreDocument);
  t.after(restoreCreateImageBitmap);
  t.mock.method(URL, "createObjectURL", () => "blob:test");
  t.mock.method(URL, "revokeObjectURL", () => undefined);

  const [asset] = await preparePhotoAssets([
    new File(["photo"], "portrait.jpg", { type: "image/jpeg" }),
  ]);
  assert.equal(asset.source.width, 1188);
  assert.equal(asset.source.height, 2112);
  disposePhotoAssets([asset]);
});
