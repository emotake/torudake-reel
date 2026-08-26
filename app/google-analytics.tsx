"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  GA4_MEASUREMENT_IDS,
  GOOGLE_TAG_SCRIPT_ID,
  GOOGLE_TAG_SCRIPT_URL,
  createGoogleTagCommandQueue,
  isGoogleAnalyticsExcludedPath,
  sendGoogleAnalyticsEvent,
  type GoogleTag,
} from "../lib/google-analytics";

type AnalyticsRuntime = Window & {
  dataLayer?: unknown[];
  gtag?: GoogleTag;
  __torudakeGaConfiguredIds?: Set<string>;
  __torudakeGaLastPath?: string | null;
};

function setGoogleAnalyticsDisabled(runtime: AnalyticsRuntime, disabled: boolean) {
  for (const measurementId of GA4_MEASUREMENT_IDS) {
    Reflect.set(runtime, `ga-disable-${measurementId}`, disabled);
  }
}

function ensureGoogleTag(runtime: AnalyticsRuntime) {
  const dataLayer = runtime.dataLayer ??= [];
  runtime.gtag ??= createGoogleTagCommandQueue(dataLayer);

  const configuredIds =
    runtime.__torudakeGaConfiguredIds ??= new Set<string>();
  if (configuredIds.size === 0) {
    runtime.gtag("js", new Date());
  }
  for (const measurementId of GA4_MEASUREMENT_IDS) {
    if (configuredIds.has(measurementId)) continue;
    runtime.gtag("config", measurementId, {
      send_page_view: false,
    });
    configuredIds.add(measurementId);
  }

  if (!document.getElementById(GOOGLE_TAG_SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = GOOGLE_TAG_SCRIPT_ID;
    script.async = true;
    script.src = GOOGLE_TAG_SCRIPT_URL;
    document.head.appendChild(script);
  }
}

export default function GoogleAnalytics() {
  const pathname = usePathname();

  useEffect(() => {
    const safePath = pathname || "/";
    const runtime = window as AnalyticsRuntime;
    const excluded = isGoogleAnalyticsExcludedPath(safePath);

    setGoogleAnalyticsDisabled(runtime, excluded);

    if (excluded) {
      runtime.__torudakeGaLastPath = null;
      return;
    }

    ensureGoogleTag(runtime);

    if (runtime.__torudakeGaLastPath === safePath) {
      return;
    }

    sendGoogleAnalyticsEvent(runtime.gtag, "page_view", {
      page_location: `${window.location.origin}${safePath}`,
      page_path: safePath,
      page_title: document.title,
    });
    runtime.__torudakeGaLastPath = safePath;
  }, [pathname]);

  return null;
}
