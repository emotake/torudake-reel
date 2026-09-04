"use client";

import {
  directAttribution,
  parseAcquisitionAttribution,
  type AcquisitionAttribution,
} from "./acquisition";

const ATTRIBUTION_STORAGE_KEY = "torudake.acquisition.v1";
const ATTRIBUTION_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1_000;

type StoredAttribution = {
  capturedAt: number;
  attribution: AcquisitionAttribution;
};

function isStoredAttribution(value: unknown): value is StoredAttribution {
  if (!value || typeof value !== "object") return false;
  const stored = value as Partial<StoredAttribution>;
  return (
    Number.isFinite(stored.capturedAt) &&
    Boolean(stored.attribution) &&
    typeof stored.attribution?.traffic_source === "string" &&
    typeof stored.attribution?.traffic_medium === "string" &&
    typeof stored.attribution?.traffic_campaign === "string" &&
    typeof stored.attribution?.traffic_content === "string"
  );
}

export function readStoredAttribution(now = Date.now()) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return null;
    const stored: unknown = JSON.parse(raw);
    if (
      !isStoredAttribution(stored) ||
      now - stored.capturedAt > ATTRIBUTION_MAX_AGE_MS
    ) {
      window.localStorage.removeItem(ATTRIBUTION_STORAGE_KEY);
      return null;
    }
    return stored.attribution;
  } catch {
    return null;
  }
}

export function captureCurrentAttribution(now = Date.now()) {
  if (typeof window === "undefined") return directAttribution();
  const incoming = parseAcquisitionAttribution(window.location.search);
  if (!incoming) return readStoredAttribution(now) ?? directAttribution();
  try {
    window.localStorage.setItem(
      ATTRIBUTION_STORAGE_KEY,
      JSON.stringify({ capturedAt: now, attribution: incoming }),
    );
  } catch {
    // Attribution is optional and must never block the editor.
  }
  return incoming;
}

export function currentAttributionProperties() {
  return captureCurrentAttribution();
}
