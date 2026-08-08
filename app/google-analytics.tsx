"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  GA4_MEASUREMENT_ID,
  GOOGLE_TAG_SCRIPT_ID,
  GOOGLE_TAG_SCRIPT_URL,
  isGoogleAnalyticsExcludedPath,
} from "../lib/google-analytics";

type GoogleTag = (...args: unknown[]) => void;

type AnalyticsRuntime = Window & {
  dataLayer?: unknown[];
  gtag?: GoogleTag;
  __torudakeGaConfigured?: boolean;
  __torudakeGaLastPath?: string | null;
};

function setGoogleAnalyticsDisabled(runtime: AnalyticsRuntime, disabled: boolean) {
  Reflect.set(runtime, `ga-disable-${GA4_MEASUREMENT_ID}`, disabled);
}

function ensureGoogleTag(runtime: AnalyticsRuntime) {
  runtime.dataLayer ??= [];
  runtime.gtag ??= function gtag(...args: unknown[]) {
    runtime.dataLayer?.push(args);
  };

  if (!runtime.__torudakeGaConfigured) {
    runtime.gtag("js", new Date());
    runtime.gtag("config", GA4_MEASUREMENT_ID, {
      send_page_view: false,
    });
    runtime.__torudakeGaConfigured = true;
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

    runtime.gtag?.("event", "page_view", {
      page_location: `${window.location.origin}${safePath}`,
      page_path: safePath,
      page_title: document.title,
    });
    runtime.__torudakeGaLastPath = safePath;
  }, [pathname]);

  return null;
}
