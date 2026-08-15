/* eslint-disable @next/next/no-img-element -- These small, fixed local stills render without an optimizer request. */

import styles from "./home-rich-visuals.module.css";

export type HomeCreationMode = "single" | "multiple" | "photos";

const MODE_LABELS: Record<HomeCreationMode, string> = {
  single: "1本の動画を大きく確認するイメージ",
  multiple: "3本の動画素材を並べて選ぶイメージ",
  photos: "複数の写真を一覧で確認するイメージ",
};

type StillProps = {
  src: string;
};

function Still({ src }: StillProps) {
  return (
    <img
      src={src}
      alt=""
      width={360}
      height={640}
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
    >
      {mode === "single" ? (
        <Still src="/demo/torudake-demo-scene-sea.jpg" />
      ) : null}

      {mode === "multiple" ? (
        <>
          <Still src="/demo/torudake-demo-scene-rain.jpg" />
          <Still src="/demo/torudake-demo-scene-sea.jpg" />
          <Still src="/demo/torudake-demo-scene-river.jpg" />
        </>
      ) : null}

      {mode === "photos" ? (
        <>
          <Still src="/demo/torudake-demo-scene-rain.jpg" />
          <Still src="/demo/torudake-demo-scene-sea.jpg" />
          <Still src="/demo/torudake-demo-scene-river.jpg" />
        </>
      ) : null}
    </div>
  );
}
