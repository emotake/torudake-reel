import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  selectDurableVideoMixOutputRecoveryCandidates,
  waitForIndexedDbTransaction,
} from "../lib/client-video-mix-output.ts";

const source = await readFile(
  new URL("../lib/client-video-mix-output.ts", import.meta.url),
  "utf8",
);

test("completed video mix output is persisted before the usage completion boundary", () => {
  assert.match(source, /status: "pending-completion"/);
  assert.match(source, /markDurableVideoMixOutputCompleted/);
  assert.match(source, /status: "completed"/);
  assert.match(source, /loadLatestCompletedVideoMixOutput/);
  assert.match(source, /loadLatestDurableVideoMixOutput/);
  assert.match(source, /usage completion needs to be retried/);
});

test("large output bytes prefer OPFS and retain an IndexedDB fallback", () => {
  assert.match(source, /navigator\.storage\.getDirectory/);
  assert.match(source, /createWritable\(\)/);
  assert.match(source, /await writable\.abort\(\)/);
  assert.match(source, /await directory\.removeEntry\(`\$\{id\}\.mp4`\)/);
  assert.match(source, /storage: "opfs"/);
  assert.match(source, /storage: "indexeddb", blob: options\.blob/);
  assert.match(source, /navigator\.storage\.persist\(\)/);
  assert.match(source, /navigator\.storage\?\.estimate/);
  assert.match(source, /Math\.ceil\(blobSize \* 1\.25\)/);
  assert.match(source, /利用枠はまだ確定していません/);
});

test("recovery copies expire and can be explicitly deleted", () => {
  assert.match(source, /7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /cleanupExpiredVideoMixOutputs/);
  assert.match(source, /deleteDurableVideoMixOutput/);
  assert.match(source, /removeEntry\(`\$\{id\}\.mp4`\)/);
});

test("recovery enumerates bounded metadata candidates without loading Blob bytes", () => {
  const now = 2_000_000_000_000;
  const values = Array.from({ length: 12 }, (_, index) => ({
    id: `output-${index}`,
    filename: `${index}.mp4`,
    mimeType: "video/mp4",
    size: 100 + index,
    createdAt: now - index * 1_000,
    reservationId: `reservation-${index}`,
    bucket: "subscription",
    qualityMessage: "ok",
    status: "completed",
    storage: "indexeddb",
    blob: new Blob([String(index)]),
  }));
  const candidates = selectDurableVideoMixOutputRecoveryCandidates(values, now);
  assert.equal(candidates.length, 10);
  assert.deepEqual(candidates.map((candidate) => candidate.id),
    Array.from({ length: 10 }, (_, index) => `output-${index}`));
  assert.ok(candidates.every((candidate) => !("blob" in candidate)));
});

test("does not report a durable output before the IndexedDB transaction commits", async () => {
  const request = { result: "stored", error: null };
  const transaction = { error: null };
  let settled = false;
  const pending = waitForIndexedDbTransaction(transaction, request).then((value) => {
    settled = true;
    return value;
  });

  request.onsuccess();
  await Promise.resolve();
  assert.equal(settled, false);

  transaction.oncomplete();
  assert.equal(await pending, "stored");
});

test("rejects when a transaction aborts after its request succeeded", async () => {
  const request = { result: "not-durable", error: null };
  const abortError = new Error("quota exhausted");
  const transaction = { error: abortError };
  const pending = waitForIndexedDbTransaction(transaction, request);
  request.onsuccess();
  transaction.onabort();
  await assert.rejects(pending, /quota exhausted/);
});
