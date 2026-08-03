import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedUploadPartBytes,
  expectedUploadPartCount,
  isValidMultipartCompletion,
  MAX_VIDEO_BYTES,
  UPLOAD_CHUNK_BYTES,
} from "../lib/multipart-upload.ts";

test("derives the exact multipart plan from the declared video size", () => {
  const total = UPLOAD_CHUNK_BYTES * 2 + 123;
  assert.equal(expectedUploadPartCount(total), 3);
  assert.equal(expectedUploadPartBytes(total, 1), UPLOAD_CHUNK_BYTES);
  assert.equal(expectedUploadPartBytes(total, 2), UPLOAD_CHUNK_BYTES);
  assert.equal(expectedUploadPartBytes(total, 3), 123);
  assert.equal(expectedUploadPartBytes(total, 4), 0);
  assert.equal(expectedUploadPartCount(MAX_VIDEO_BYTES + 1), 0);
});

test("accepts only an exact, consecutive multipart completion list", () => {
  const total = UPLOAD_CHUNK_BYTES + 50;
  const valid = [
    { partNumber: 1, etag: "etag-one" },
    { partNumber: 2, etag: "etag-two" },
  ];
  assert.equal(isValidMultipartCompletion(total, valid), true);
  assert.equal(isValidMultipartCompletion(total, valid.slice(0, 1)), false);
  assert.equal(
    isValidMultipartCompletion(total, [valid[0], { ...valid[1], partNumber: 3 }]),
    false,
  );
  assert.equal(
    isValidMultipartCompletion(total, [valid[0], { ...valid[1], etag: "bad etag" }]),
    false,
  );
  assert.equal(
    isValidMultipartCompletion(total, [...valid, { partNumber: 3, etag: "extra" }]),
    false,
  );
});
