/* eslint-disable @next/next/no-img-element -- These small, fixed local stills render without an optimizer request. */

import styles from "./home-rich-visuals.module.css";

export type HomeCreationMode = "single" | "multiple" | "photos";

export const MODE_VISUAL_KINDS = {
  single: "single-video",
  multiple: "video-sequence",
  photos: "photo-selection",
} as const satisfies Record<HomeCreationMode, string>;

const MODE_LABELS: Record<HomeCreationMode, string> = {
  single: "1本の動画を大きく確認するイメージ",
  multiple: "3つの動画クリップを順番につないで1本にするイメージ",
  photos: "選んだ写真に動きを付けてリールにまとめるイメージ",
};

type StillProps = {
  src: string;
  width?: number;
  height?: number;
};

function Still({ src, width = 360, height = 640 }: StillProps) {
  return (
    <img
      src={src}
      alt=""
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
    />
  );
}

export function ModeMediaVisual({ mode }: { mode: HomeCreationMode }) {
  return (
    <div
      className={`${styles.modeMedia} ${styles[`mode_${mode}`]}`}
      role="img"
      aria-label={MODE_LABELS[mode]}
      data-creation-mode={mode}
      data-visual-kind={MODE_VISUAL_KINDS[mode]}
    >
      {mode === "single" ? (
        <Still src="/demo/torudake-demo-scene-sea.jpg" />
      ) : null}

      {mode === "multiple" ? (
        <div className={styles.videoSequence} aria-hidden="true">
          <span className={styles.videoClip} data-mode-item="video">
            <Still src="/demo/torudake-demo-scene-rain.jpg" />
            <i>1</i>
          </span>
          <span className={styles.videoClip} data-mode-item="video">
            <Still src="/demo/torudake-demo-scene-sea.jpg" />
            <i>2</i>
          </span>
          <span className={styles.videoClip} data-mode-item="video">
            <Still src="/demo/torudake-demo-scene-river.jpg" />
            <i>3</i>
          </span>
          <span className={styles.sequenceRail} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      ) : null}

      {mode === "photos" ? (
        <div className={styles.photoSelection} aria-hidden="true">
          <span className={styles.photoPrint} data-mode-item="photo">
            <Still
              src="/demo/torudake-photo-flowers-v1.jpg"
              width={600}
              height={400}
            />
          </span>
          <span className={styles.photoPrint} data-mode-item="photo">
            <Still
              src="/demo/torudake-photo-brunch-v1.jpg"
              width={600}
              height={400}
            />
          </span>
          <span className={styles.photoPrint} data-mode-item="photo">
            <Still
              src="/demo/torudake-photo-dog-v1.jpg"
              width={600}
              height={400}
            />
          </span>
        </div>
      ) : null}
    </div>
  );
}
