import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TARGET_LUFS = -20.8;
const TARGET_TRUE_PEAK_DBTP = -3;
const TARGET_LRA = 9;
const POST_ROLL_SECONDS = 0.35;
const ACTIVE_FRAME_SECONDS = 0.005;
const ACTIVE_RMS_DBFS = -35;
const DENOISE_FILTER = [
  "highpass=f=70:p=2",
  "lowpass=f=10500:p=2",
  "afftdn=nr=6:nf=-60:tn=1:tr=1:gs=10",
].join(",");

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

function inspectPcm16Wav(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Expected a RIFF WAV input");
  }
  const dataIndex = bytes.indexOf(Buffer.from("data"));
  if (dataIndex < 36) throw new Error("WAV data chunk is missing");
  const sampleRate = bytes.readUInt32LE(24);
  const channels = bytes.readUInt16LE(22);
  const bitsPerSample = bytes.readUInt16LE(34);
  if (sampleRate !== 24_000 || channels !== 1 || bitsPerSample !== 16) {
    throw new Error("Expected 24 kHz mono PCM16 input");
  }
  const dataLength = bytes.readUInt32LE(dataIndex + 4);
  const pcm = new Int16Array(
    bytes.buffer,
    bytes.byteOffset + dataIndex + 8,
    Math.floor(dataLength / 2),
  );
  const frameSamples = Math.round(sampleRate * ACTIVE_FRAME_SECONDS);
  const threshold = 10 ** (ACTIVE_RMS_DBFS / 20) * 32_768;
  let lastActiveSample = 0;
  for (let start = 0; start < pcm.length; start += frameSamples) {
    const end = Math.min(pcm.length, start + frameSamples);
    let energy = 0;
    for (let index = start; index < end; index += 1) {
      energy += pcm[index] ** 2;
    }
    const rms = Math.sqrt(energy / Math.max(1, end - start));
    if (rms > threshold) lastActiveSample = end;
  }
  return {
    durationSeconds: pcm.length / sampleRate,
    activeEndSeconds: lastActiveSample / sampleRate,
  };
}

await mkdir(outputDirectory, { recursive: true });
const outputs = [];
for (const [id, sourceName] of Object.entries(selections)) {
  const input = path.resolve(inputDirectory, sourceName);
  const output = path.resolve(outputDirectory, `${id}-v5.wav`);
  const raw = await readFile(input);
  const rawTiming = inspectPcm16Wav(raw);
  const targetDuration = rawTiming.activeEndSeconds + POST_ROLL_SECONDS;
  const retainedDuration = Math.min(rawTiming.durationSeconds, targetDuration);
  const timingFilter = `atrim=end=${retainedDuration.toFixed(6)}`;
  const firstPass = parseLoudnessReport(
    runFfmpeg([
      "-hide_banner",
      "-nostats",
      "-i",
      input,
      "-af",
      `${DENOISE_FILTER},${timingFilter},loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK_DBTP}:LRA=${TARGET_LRA}:print_format=json`,
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
  const fadeStart = Math.max(0, retainedDuration - 0.02);
  const secondPass = parseLoudnessReport(
    runFfmpeg([
      "-y",
      "-hide_banner",
      "-nostats",
      "-i",
      input,
      "-af",
      `${DENOISE_FILTER},${timingFilter},${filter},asetpts=N/SR/TB,afade=t=out:st=${fadeStart.toFixed(6)}:d=0.02,apad=whole_dur=${targetDuration.toFixed(6)},atrim=end=${targetDuration.toFixed(6)}`,
      "-ar",
      "24000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      output,
    ]),
  );
  const mastered = await readFile(output);
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
    rawDurationSeconds: rawTiming.durationSeconds,
    activeEndSeconds: rawTiming.activeEndSeconds,
    retainedNaturalTailSeconds:
      retainedDuration - rawTiming.activeEndSeconds,
    finalDurationSeconds: targetDuration,
    postRollSeconds: POST_ROLL_SECONDS,
  });
}

await writeFile(
  path.join(outputDirectory, "mastering-v5-results.json"),
  `${JSON.stringify(outputs, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(outputs, null, 2));
