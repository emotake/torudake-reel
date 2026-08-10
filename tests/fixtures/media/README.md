# Media regression fixtures

Small, deterministic fixtures used to exercise the real container/audio helpers without making an OpenAI API call. The full fixture directory remains below 5 MB.

## Real iPhone fixture

`iphone-xr-hevc-pcm.mov` is a byte-for-byte copy of `Apple/iPhone XR/IMG_3589.mov` from the public `thorsted/digicam_corpus` test corpus.

- Device metadata: Apple iPhone XR, iOS 13.4.1
- Container/tracks: QuickTime MOV, HEVC (`hvc1`) video, signed 16-bit little-endian PCM audio, and the original Core Media metadata tracks
- Display/duration: 1440 x 1080, about 2.94 seconds, rotation 0 degrees
- Pinned upstream commit: `1bc58853d8de8b7f76ee80ef75dd8db8de9c4bd7`
- Source: <https://github.com/thorsted/digicam_corpus/blob/1bc58853d8de8b7f76ee80ef75dd8db8de9c4bd7/Apple/iPhone%20XR/IMG_3589.mov>
- License: [CC0 1.0 Universal](https://github.com/thorsted/digicam_corpus/blob/1bc58853d8de8b7f76ee80ef75dd8db8de9c4bd7/LICENSE)
- SHA-256: `5ff33a1b7527eec60f302da2bf860688dc2a21e9ebf6ee150118d5983d927582`

This fixture covers a genuine iPhone-origin HEVC MOV and the PCM-audio fallback. It does **not** contain non-zero rotation metadata, and must not be described as a rotation-metadata fixture.

## Generated fixtures

The remaining files were generated locally from FFmpeg test/color/silence sources. They contain no third-party footage and are deliberately named as synthetic where that distinction could be unclear.

- `synthetic-portrait-h264-aac.mov`: 360 x 640 H.264 + audible AAC, about 2 seconds. This is a compatibility fixture, not an iPhone recording.
- `silent-portrait.mp4`: 360 x 640 H.264 with **no audio track**.
- `silent-audio-track.mp4`: 180 x 320 H.264 with an AAC track encoded from `anullsrc`. This distinguishes encoded silence from a missing track.
- `landscape.mp4`: 640 x 360 H.264 + AAC.
- `long-305s.mp4`: very-low-resolution H.264 with no audio, used only to verify the five-minute input limit.

The silent-track fixture was produced with the following media sources and settings:

```text
color=c=#5b6573:s=180x320:r=24:d=1.25
anullsrc=r=48000:cl=mono
H.264 yuv420p + AAC mono, duration 1.25 seconds
```

Checksums for generated fixtures:

| File | SHA-256 |
| --- | --- |
| `synthetic-portrait-h264-aac.mov` | `a88fb6e90c94e5a076a95b5657d500d9f5cf396508e6aeb23bb5f71817caa2e5` |
| `silent-portrait.mp4` | `e486989c4972444607f382bcb2408818dd2abab329a8c38d8b4e1285ecf14fd6` |
| `silent-audio-track.mp4` | `b6eb63b64eecac711ec7caa2f81577edbf26b1c64ffce3c74a0395d8d2d113b8` |
| `landscape.mp4` | `25c6bc89e9e6e75ec273a77d3b9560868159800e86d7adc7b5b6229c421195fb` |
| `long-305s.mp4` | `eb5af5e41f813fae1439494b0ffb80a69eacb1e9c9dd073c324c4e66a8f36318` |

