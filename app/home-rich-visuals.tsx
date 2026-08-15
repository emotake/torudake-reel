import styles from "./home-rich-visuals.module.css";

export type HomeCreationMode = "single" | "multiple" | "photos";
export type HomeWorkflowStep = "select" | "settings" | "preview";

const MODE_LABELS: Record<HomeCreationMode, string> = {
  single: "1本の動画から、見せたい場面を整えるイメージ",
  multiple: "複数の動画から、よい場面をつないで仕上げるイメージ",
  photos: "複数の写真に動きをつけて、リールに仕上げるイメージ",
};

const WORKFLOW_LABELS: Record<HomeWorkflowStep, string> = {
  select: "動画や写真を選ぶ操作画面のイメージ",
  settings: "音声とテロップを選ぶ操作画面のイメージ",
  preview: "完成前に縦型動画を確認する画面のイメージ",
};

function PlayMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8.2 5.7c0-1 1.1-1.6 1.9-1l8.2 6.3c.7.5.7 1.5 0 2l-8.2 6.3c-.8.6-1.9 0-1.9-1V5.7Z" />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m3.2 8.1 3 3.1 6.7-6.6" />
    </svg>
  );
}

function FlowArrow({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      data-home-motion-part="flow-path"
      viewBox="0 0 112 42"
      aria-hidden="true"
      focusable="false"
    >
      <path className={styles.flowTrack} d="M4 25c24 0 32-16 55-16 18 0 24 12 41 12" />
      <path className={styles.flowPulse} d="M4 25c24 0 32-16 55-16 18 0 24 12 41 12" />
      <path className={styles.flowHead} d="m93 14 8 7-8 7" />
    </svg>
  );
}

/**
 * Hero graphic that turns three source clips into one vertical reel.
 * The surrounding copy should explain the product; this figure supplies the
 * immediate visual proof without adding another interactive control.
 */
export function HeroOutcomeVisual() {
  return (
    <figure className={styles.heroOutcome}>
      <div
        className={styles.heroCanvas}
        data-home-reveal="hero-outcome"
        data-home-depth="hero-outcome"
        data-home-motion-visual="source-to-reel"
        aria-hidden="true"
      >
        <span
          className={`${styles.brandDot} ${styles.brandDotMint}`}
          data-home-motion-part="brand-accent"
        />
        <span
          className={`${styles.brandDot} ${styles.brandDotCoral}`}
          data-home-motion-part="brand-accent"
        />
        <span className={styles.brandDash} data-home-motion-part="brand-accent" />

        <div className={styles.sourceGroup} data-home-motion-part="sources">
          <div className={styles.sourceHeading}>
            <span>素材</span>
            <strong>3つの場面</strong>
          </div>

          <div
            className={`${styles.sourceCard} ${styles.sourceCardRain}`}
            data-home-motion-part="source-card"
            data-home-motion-order="1"
          >
            <div className={`${styles.sceneImage} ${styles.sceneRain}`} />
            <div className={styles.sourceMeta}>
              <span>雨の日</span>
              <small>00:04</small>
            </div>
          </div>

          <div
            className={`${styles.sourceCard} ${styles.sourceCardSea}`}
            data-home-motion-part="source-card"
            data-home-motion-order="2"
          >
            <div className={`${styles.sceneImage} ${styles.sceneSea}`} />
            <div className={styles.sourceMeta}>
              <span>海辺</span>
              <small>00:06</small>
            </div>
          </div>

          <div
            className={`${styles.sourceCard} ${styles.sourceCardRiver}`}
            data-home-motion-part="source-card"
            data-home-motion-order="3"
          >
            <div className={`${styles.sceneImage} ${styles.sceneRiver}`} />
            <div className={styles.sourceMeta}>
              <span>川沿い</span>
              <small>00:05</small>
            </div>
          </div>
        </div>

        <div className={styles.heroFlow} data-home-motion-part="flow">
          <span>自動で整える</span>
          <FlowArrow />
        </div>

        <div className={styles.resultGroup} data-home-motion-part="result">
          <div className={styles.resultHeading}>
            <span className={styles.resultStatus} data-home-motion-part="status">
              <i /> 完成プレビュー
            </span>
            <strong>9:16</strong>
          </div>
          <div className={styles.heroPhone} data-home-motion-part="result-phone">
            <div className={styles.phoneSpeaker} />
            <div className={styles.phoneScreen}>
              <div className={styles.posterImage} />
              <div className={styles.posterShade} />
              <div className={styles.posterCopy}>
                <small>休日の記録</small>
                <strong>雨上がりの街を歩く</strong>
              </div>
              <span className={styles.heroPlay}>完成</span>
              <div className={styles.captionSample}>
                雨のあとの景色を、一本のリールに。
              </div>
              <div className={styles.playerRail}>
                <span />
              </div>
            </div>
          </div>
          <div
            className={styles.resultChip}
            data-home-motion-part="result-features"
          >
            <span>テロップ</span>
            <span>音声</span>
            <span>1080p</span>
          </div>
        </div>
      </div>
      <figcaption>
        素材を選ぶと、見せたい場面をまとめた縦型動画を確認できます。
      </figcaption>
    </figure>
  );
}

export function ModeMiniVisual({ mode }: { mode: HomeCreationMode }) {
  return (
    <div
      className={`${styles.modeVisual} ${styles[`mode_${mode}`]}`}
      data-home-motion-visual={`mode-${mode}`}
      role="img"
      aria-label={MODE_LABELS[mode]}
    >
      {mode === "single" ? <SingleModeArtwork /> : null}
      {mode === "multiple" ? <MultipleModeArtwork /> : null}
      {mode === "photos" ? <PhotosModeArtwork /> : null}
    </div>
  );
}

function SingleModeArtwork() {
  return (
    <>
      <div className={styles.singleFrame} aria-hidden="true">
        <div className={`${styles.modeImage} ${styles.sceneSea}`}>
          <span className={styles.framePlay}>
            <PlayMark />
          </span>
        </div>
        <div className={styles.trimRail}>
          <i />
          <span />
          <b />
        </div>
      </div>
      <FlowArrow className={styles.modeArrow} />
      <div className={styles.miniReel} aria-hidden="true">
        <div className={`${styles.miniReelImage} ${styles.sceneSea}`} />
        <span>見せたい場面</span>
      </div>
    </>
  );
}

function MultipleModeArtwork() {
  return (
    <>
      <div className={styles.clipStack} aria-hidden="true">
        <span className={`${styles.clipTile} ${styles.sceneRain}`} />
        <span className={`${styles.clipTile} ${styles.sceneSea}`} />
        <span className={`${styles.clipTile} ${styles.sceneRiver}`} />
      </div>
      <div className={styles.sequenceRail} aria-hidden="true">
        <span className={styles.sequenceRain}>1</span>
        <span className={styles.sequenceSea}>2</span>
        <span className={styles.sequenceRiver}>3</span>
      </div>
      <div className={styles.sequenceCaption} aria-hidden="true">
        <i /> よい場面をつなぐ
      </div>
    </>
  );
}

function PhotosModeArtwork() {
  return (
    <>
      <div className={styles.photoFan} aria-hidden="true">
        <span className={`${styles.photoSheet} ${styles.photoRain}`} />
        <span className={`${styles.photoSheet} ${styles.photoRiver}`} />
        <span className={`${styles.photoSheet} ${styles.photoSea}`}>
          <i className={styles.photoFocus} />
        </span>
      </div>
      <svg
        className={styles.photoMotion}
        viewBox="0 0 78 38"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M7 29c17-22 39-24 61-9" />
        <path d="m60 13 9 7-10 4" />
      </svg>
      <span className={styles.motionChip} aria-hidden="true">
        ゆっくり動く
      </span>
    </>
  );
}

export function WorkflowMiniVisual({ step }: { step: HomeWorkflowStep }) {
  return (
    <div
      className={`${styles.workflowVisual} ${styles[`workflow_${step}`]}`}
      data-home-motion-visual={`workflow-${step}`}
      role="img"
      aria-label={WORKFLOW_LABELS[step]}
    >
      <div
        className={styles.mockWindow}
        data-home-motion-part="workflow-window"
        aria-hidden="true"
      >
        <div className={styles.mockBar}>
          <span />
          <span />
          <span />
          <small>
            {step === "select" ? "素材を選ぶ" : step === "settings" ? "仕上がり設定" : "プレビュー"}
          </small>
        </div>
        {step === "select" ? <SelectArtwork /> : null}
        {step === "settings" ? <SettingsArtwork /> : null}
        {step === "preview" ? <PreviewArtwork /> : null}
      </div>
    </div>
  );
}

function SelectArtwork() {
  return (
    <div className={styles.selectArtwork}>
      <div className={`${styles.selectTile} ${styles.sceneRain}`}>
        <span className={styles.selectedBadge}>
          <CheckMark />
        </span>
        <small>00:04</small>
      </div>
      <div className={`${styles.selectTile} ${styles.sceneSea}`}>
        <span className={styles.selectedBadge}>
          <CheckMark />
        </span>
        <small>00:06</small>
      </div>
      <div className={`${styles.selectTile} ${styles.sceneRiver}`}>
        <span className={styles.selectedBadge}>
          <CheckMark />
        </span>
        <small>00:05</small>
      </div>
      <div className={styles.selectionSummary}>
        <span>
          <b>3</b>件を選択
        </span>
        <strong>次へ</strong>
      </div>
    </div>
  );
}

function SettingsArtwork() {
  return (
    <div className={styles.settingsArtwork}>
      <div className={styles.settingMiniPhone}>
        <div className={`${styles.settingPoster} ${styles.sceneSea}`} />
        <span className={styles.settingCaptionLines}>
          <i />
          <i />
        </span>
      </div>

      <div className={styles.settingTools}>
        <span className={styles.soundTool}>
          <svg viewBox="0 0 32 18" focusable="false">
            <path d="M2 9h3m3-4v8m4-10v12m4-8v4m4-7v10m4-8v6m3-3h3" />
          </svg>
          <i />
        </span>
        <span className={styles.captionTool}>
          <b>Aa</b>
          <i />
          <i />
        </span>
      </div>

      <span className={styles.settingsDone}>
        <CheckMark />
      </span>
    </div>
  );
}

function PreviewArtwork() {
  return (
    <div className={styles.previewArtwork}>
      <div className={styles.previewStage}>
        <div className={styles.previewPhone}>
          <div className={`${styles.previewPoster} ${styles.posterImage}`} />
          <span className={styles.previewCaptionLines}>
            <i />
            <i />
          </span>
          <span className={styles.previewPlay}>
            <PlayMark />
          </span>
          <span className={styles.previewProgress}>
            <i />
          </span>
        </div>
        <span className={styles.readyChip}>
          <CheckMark />
        </span>
      </div>
      <span className={styles.previewFinishMark}>
        <i />
        <i />
      </span>
    </div>
  );
}
