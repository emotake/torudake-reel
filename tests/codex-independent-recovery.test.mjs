import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Codex cancellation handoff keeps recovery outside Codex", async () => {
  const [handoff, disasterRecovery, restoreDrill] = await Promise.all([
    readFile(
      new URL(
        "../docs/operations/codex-independent-recovery.md",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../docs/operations/disaster-recovery.md", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../scripts/operations/restore-drill.ps1", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(handoff, /emotake\/torudake-reel-recovery/);
  assert.match(handoff, /--scope codex-cancellation/);
  assert.match(handoff, /Deploy Production/);
  assert.match(handoff, /GitHub.*Cloudflare.*Stripe.*OpenAI API.*LINE Developers/s);
  assert.doesNotMatch(handoff, /(?:sk|rk)_(?:live|test|proj)_/i);
  assert.doesNotMatch(handoff, /whsec_/i);

  assert.match(disasterRecovery, /Codex is not a recovery source/);
  assert.match(restoreDrill, /\[string\]\$SqliteExecutable = "sqlite3"/);
  assert.match(
    restoreDrill,
    /Test-Path -LiteralPath \$databasePath[\s\S]*Remove-Item -LiteralPath \$databasePath -Force/,
  );
});
