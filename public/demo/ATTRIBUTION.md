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

## Final media

- File: `public/demo/torudake-demo.mp4`
- 1080 × 1920, 30 fps, H.264 High Profile + AAC-LC
- 10.4 seconds, BT.709 SDR, fast-start MP4
- Final audio target: -14 LUFS integrated, -1.5 dBTP
- Lightweight landing preview: `public/demo/torudake-demo-lite.mp4`, derived from the final media at 720 × 1280 with no audio. It is used only to reduce initial mobile transfer size; the full demo remains the source for the interactive sample.
- Poster: `public/demo/torudake-demo-poster.jpg`, a frame extracted from the final media for reduced-motion and tap-to-play states.
