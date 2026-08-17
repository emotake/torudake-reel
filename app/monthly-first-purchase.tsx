"use client";

import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { trackClientEvent } from "../lib/client-analytics";

export const MONTHLY_FIRST_OFFER_VERSION = "monthly_primary_rescue_v1";

type PurchaseOfferSource = "landing" | "pricing" | "account" | "result";
type PurchaseOfferMode = "spoken" | "narration" | "photo" | "video_mix";

export function MonthlyFirstPurchaseOptions({
  children,
  className,
  id,
  source,
  mode,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  source: PurchaseOfferSource;
  mode?: PurchaseOfferMode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackedRef = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const recordExposure = () => {
      if (trackedRef.current) return;
      trackedRef.current = true;
      trackClientEvent("purchase_options_shown", {
        ...(mode ? { mode } : {}),
        source,
        offer_version: MONTHLY_FIRST_OFFER_VERSION,
      });
    };

    if (typeof IntersectionObserver === "undefined") {
      recordExposure();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        recordExposure();
        observer.disconnect();
      },
      { threshold: 0.25 },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [mode, source]);

  return (
    <div
      className={className}
      id={id}
      ref={rootRef}
      data-offer-version={MONTHLY_FIRST_OFFER_VERSION}
    >
      {children}
    </div>
  );
}

export function OneTimeRescue({
  children,
  className,
  source,
  mode,
  summary = "月額にせず、今回だけ保存する",
}: {
  children: ReactNode;
  className?: string;
  source: PurchaseOfferSource;
  mode?: PurchaseOfferMode;
  summary?: string;
}) {
  const trackedRef = useRef(false);

  return (
    <details
      className={["oneTimeRescue", className].filter(Boolean).join(" ")}
      onToggle={(event) => {
        if (!event.currentTarget.open || trackedRef.current) return;
        trackedRef.current = true;
        trackClientEvent("one_time_rescue_revealed", {
          ...(mode ? { mode } : {}),
          plan: "one_time",
          source,
          offer_version: MONTHLY_FIRST_OFFER_VERSION,
        });
      }}
    >
      <summary>{summary}</summary>
      <div className="oneTimeRescueBody">{children}</div>
    </details>
  );
}
