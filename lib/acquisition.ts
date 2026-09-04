export const RECOGNITION_CAMPAIGN = "recognition_202609" as const;

export const RECOGNITION_TRAFFIC_SOURCES = [
  "instagram",
  "youtube",
  "google",
  "line",
  "direct",
  "other",
] as const;

export const RECOGNITION_TRAFFIC_MEDIUMS = [
  "organic_social",
  "organic_search",
  "referral",
  "direct",
  "unknown",
] as const;

export const RECOGNITION_CONTENT_IDS = [
  "daily_a",
  "daily_b",
  "talking_a",
  "talking_b",
  "shop_a",
  "shop_b",
  "unknown",
] as const;

export type RecognitionTrafficSource =
  (typeof RECOGNITION_TRAFFIC_SOURCES)[number];
export type RecognitionTrafficMedium =
  (typeof RECOGNITION_TRAFFIC_MEDIUMS)[number];
export type RecognitionContentId =
  (typeof RECOGNITION_CONTENT_IDS)[number];

export type AcquisitionAttribution = {
  traffic_source: RecognitionTrafficSource;
  traffic_medium: RecognitionTrafficMedium;
  traffic_campaign: typeof RECOGNITION_CAMPAIGN | "none" | "unknown";
  traffic_content: RecognitionContentId | "none";
};

const SOURCE_SET = new Set<string>(RECOGNITION_TRAFFIC_SOURCES);
const MEDIUM_SET = new Set<string>(RECOGNITION_TRAFFIC_MEDIUMS);
const CONTENT_SET = new Set<string>(RECOGNITION_CONTENT_IDS);

function boundedValue(value: string | null) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9_]{1,40}$/u.test(normalized) ? normalized : "";
}

export function parseAcquisitionAttribution(
  search: string,
): AcquisitionAttribution | null {
  const parameters = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const source = boundedValue(parameters.get("utm_source"));
  if (!SOURCE_SET.has(source) || source === "direct") return null;

  const medium = boundedValue(parameters.get("utm_medium"));
  const campaign = boundedValue(parameters.get("utm_campaign"));
  const content = boundedValue(parameters.get("utm_content"));

  return {
    traffic_source: source as RecognitionTrafficSource,
    traffic_medium: MEDIUM_SET.has(medium)
      ? (medium as RecognitionTrafficMedium)
      : "unknown",
    traffic_campaign:
      campaign === RECOGNITION_CAMPAIGN
        ? RECOGNITION_CAMPAIGN
        : campaign
          ? "unknown"
          : "none",
    traffic_content: CONTENT_SET.has(content)
      ? (content as RecognitionContentId)
      : content
        ? "unknown"
        : "none",
  };
}

export function directAttribution(): AcquisitionAttribution {
  return {
    traffic_source: "direct",
    traffic_medium: "direct",
    traffic_campaign: "none",
    traffic_content: "none",
  };
}

export function buildRecognitionCampaignUrl({
  path,
  source,
  content,
}: {
  path: string;
  source: "instagram" | "youtube";
  content: Exclude<RecognitionContentId, "unknown">;
}) {
  const url = new URL(path, "https://torudake-reel.pages.dev");
  url.searchParams.set("utm_source", source);
  url.searchParams.set("utm_medium", "organic_social");
  url.searchParams.set("utm_campaign", RECOGNITION_CAMPAIGN);
  url.searchParams.set("utm_content", content);
  return url.toString();
}

export function attributionToSearch(attribution: AcquisitionAttribution) {
  if (attribution.traffic_source === "direct") return "";
  const parameters = new URLSearchParams({
    utm_source: attribution.traffic_source,
    utm_medium: attribution.traffic_medium,
    utm_campaign: attribution.traffic_campaign,
    utm_content: attribution.traffic_content,
  });
  return `?${parameters.toString()}`;
}
