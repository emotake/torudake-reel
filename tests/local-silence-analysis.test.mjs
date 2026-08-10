import assert from "node:assert/strict";
import test from "node:test";

import { selectQuietestCutWindow } from "../lib/local-silence-analysis.ts";

test("selects the quietest local waveform window near a safe word boundary", () => {
  assert.equal(
    selectQuietestCutWindow(
      [
        { time: 1.002, rms: 0.04 },
        { time: 1.008, rms: 0.002 },
        { time: 1.014, rms: 0.002 },
      ],
      1.014,
    ),
    1.014,
  );
});

test("does not treat uniformly loud speech as a silent cut position", () => {
  assert.equal(
    selectQuietestCutWindow(
      [
        { time: 2.002, rms: 0.12 },
        { time: 2.008, rms: 0.11 },
        { time: 2.014, rms: 0.13 },
      ],
      2,
    ),
    null,
  );
});

test("ignores invalid waveform measurements", () => {
  assert.equal(
    selectQuietestCutWindow(
      [
        { time: Number.NaN, rms: 0 },
        { time: 1, rms: -1 },
      ],
      1,
    ),
    null,
  );
});
