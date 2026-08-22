import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("shows deterministic cut reasons and a no-cost posting checklist", async () => {
  const [pageSource, cssSource] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(pageSource, /manuallyChangedCutIds\.has\(line\.id\) \? "manual" : spokenCutMode/);
  assert.match(pageSource, /setManuallyChangedCutIds\(\(current\) =>/);
  assert.match(pageSource, /おまかせ編集の判断/);
  assert.match(pageSource, /各カットの理由を下の区間ごとに表示しています/);
  assert.match(pageSource, /className=\{`captionCutReason \$\{cutReason\.code\}`\}/);
  assert.match(pageSource, /buildPostingReadinessChecklist\(/);
  assert.match(pageSource, /投稿前チェック/);
  assert.match(pageSource, /追加のAI処理なしで確認します/);
  assert.match(cssSource, /\.captionCutReason\s*\{/);
  assert.match(cssSource, /\.postingReadinessPanel\s*\{/);
  assert.match(
    cssSource,
    /\.postingReadinessPanel li strong\s*\{[\s\S]*?font-size:\s*12px;/,
  );
  assert.match(
    cssSource,
    /\.postingReadinessPanel li small\s*\{[\s\S]*?font-size:\s*11px;/,
  );
  assert.match(cssSource, /@media \(max-width: 700px\)[\s\S]*?\.postingReadinessPanel ul\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
});
