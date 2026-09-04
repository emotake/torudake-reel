import assert from "node:assert/strict";
import test from "node:test";

import {
  RECOGNITION_CAMPAIGN,
  attributionToSearch,
  buildRecognitionCampaignUrl,
  directAttribution,
  parseAcquisitionAttribution,
} from "../lib/acquisition.ts";
import { getPublicSocialLinks } from "../lib/site-socials.ts";

test("parses only the bounded recognition campaign vocabulary", () => {
  assert.deepEqual(
    parseAcquisitionAttribution(
      "?utm_source=instagram&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=daily_a",
    ),
    {
      traffic_source: "instagram",
      traffic_medium: "organic_social",
      traffic_campaign: RECOGNITION_CAMPAIGN,
      traffic_content: "daily_a",
    },
  );
  assert.equal(parseAcquisitionAttribution("?utm_source=private-name"), null);
  assert.deepEqual(
    parseAcquisitionAttribution(
      "?utm_source=youtube&utm_medium=unexpected&utm_campaign=private&utm_content=private",
    ),
    {
      traffic_source: "youtube",
      traffic_medium: "unknown",
      traffic_campaign: "unknown",
      traffic_content: "unknown",
    },
  );
});

test("builds consistent Instagram and YouTube campaign URLs", () => {
  const url = new URL(buildRecognitionCampaignUrl({
    path: "/use-cases/talking-video",
    source: "youtube",
    content: "talking_b",
  }));
  assert.equal(url.origin, "https://torudake-reel.pages.dev");
  assert.equal(url.searchParams.get("utm_source"), "youtube");
  assert.equal(url.searchParams.get("utm_medium"), "organic_social");
  assert.equal(url.searchParams.get("utm_campaign"), RECOGNITION_CAMPAIGN);
  assert.equal(url.searchParams.get("utm_content"), "talking_b");
  assert.equal(attributionToSearch(directAttribution()), "");
});

test("accepts only canonical official social profile URLs", () => {
  assert.deepEqual(
    getPublicSocialLinks({
      NEXT_PUBLIC_INSTAGRAM_URL: "https://www.instagram.com/torudake.reel/?utm_source=test",
      NEXT_PUBLIC_YOUTUBE_URL: "https://www.youtube.com/@torudake-reel#videos",
    }),
    [
      { id: "instagram", label: "Instagram", href: "https://www.instagram.com/torudake.reel/" },
      { id: "youtube", label: "YouTube", href: "https://www.youtube.com/@torudake-reel" },
    ],
  );
  assert.deepEqual(
    getPublicSocialLinks({
      NEXT_PUBLIC_INSTAGRAM_URL: "https://example.com/fake",
      NEXT_PUBLIC_YOUTUBE_URL: "javascript:alert(1)",
    }),
    [],
  );
});
