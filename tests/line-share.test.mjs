import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLineShareUrl,
  LINE_SHARE_ENDPOINT,
  LINE_SHARE_TEXT,
  LINE_SHARE_URL,
} from "../lib/line-share.ts";

test("builds an official LINE share URL without account credentials", () => {
  const shareUrl = new URL(LINE_SHARE_URL);

  assert.equal(shareUrl.origin + shareUrl.pathname, LINE_SHARE_ENDPOINT);
  assert.equal(shareUrl.searchParams.get("url"), "https://torudake-reel.pages.dev/");
  assert.equal(shareUrl.searchParams.get("text"), LINE_SHARE_TEXT);
  assert.equal(shareUrl.searchParams.has("channel_id"), false);
  assert.equal(shareUrl.searchParams.has("access_token"), false);
});

test("encodes custom LINE share text and URLs safely", () => {
  const result = new URL(
    buildLineShareUrl({
      url: "https://example.test/動画?from=テスト&safe=1",
      text: "あとで試す & LINE",
    }),
  );

  assert.equal(
    result.searchParams.get("url"),
    "https://example.test/動画?from=テスト&safe=1",
  );
  assert.equal(result.searchParams.get("text"), "あとで試す & LINE");
});
