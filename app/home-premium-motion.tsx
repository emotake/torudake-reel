"use client";

/* eslint-disable @next/next/no-img-element -- Fixed, tiny local demo stills avoid an image optimizer request in this interactive comparison. */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import styles from "./home-premium-motion.module.css";

type MotionMediaQuery = MediaQueryList & {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

const ENTER_EASING = "cubic-bezier(.16, 1, .3, 1)";

function setRevealed(element: HTMLElement) {
  element.setAttribute("data-home-revealed", "true");
}

function trackMotionAnimation(animation: Animation, activeAnimations: Set<Animation>) {
  activeAnimations.add(animation);
  const release = () => activeAnimations.delete(animation);
  animation.addEventListener("finish", release, { once: true });
  animation.addEventListener("cancel", release, { once: true });
}

function cancelMotionAnimations(root: HTMLElement, activeAnimations: Set<Animation>) {
  Array.from(activeAnimations).forEach((animation) => animation.cancel());
  activeAnimations.clear();
  if (typeof root.getAnimations === "function") {
    root.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
  }
}

function animateScene(element: HTMLElement, activeAnimations: Set<Animation>) {
  setRevealed(element);
  const order = Math.max(0, Math.min(5, Number(element.dataset.homeRevealOrder ?? 0)));
  const animation = element.animate(
    [
      { opacity: 0.86, transform: "translate3d(0, 18px, 0) scale(.994)" },
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
    ],
    {
      delay: order * 80,
      duration: 700,
      easing: ENTER_EASING,
      fill: "backwards",
    },
  );
  trackMotionAnimation(animation, activeAnimations);
}

function animateHeroStory(root: HTMLElement, activeAnimations: Set<Animation>) {
  const hero = root.querySelector<HTMLElement>(
    '[data-home-motion-visual="source-to-reel"]',
  );
  if (!hero) return;
  const parts = Array.from(
    hero.querySelectorAll<HTMLElement>("[data-home-motion-part]"),
  );
  const order: Record<string, number> = {
    "brand-accent": 0,
    sources: 60,
    "source-card": 110,
    flow: 460,
    "flow-path": 500,
    result: 720,
    "result-phone": 790,
    "result-features": 1120,
    status: 1320,
  };

  parts.forEach((part, index) => {
    const name = part.dataset.homeMotionPart ?? "";
    const itemOrder = Number(part.dataset.homeMotionOrder ?? 0);
    const delay = (order[name] ?? 120) + itemOrder * 70 + index * 7;
    const animation = part.animate(
      [
        { opacity: 1, transform: "translate3d(0, 4px, 0) scale(.99)" },
        { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
      ],
      {
        delay,
        duration: name === "flow" || name === "flow-path" ? 620 : 720,
        easing: ENTER_EASING,
        fill: "backwards",
      },
    );
    trackMotionAnimation(animation, activeAnimations);
  });
}

export function HomeMotionExperience({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)") as MotionMediaQuery;
    const finePointerQuery = window.matchMedia("(hover: hover) and (pointer: fine)") as MotionMediaQuery;
    const revealElements = Array.from(
      root.querySelectorAll<HTMLElement>("[data-home-reveal]"),
    );
    const heroVisual = root.querySelector<HTMLElement>(
      '[data-home-motion-visual="source-to-reel"]',
    );
    let observer: IntersectionObserver | null = null;
    let frameId = 0;
    let paused = document.visibilityState === "hidden";
    let pointerX = 0;
    let pointerY = 0;
    let heroPlayed = false;
    let disposed = false;
    let observerGeneration = 0;
    const activeAnimations = new Set<Animation>();

    const resetDepth = () => {
      pointerX = 0;
      pointerY = 0;
      root.style.setProperty("--home-depth-x", "0px");
      root.style.setProperty("--home-depth-y", "0px");
      root.style.setProperty("--home-depth-rotate-x", "0deg");
      root.style.setProperty("--home-depth-rotate-y", "0deg");
      root.style.setProperty("--home-depth-story-x", "0px");
      root.style.setProperty("--home-depth-story-y", "0px");
    };

    const flushPointer = () => {
      frameId = 0;
      if (paused || reducedQuery.matches || !finePointerQuery.matches) {
        resetDepth();
        return;
      }
      root.style.setProperty("--home-depth-x", `${(pointerX * 3).toFixed(2)}px`);
      root.style.setProperty("--home-depth-y", `${(pointerY * 2).toFixed(2)}px`);
      root.style.setProperty("--home-depth-rotate-x", `${(-pointerY * 1.25).toFixed(2)}deg`);
      root.style.setProperty("--home-depth-rotate-y", `${(pointerX * 1.6).toFixed(2)}deg`);
      root.style.setProperty("--home-depth-story-x", `${(-pointerX * 1.1).toFixed(2)}px`);
      root.style.setProperty("--home-depth-story-y", `${(-pointerY * 0.7).toFixed(2)}px`);
    };

    const requestPointerFrame = () => {
      if (!frameId) frameId = window.requestAnimationFrame(flushPointer);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !finePointerQuery.matches || reducedQuery.matches) return;
      pointerX = Math.max(-1, Math.min(1, (event.clientX / window.innerWidth - 0.5) * 2));
      pointerY = Math.max(-1, Math.min(1, (event.clientY / window.innerHeight - 0.5) * 2));
      requestPointerFrame();
    };

    const handlePointerLeave = () => {
      resetDepth();
    };

    const revealVisibleElements = (animate: boolean) => {
      const viewportHeight = window.innerHeight;
      revealElements.forEach((element) => {
        const bounds = element.getBoundingClientRect();
        if (bounds.bottom <= 0 || bounds.top >= viewportHeight) return;
        if (!element.hasAttribute("data-home-revealed")) {
          if (animate) animateScene(element, activeAnimations);
          else setRevealed(element);
        }
      });
    };

    const playHero = () => {
      if (heroPlayed || reducedQuery.matches || paused) return;
      heroPlayed = true;
      animateHeroStory(root, activeAnimations);
    };

    const playHeroIfVisible = () => {
      if (!heroVisual) return;
      const bounds = heroVisual.getBoundingClientRect();
      if (bounds.bottom > 0 && bounds.top < window.innerHeight) playHero();
    };

    const setupMotion = () => {
      if (disposed) return;
      const generation = ++observerGeneration;
      observer?.disconnect();
      observer = null;
      resetDepth();

      if (reducedQuery.matches) {
        root.dataset.homeMotion = "reduced";
        cancelMotionAnimations(root, activeAnimations);
        revealElements.forEach(setRevealed);
        return;
      }

      root.dataset.homeMotion = "enhanced";
      revealVisibleElements(false);
      playHeroIfVisible();

      if (typeof IntersectionObserver === "undefined") {
        revealElements.forEach(setRevealed);
        playHero();
        return;
      }

      const currentObserver = new IntersectionObserver(
        (entries) => {
          if (
            disposed ||
            generation !== observerGeneration ||
            observer !== currentObserver
          ) {
            return;
          }
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const element = entry.target as HTMLElement;
            if (reducedQuery.matches || paused) {
              setRevealed(element);
              if (element !== heroVisual || heroPlayed) currentObserver.unobserve(element);
              return;
            }
            if (element === heroVisual) {
              playHero();
              if (!heroPlayed) return;
              setRevealed(element);
              currentObserver.unobserve(element);
              return;
            }
            if (!element.hasAttribute("data-home-revealed")) {
              animateScene(element, activeAnimations);
            }
            currentObserver.unobserve(element);
          });
        },
        { threshold: 0.15, rootMargin: "80px 0px -10%" },
      );
      observer = currentObserver;
      revealElements.forEach((element) => {
        if (!element.hasAttribute("data-home-revealed")) currentObserver.observe(element);
      });
      if (heroVisual && !heroPlayed) currentObserver.observe(heroVisual);
    };

    const handleMotionPreference = () => setupMotion();
    const handlePointerPreference = () => {
      if (!finePointerQuery.matches) resetDepth();
    };
    const handleVisibility = () => {
      paused = document.visibilityState === "hidden";
      root.toggleAttribute("data-home-paused", paused);
      if (paused) {
        if (frameId) window.cancelAnimationFrame(frameId);
        frameId = 0;
        cancelMotionAnimations(root, activeAnimations);
        resetDepth();
      } else {
        revealVisibleElements(false);
        playHeroIfVisible();
      }
    };
    const handlePageHide = () => {
      paused = true;
      root.setAttribute("data-home-paused", "");
      cancelMotionAnimations(root, activeAnimations);
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = 0;
      resetDepth();
    };
    const handlePageShow = () => {
      paused = document.visibilityState === "hidden";
      root.toggleAttribute("data-home-paused", paused);
      if (!paused) {
        revealVisibleElements(false);
        playHeroIfVisible();
      }
    };

    setupMotion();
    root.addEventListener("pointermove", handlePointerMove, { passive: true });
    root.addEventListener("pointerleave", handlePointerLeave);
    root.addEventListener("pointercancel", handlePointerLeave);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);

    if (reducedQuery.addEventListener) reducedQuery.addEventListener("change", handleMotionPreference);
    else reducedQuery.addListener?.(handleMotionPreference);
    if (finePointerQuery.addEventListener) finePointerQuery.addEventListener("change", handlePointerPreference);
    else finePointerQuery.addListener?.(handlePointerPreference);

    return () => {
      disposed = true;
      observerGeneration += 1;
      observer?.disconnect();
      if (frameId) window.cancelAnimationFrame(frameId);
      cancelMotionAnimations(root, activeAnimations);
      root.removeEventListener("pointermove", handlePointerMove);
      root.removeEventListener("pointerleave", handlePointerLeave);
      root.removeEventListener("pointercancel", handlePointerLeave);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      if (reducedQuery.removeEventListener) reducedQuery.removeEventListener("change", handleMotionPreference);
      else reducedQuery.removeListener?.(handleMotionPreference);
      if (finePointerQuery.removeEventListener) finePointerQuery.removeEventListener("change", handlePointerPreference);
      else finePointerQuery.removeListener?.(handlePointerPreference);
      resetDepth();
    };
  }, []);

  return (
    <div
      className={`landingRouter ${styles.motionRoot}`}
      data-home-motion-root
      data-home-motion="static"
      ref={rootRef}
    >
      {children}
    </div>
  );
}

export function HomeTransformationCompare() {
  const [position, setPosition] = useState(58);
  const progress = position / 100;
  const compareStyle = {
    "--home-compare-progress": progress,
    "--home-compare-offset": `${100 - position}%`,
    "--home-compare-inner-offset": `${position - 100}%`,
    "--home-compare-divider": `${position}%`,
  } as CSSProperties;

  return (
    <figure className={styles.compare} data-home-compare style={compareStyle}>
      <div className={styles.compareStage}>
        <div className={styles.before} data-home-compare-before aria-hidden="true">
          <span className={styles.stageLabel}>編集前</span>
          <div className={styles.sourceStrip}>
            <img src="/demo/torudake-demo-scene-rain.jpg" alt="" width="360" height="640" />
            <img src="/demo/torudake-demo-scene-sea.jpg" alt="" width="360" height="640" />
            <img src="/demo/torudake-demo-scene-river.jpg" alt="" width="360" height="640" />
          </div>
          <small>編集前に選んだ3つの場面</small>
        </div>
        <div className={styles.after} data-home-compare-after aria-hidden="true">
          <div className={styles.afterInner}>
            <span className={styles.stageLabel}>編集後</span>
            <div className={styles.finishedPhone}>
              <img src="/demo/torudake-demo-poster.jpg" alt="" width="360" height="640" />
              <span>雨上がりの街を歩く</span>
              <i>完成</i>
            </div>
            <small>カット・音声・テロップを整えた、10秒の完成動画へ</small>
          </div>
        </div>
        <span className={styles.compareGlow} aria-hidden="true" />
      </div>

      <label className={styles.compareControl}>
        <span>
          <strong>編集前</strong>
          <small>つまみを動かして変化を見る</small>
          <strong>編集後</strong>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={position}
          data-home-compare-range
          aria-label="編集前と編集後を比較"
          aria-valuetext={`編集後を${position}%表示`}
          onChange={(event) => setPosition(Number(event.currentTarget.value))}
        />
      </label>
      <figcaption>素材が、投稿できる一本へ変わる流れを比較できます。</figcaption>
    </figure>
  );
}
