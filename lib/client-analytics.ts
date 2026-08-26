"use client";

import {
  isClientProductEvent,
  sanitizeProductProperties,
  type ClientProductEvent,
  type SafeProductProperties,
} from "./product-analytics-schema";
import {
  sendGoogleAnalyticsEvent,
  type GoogleTag,
} from "./google-analytics";

type AnalyticsWindow = Window & {
  gtag?: GoogleTag;
};

/** Records only allow-listed, content-free product events. Never pass names,
 * filenames, scripts, captions, transcripts, URLs, or email addresses. */
export function trackClientEvent(
  name: ClientProductEvent,
  properties: SafeProductProperties = {},
) {
  if (typeof window === "undefined") return;
  try {
    const safeProperties = sanitizeProductProperties(properties);
    if (!isClientProductEvent(name) || !safeProperties) return;
    sendGoogleAnalyticsEvent(
      (window as AnalyticsWindow).gtag,
      name,
      safeProperties,
    );
    const body = JSON.stringify({ event: name, properties: safeProperties });
    if (body.length > 4_096) return;
    if (navigator.sendBeacon) {
      const accepted = navigator.sendBeacon(
        "/api/events",
        new Blob([body], { type: "application/json" }),
      );
      if (accepted) return;
    }
    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Analytics must never interrupt editing, checkout, or export.
  }
}
