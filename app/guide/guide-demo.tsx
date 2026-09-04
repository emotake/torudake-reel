/* eslint-disable @next/next/no-img-element -- Local, dimensioned product screenshots document the real UI. */
"use client";

import Link from "next/link";
import { useRef } from "react";
import { trackClientEvent } from "../../lib/client-analytics";

export type GuideDemoId =
  | "automatic_captions"
  | "instagram_reels"
  | "youtube_shorts"
  | "ai_narration"
  | "iphone_mov"
  | "japanese_reading";

export type GuideDemoContent = {
  id: GuideDemoId;
  title: string;
  conclusion: string;
  videoPath?: string;
  audioPath?: string;
  imagePath?: string;
  posterPath: string;
  videoDescription: string;
  mediaLabel?: string;
  facts: readonly { label: string; value: string }[];
  available: readonly string[];
  notes: readonly string[];
  ctaHref: string;
  ctaLabel: string;
};

export default function GuideDemo({ demo }: { demo: GuideDemoContent }) {
  const trackedPlayback = useRef(false);

  return (
    <section className="guideProof" aria-labelledby={`${demo.id}-demo-title`}>
      <div className="guideProofIntro">
        <p className="guideProofLabel">先に結論</p>
        <h2 id={`${demo.id}-demo-title`}>{demo.title}</h2>
        <p>{demo.conclusion}</p>
        <Link
          className="guideProofCta"
          href={demo.ctaHref}
          onClick={() => trackClientEvent("guide_cta_clicked", { guide: demo.id })}
        >
          {demo.ctaLabel}<span aria-hidden="true">→</span>
        </Link>
      </div>

      <figure className="guideProofVideo">
        <span>{demo.mediaLabel ?? "10秒の完成例"}</span>
        {demo.videoPath ? (
          <video
            controls
            playsInline
            preload="metadata"
            poster={demo.posterPath}
            onPlay={() => {
              if (trackedPlayback.current) return;
              trackedPlayback.current = true;
              trackClientEvent("guide_demo_started", { guide: demo.id });
            }}
          >
            <source src={demo.videoPath} type="video/mp4" />
          </video>
        ) : null}
        {demo.audioPath ? (
          <div className="guideProofAudio">
            <img src={demo.posterPath} alt="AIナレーションの設定と仕上がり確認画面" />
            <audio
              controls
              preload="metadata"
              onPlay={() => {
                if (trackedPlayback.current) return;
                trackedPlayback.current = true;
                trackClientEvent("guide_demo_started", { guide: demo.id });
              }}
            >
              <source src={demo.audioPath} type="audio/wav" />
            </audio>
          </div>
        ) : null}
        {demo.imagePath ? (
          <img
            className="guideProofStill"
            src={demo.imagePath}
            alt={demo.videoDescription}
          />
        ) : null}
        <figcaption>{demo.videoDescription}</figcaption>
      </figure>

      <dl className="guideProofFacts">
        {demo.facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>

      <div className="guideProofDetails">
        <section>
          <h3>このページの方法でできること</h3>
          <ul>
            {demo.available.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
        <section>
          <h3>始める前に知っておくこと</h3>
          <ul>
            {demo.notes.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      </div>
    </section>
  );
}
