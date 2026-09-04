"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { attributionToSearch } from "../lib/acquisition";
import { captureCurrentAttribution } from "../lib/client-attribution";
import { trackClientEvent } from "../lib/client-analytics";
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
  __torudakeAcquisitionTracked?: boolean;
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

    const attribution = captureCurrentAttribution();

    if (runtime.__torudakeGaLastPath === safePath) {
      return;
    }

    sendGoogleAnalyticsEvent(runtime.gtag, "page_view", {
      page_location: `${window.location.origin}${safePath}${attributionToSearch(attribution)}`,
      page_path: safePath,
      page_title: document.title,
      campaign_source: attribution.traffic_source,
      campaign_medium: attribution.traffic_medium,
      campaign_name: attribution.traffic_campaign,
      campaign_content: attribution.traffic_content,
    });
    if (!runtime.__torudakeAcquisitionTracked) {
      trackClientEvent("acquisition_landing");
      runtime.__torudakeAcquisitionTracked = true;
    }
    runtime.__torudakeGaLastPath = safePath;
  }, [pathname]);

  return null;
}
