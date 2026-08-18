"use client";

/* eslint-disable @next/next/no-img-element -- Local, dimensioned demo stills avoid an optimizer request. */

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  HOME_SHOWCASE_SLIDE_COUNT,
  clampHomeShowcaseIndex,
  homeShowcaseIndexForKey,
  nearestHomeShowcaseIndex,
} from "../lib/home-showcase-carousel";
import styles from "./home-showcase-carousel.module.css";

const SLIDE_LABELS = [
  "実際の完成動画",
  "動画2〜5本・構成イメージ",
  "写真2〜10枚・構成イメージ",
] as const;

type HomeShowcaseCarouselProps = {
  demo: ReactNode;
  openPicker: () => void;
};

function VideoSequenceVisual() {
  const scenes = [
    { src: "/demo/torudake-demo-scene-rain.jpg", label: "雨の街" },
    { src: "/demo/torudake-demo-scene-sea.jpg", label: "海辺" },
    { src: "/demo/torudake-demo-scene-river.jpg", label: "夕暮れ" },
  ] as const;

  return (
    <div className={styles.sequenceVisual} aria-hidden="true">
      <div className={styles.sequenceHeader}>
        <span>3 SCENES</span>
        <i />
        <span>1 REEL</span>
      </div>
      <div className={styles.sequenceFrames}>
        {scenes.map((scene, index) => (
          <figure key={scene.src}>
            <img
              src={scene.src}
              alt=""
              width="360"
              height="640"
              loading="lazy"
              decoding="async"
            />
            <figcaption>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {scene.label}
            </figcaption>
          </figure>
        ))}
      </div>
      <div className={styles.sequenceTimeline}>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function PhotoReelVisual() {
  return (
    <div className={styles.photoVisual} aria-hidden="true">
      <span className={styles.photoGlow} />
      <figure className={styles.photoFlowers}>
        <img
          src="/demo/torudake-photo-flowers-v1.jpg"
          alt=""
          width="600"
          height="400"
          loading="lazy"
          decoding="async"
        />
      </figure>
      <figure className={styles.photoBrunch}>
        <img
          src="/demo/torudake-photo-brunch-v1.jpg"
          alt=""
          width="600"
          height="400"
          loading="lazy"
          decoding="async"
        />
      </figure>
      <figure className={styles.photoDog}>
        <img
          src="/demo/torudake-photo-dog-v1.jpg"
          alt=""
          width="600"
          height="400"
          loading="lazy"
          decoding="async"
        />
      </figure>
      <span className={styles.photoSeal}>PHOTO REEL</span>
    </div>
  );
}

export function HomeShowcaseCarousel({
  demo,
  openPicker,
}: HomeShowcaseCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<Array<HTMLElement | null>>([]);
  const frameRef = useRef<number | null>(null);
  const userScrollingRef = useRef(false);
  const pendingIndexRef = useRef<number | null>(null);

  function pauseInactiveVideos(nextIndex: number) {
    for (const [index, slide] of slideRefs.current.entries()) {
      if (index === nextIndex) continue;
      for (const video of slide?.querySelectorAll("video") ?? []) video.pause();
    }
  }

  function updateActiveIndex(nextIndex: number, announce: boolean) {
    const normalizedIndex = clampHomeShowcaseIndex(
      nextIndex,
      HOME_SHOWCASE_SLIDE_COUNT,
    );
    setActiveIndex(normalizedIndex);
    pauseInactiveVideos(normalizedIndex);
    if (announce) {
      setAnnouncement(
        `${normalizedIndex + 1}枚目、${SLIDE_LABELS[normalizedIndex]}を表示しました。`,
      );
    }
  }

  function showSlide(nextIndex: number) {
    const normalizedIndex = clampHomeShowcaseIndex(
      nextIndex,
      HOME_SHOWCASE_SLIDE_COUNT,
    );
    const viewport = viewportRef.current;
    const slide = slideRefs.current[normalizedIndex];
    if (!viewport || !slide) return;
    userScrollingRef.current = true;
    pendingIndexRef.current = normalizedIndex;
    viewport.scrollTo({
      left: slide.offsetLeft,
      behavior:
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.currentTarget !== event.target) return;
    const nextIndex = homeShowcaseIndexForKey(
      event.key,
      activeIndex,
      HOME_SHOWCASE_SLIDE_COUNT,
    );
    if (nextIndex === null) return;
    event.preventDefault();
    showSlide(nextIndex);
  }

  function handleScroll() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const viewport = viewportRef.current;
      if (!viewport) return;
      const nextIndex = nearestHomeShowcaseIndex(
        viewport.scrollLeft,
        slideRefs.current.map((slide) => slide?.offsetLeft ?? Number.NaN),
      );
      if (nextIndex === activeIndex) return;
      const pendingIndex = pendingIndexRef.current;
      const announce =
        userScrollingRef.current &&
        (pendingIndex === null || pendingIndex === nextIndex);
      if (announce) {
        userScrollingRef.current = false;
        pendingIndexRef.current = null;
      }
      updateActiveIndex(nextIndex, announce);
    });
  }

  useEffect(() => {
    const videos = Array.from(
      viewportRef.current?.querySelectorAll("video") ?? [],
    );
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      for (const video of videos) video.pause();
    };
  }, []);

  return (
    <section
      className={styles.carousel}
      aria-label="作り方の例"
      aria-roledescription="カルーセル"
      data-home-showcase-carousel
    >
      <div className={styles.chrome} aria-hidden="true">
        <span>
          <i /> TORUDAKE SHOWCASE
        </span>
        <strong>
          {String(activeIndex + 1).padStart(2, "0")} / 0{HOME_SHOWCASE_SLIDE_COUNT}
        </strong>
      </div>

      <div
        className={styles.viewport}
        ref={viewportRef}
        role="group"
        tabIndex={0}
        aria-label="作り方の例。左右の矢印キーでも切り替えられます。"
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse") {
            userScrollingRef.current = true;
            pendingIndexRef.current = null;
          }
        }}
        onWheel={() => {
          userScrollingRef.current = true;
          pendingIndexRef.current = null;
        }}
        onScroll={handleScroll}
      >
        <article
          className={`${styles.slide} ${styles.demoSlide}`}
          ref={(node) => {
            slideRefs.current[0] = node;
          }}
          role="group"
          aria-roledescription="スライド"
          aria-label="1 / 3：実際の完成動画"
          aria-hidden={activeIndex === 0 ? undefined : true}
          inert={activeIndex !== 0}
        >
          <span className={styles.slideBadge}>01 / 実際の完成動画</span>
          <div className={styles.demoShell}>{demo}</div>
          <div className={styles.demoCtaRow}>
            <span>音声・テロップ付き、約10秒の完成動画です。</span>
            <button type="button" onClick={openPicker}>
              動画を1本選ぶ <i aria-hidden="true">→</i>
            </button>
          </div>
        </article>

        <article
          className={`${styles.slide} ${styles.sequenceSlide}`}
          ref={(node) => {
            slideRefs.current[1] = node;
          }}
          role="group"
          aria-roledescription="スライド"
          aria-label="2 / 3：動画2〜5本・構成イメージ"
          aria-hidden={activeIndex === 1 ? undefined : true}
          inert={activeIndex !== 1}
        >
          <VideoSequenceVisual />
          <div className={styles.slideCopy}>
            <span className={styles.slideBadge}>
              02 / 動画2〜5本・構成イメージ
            </span>
            <h3>
              選んだ順番のまま、
              <br />
              使う場面をつなぐ。
            </h3>
            <p>
              各動画から使う場面を1〜2か所選び、つなぎ方も調整できます。
            </p>
            <Link href="/video-mix">
              複数の動画から作る <i aria-hidden="true">→</i>
            </Link>
          </div>
        </article>

        <article
          className={`${styles.slide} ${styles.photoSlide}`}
          ref={(node) => {
            slideRefs.current[2] = node;
          }}
          role="group"
          aria-roledescription="スライド"
          aria-label="3 / 3：写真2〜10枚・構成イメージ"
          aria-hidden={activeIndex === 2 ? undefined : true}
          inert={activeIndex !== 2}
        >
          <PhotoReelVisual />
          <div className={styles.slideCopy}>
            <span className={styles.slideBadge}>
              03 / 写真2〜10枚・構成イメージ
            </span>
            <h3>
              写真を選んで、
              <br />
              動きのあるリールに。
            </h3>
            <p>
              5つの仕上がりから選べます。写真ごとの表示時間を自動で整えます。
            </p>
            <Link href="/photo-reel">
              写真から作る <i aria-hidden="true">→</i>
            </Link>
          </div>
        </article>
      </div>

      <div className={styles.controls}>
        <div className={styles.arrowButtons}>
          <button
            type="button"
            aria-label="前の作り方を表示"
            disabled={activeIndex === 0}
            onClick={() => showSlide(activeIndex - 1)}
          >
            <span aria-hidden="true">←</span>
          </button>
          <button
            type="button"
            aria-label="次の作り方を表示"
            disabled={activeIndex === HOME_SHOWCASE_SLIDE_COUNT - 1}
            onClick={() => showSlide(activeIndex + 1)}
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>

        <div
          className={styles.indicators}
          role="group"
          aria-label="作り方を選ぶ"
        >
          {SLIDE_LABELS.map((label, index) => (
            <button
              key={label}
              type="button"
              aria-label={`${index + 1}枚目：${label}`}
              aria-current={activeIndex === index ? "true" : undefined}
              aria-disabled={activeIndex === index ? "true" : undefined}
              onClick={() => showSlide(index)}
            >
              <span />
            </button>
          ))}
        </div>

        <span className={styles.activeLabel} aria-hidden="true">
          {SLIDE_LABELS[activeIndex]}
        </span>
      </div>

      <p className="visuallyHidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
