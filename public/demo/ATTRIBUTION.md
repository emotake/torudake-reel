# Demo media provenance

## Licensed footage

The demo uses three Pexels videos, credited here even though attribution is not required by the Pexels License:

- Rainy city: KADO FUETA — [Pexels video 17243368](https://www.pexels.com/video/17243368/)
- Ocean sunset: Trippy Clicker — [Pexels video 7975481](https://www.pexels.com/video/7975481/)
- River sunset: Marc Espejo — [Pexels video 10289665](https://www.pexels.com/video/10289665/)

All three works are used under the [Pexels License](https://www.pexels.com/license/), which permits free use and modification. The source clips are not redistributed as standalone stock footage; they are trimmed, reframed, sequenced, mixed with narration, and encoded as one edited product demonstration.

## Editing

- Sequence: rainy city → ocean sunset → river sunset.
- Each source is trimmed and reframed to 9:16. The landscape river clip is center-cropped; the vertical sources are scaled with high-quality resampling.
- Scene changes use 0.35-second crossfades. No third-party logo or copied text is embedded in the video.
- The ocean source audio is used only as a very quiet ambient layer beneath the narration. Other source audio is omitted.
- Captions are rendered by the Torudake Reel website UI at playback time so they remain editable and accessible; they are not burned into the MP4.

## Narration

The existing Japanese narration WAV under `scripts/demo-composition/assets/narration.wav` was generated on 2026-08-10 with the same `gpt-realtime-2.1-mini` model family used by the production narration route. The temporary generation key was revoked immediately after the WAV was saved. This update does not regenerate or imitate a new voice; it only applies restrained local processing for clarity (70 Hz high-pass, 11 kHz low-pass, mild presence EQ and compression) and final loudness normalization.

## Voice previews

The four `public/demo/voices/*-v3.wav` previews were generated on 2026-08-13 with the production `gpt-realtime-2.1-mini` model and the same voice, speed, and instruction profile used by each production delivery template. Generation was performed through a temporary authenticated operations route that accepted only the four fixed sample scripts; that route was removed immediately after generation. The selected takes were processed locally with edge-silence trimming, light filtering and compression, short edge fades, and loudness matching. Exact scripts, profiles, measurements, byte lengths, and SHA-256 hashes are recorded in `public/demo/voices/manifest-v3.json`.

The four `public/demo/voices/*-v4.wav` previews replace v3 after a trailing-syllable audit. They were generated on 2026-08-13 with the production `gpt-realtime-2.1-mini` model and the same voice, speed, and `2026-08-13-quality-v3` delivery profile used in production. A temporary authenticated, fixed-script-only route was used and removed immediately after generation. Three takes per style were compared; the complete selected raw take was preserved without edge trimming, loudness-normalized to about -18.5 LUFS with a -2.5 dBTP ceiling, and followed by 350 ms of digital silence. The reproducible non-secret mastering procedure is `scripts/master-voice-samples.mjs`; provenance, raw and final hashes, measurements, and scripts are in `public/demo/voices/manifest-v4.json`.

The four `public/demo/voices/*-v5.wav` previews replace v4 after users reported a misread bright-male sample and audible background noise. They use the production `gpt-realtime-2.1-mini` model and `2026-08-13-quality-v4` profile. A temporary authenticated endpoint accepted only the four repository-defined scripts, required realtime generation without fallback, and transcribed every raw take for selection; it was removed before the final build. Twenty initial takes plus five bounded replacement takes for the bright voice were compared. The selected take for each voice preserved the opening, important words, and ending after Japanese orthographic normalization. Mastering applies a 70 Hz high-pass, 10.5 kHz low-pass, gentle noise reduction, approximately -20.8 LUFS normalization, a -3 dBTP ceiling, and an exact 350 ms post-speech duration. Full provenance, transcripts, hashes, and measurements are recorded in `public/demo/voices/manifest-v5.json`.

## Final media

- File: `public/demo/torudake-demo.mp4`
- 1080 × 1920, 30 fps, H.264 High Profile + AAC-LC
- 10.4 seconds, BT.709 SDR, fast-start MP4
- Final audio target: -14 LUFS integrated, -1.5 dBTP
- Lightweight landing preview: `public/demo/torudake-demo-lite.mp4`, derived from the final media at 720 × 1280 with no audio. It is used only to reduce initial mobile transfer size; the full demo remains the source for the interactive sample.
- Poster: `public/demo/torudake-demo-poster.jpg`, a frame extracted from the final media for reduced-motion and tap-to-play states.
- Landing scene stills: `public/demo/torudake-demo-scene-{rain,sea,river}.jpg`, three lightweight 360 × 640 frames extracted from the same licensed and edited demo video for the home-page before/after explanation.
