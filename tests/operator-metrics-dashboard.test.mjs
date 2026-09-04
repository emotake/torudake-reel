import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/operator/metrics/route.ts", import.meta.url),
  "utf8",
);
const dashboard = await readFile(
  new URL(
    "../app/internal/device-access-7k9m2p/operations/operations-dashboard.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("operator metrics require an enrolled operator and expose aggregates only", () => {
  assert.match(route, /await getOperatorDevice\(request\)/);
  assert.match(route, /if \(!operator\)/);
  assert.match(route, /COUNT\(DISTINCT actor_hash\)/);
  assert.match(route, /Cache-Control", "private, no-store/);
  assert.doesNotMatch(
    route,
    /SELECT[\s\S]{0,80}(?:\bemail\b|\bfile_name\b|\btranscript\b)/i,
  );
  assert.doesNotMatch(route, /SELECT[\s\S]{0,80}\bscript\b/i);
  assert.match(route, /listProviderUsageDaily\(\{ sinceDay, limit: 1_000 \}\)/);
  assert.match(route, /traffic_campaign'\) = 'recognition_202609'/);
  assert.match(route, /acquisitionFunnel/);
});

test("operations dashboard explains small samples and privacy limits", () => {
  assert.match(dashboard, /母数が20端末未満/);
  assert.match(route, /ファイル名、字幕、台本、メールアドレスは記録しません/);
  assert.match(route, /OpenAI使用量は原価確認用の実測値/);
  assert.match(dashboard, /未処理Webhook/);
  assert.match(dashboard, /OpenAI実使用量/);
  assert.match(dashboard, /providerOperationLabel/);
  assert.match(dashboard, /認知施策の流入別ファネル/);
});
