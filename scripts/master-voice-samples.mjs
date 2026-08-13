import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TARGET_LUFS = -18.5;
const TARGET_TRUE_PEAK_DBTP = -2.5;
const TARGET_LRA = 9;
const POST_ROLL_SECONDS = 0.35;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const inputDirectory = argument("--input");
const outputDirectory = argument("--output");
const ffmpeg = process.env.FFMPEG_PATH;
if (!inputDirectory || !outputDirectory || !ffmpeg) {
  throw new Error(
    "Usage: FFMPEG_PATH=<ffmpeg> node scripts/master-voice-samples.mjs --input <selected-raw-dir> --output <public-voice-dir>",
  );
}

const selections = {
  calm: "calm-selected.wav",
  bright: "bright-selected.wav",
  comedy: "comedy-selected.wav",
  party: "party-selected.wav",
};

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffmpeg exited with ${result.status}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function parseLoudnessReport(output) {
  const blocks = [...output.matchAll(/\{[\s\S]*?"target_offset"[\s\S]*?\}/g)];
  const block = blocks.at(-1)?.[0];
  if (!block) throw new Error("ffmpeg did not return a loudness report");
  return JSON.parse(block);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

await mkdir(outputDirectory, { recursive: true });
const outputs = [];
for (const [id, sourceName] of Object.entries(selections)) {
  const input = path.resolve(inputDirectory, sourceName);
  const output = path.resolve(outputDirectory, `${id}-v4.wav`);
  const firstPass = parseLoudnessReport(
    runFfmpeg([
      "-hide_banner",
      "-nostats",
      "-i",
      input,
      "-af",
      `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK_DBTP}:LRA=${TARGET_LRA}:print_format=json`,
      "-f",
      "null",
      "NUL",
    ]),
  );
  const filter = [
    `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK_DBTP}:LRA=${TARGET_LRA}`,
    `measured_I=${firstPass.input_i}`,
    `measured_LRA=${firstPass.input_lra}`,
    `measured_TP=${firstPass.input_tp}`,
    `measured_thresh=${firstPass.input_thresh}`,
    `offset=${firstPass.target_offset}`,
    "linear=true",
    "print_format=json",
  ].join(":");
  const secondPass = parseLoudnessReport(
    runFfmpeg([
      "-y",
      "-hide_banner",
      "-nostats",
      "-i",
      input,
      "-af",
      `${filter},apad=pad_dur=${POST_ROLL_SECONDS}`,
      "-ar",
      "24000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      output,
    ]),
  );
  const [raw, mastered] = await Promise.all([readFile(input), readFile(output)]);
  outputs.push({
    id,
    sourceName,
    rawBytes: raw.byteLength,
    rawSha256: sha256(raw),
    file: path.basename(output),
    bytes: mastered.byteLength,
    sha256: sha256(mastered),
    measuredIntegratedLufs: Number(secondPass.output_i),
    measuredTruePeakDbtp: Number(secondPass.output_tp),
    postRollSeconds: POST_ROLL_SECONDS,
  });
}

await writeFile(
  path.join(outputDirectory, "mastering-v4-results.json"),
  `${JSON.stringify(outputs, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(outputs, null, 2));
