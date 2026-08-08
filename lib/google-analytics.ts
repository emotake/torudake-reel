export const GA4_MEASUREMENT_ID = "G-CV2ZLFXCCT";

export const GOOGLE_TAG_SCRIPT_URL =
  `https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}`;

export const GOOGLE_TAG_SCRIPT_ID = "torudake-google-tag";

export function isGoogleAnalyticsExcludedPath(pathname: string) {
  return (
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/internal" ||
    pathname.startsWith("/internal/")
  );
}
