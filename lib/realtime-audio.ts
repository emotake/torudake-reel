const WAV_HEADER_BYTES = 44;

export function decodeBase64Audio(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function pcm16ChunksToWav(
  chunks: Uint8Array[],
  sampleRate = 24_000,
) {
  const pcmByteLength = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  const alignedPcmByteLength = pcmByteLength - (pcmByteLength % 2);
  const wav = new Uint8Array(WAV_HEADER_BYTES + alignedPcmByteLength);
  const view = new DataView(wav.buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      wav[offset + index] = value.charCodeAt(index);
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + alignedPcmByteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, alignedPcmByteLength, true);

  let outputOffset = WAV_HEADER_BYTES;
  let remaining = alignedPcmByteLength;
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const bytesToCopy = Math.min(remaining, chunk.byteLength);
    wav.set(chunk.subarray(0, bytesToCopy), outputOffset);
    outputOffset += bytesToCopy;
    remaining -= bytesToCopy;
  }

  return wav;
}
