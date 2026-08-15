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
  eager?: boolean;
};

function Still({ src, eager = false }: StillProps) {
  return (
    <img
      src={src}
      alt=""
      width={360}
      height={640}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
    />
  );
}

export function HomeEditorialHero() {
  return (
    <figure className={styles.editorialHero} aria-labelledby="homeEditorialHeroCaption">
      <div
        className={styles.editorialComposition}
        role="img"
        aria-label="撮影した3つの場面が、投稿できる1本の縦型動画に仕上がるイメージ"
      >
        <div className={styles.sourceEditorial} aria-hidden="true">
          <p className={styles.mediaHeading}>撮影した素材</p>
          <div className={styles.sourceTriptych}>
            <Still src="/demo/torudake-demo-scene-rain.jpg" eager />
            <Still src="/demo/torudake-demo-scene-sea.jpg" eager />
            <Still src="/demo/torudake-demo-scene-river.jpg" eager />
          </div>
        </div>

        <div className={styles.editorialTransition} aria-hidden="true">
          <span>→</span>
          <strong>1本へ</strong>
        </div>

        <div className={styles.resultEditorial} aria-hidden="true">
          <p className={styles.mediaHeading}>仕上がり</p>
          <div className={styles.resultStill}>
            <Still src="/demo/torudake-demo-poster.jpg" eager />
          </div>
        </div>
      </div>
      <figcaption id="homeEditorialHeroCaption">
        3つの場面から、投稿できる縦型動画へ。
      </figcaption>
    </figure>
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
