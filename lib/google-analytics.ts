export const LEGACY_GA4_MEASUREMENT_ID = "G-CV2ZLFXCCT";

export const MANAGEMENT_GA4_MEASUREMENT_ID = "G-PNXQYMN97S";

export const GA4_MEASUREMENT_IDS = [
  LEGACY_GA4_MEASUREMENT_ID,
  MANAGEMENT_GA4_MEASUREMENT_ID,
] as const;

export const GOOGLE_TAG_SCRIPT_URL =
  `https://www.googletagmanager.com/gtag/js?id=${LEGACY_GA4_MEASUREMENT_ID}`;

export const GOOGLE_TAG_SCRIPT_ID = "torudake-google-tag";

export type GoogleTag = (...args: unknown[]) => void;

export function createGoogleTagCommandQueue(dataLayer: unknown[]): GoogleTag {
  return function gtag() {
    // Google tag requires its command queue entries to be Arguments objects.
    // eslint-disable-next-line prefer-rest-params
    dataLayer.push(arguments);
  };
}

export function sendGoogleAnalyticsEvent(
  gtag: GoogleTag | undefined,
  eventName: string,
  parameters: Readonly<Record<string, unknown>>,
) {
  if (!gtag) return;
  for (const measurementId of GA4_MEASUREMENT_IDS) {
    gtag("event", eventName, {
      ...parameters,
      send_to: measurementId,
    });
  }
}

export function isGoogleAnalyticsExcludedPath(pathname: string) {
  return (
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/internal" ||
    pathname.startsWith("/internal/")
  );
}
