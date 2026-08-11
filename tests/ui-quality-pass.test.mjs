import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, cssSource, photoReelSource] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(
    new URL("../app/photo-reel/photo-reel-client.tsx", import.meta.url),
    "utf8",
  ),
]);

test("keeps the recommended setup short and moves free caption styling to results", () => {
  const setupStart = pageSource.indexOf("function SetupWorkspace");
  const setupEnd = pageSource.indexOf("function Processing", setupStart);
  const setupSource = pageSource.slice(setupStart, setupEnd);
  const resultStart = pageSource.indexOf("function ResultWorkspace");
  const resultSource = pageSource.slice(resultStart);

  assert.match(setupSource, /おすすめで作る/);
  assert.match(setupSource, /<details className="advancedSettings">/);
  assert.match(setupSource, /細かく設定/);
  assert.doesNotMatch(setupSource, /<CaptionStylePicker/);
  assert.match(resultSource, /<CaptionStylePicker/);
  assert.match(setupSource, /仕上がりプレビューを見ながら何度でも変更/);
  assert.match(setupSource, /aria-pressed=\{audioMode === "spoken"\}/);
  assert.match(setupSource, /aria-pressed=\{audioMode === "narration"\}/);
  assert.match(setupSource, /recommendedPresetTitle/);
  assert.match(setupSource, /`\$\{length\}秒以内/);
  assert.match(setupSource, /spokenCutMode === "manual"/);
});

test("loads the sample as a real File and keeps the caption-synchronised demo fallback", () => {
  assert.match(pageSource, /src="\/demo\/torudake-demo\.mp4"/);
  assert.match(pageSource, /fetch\("\/demo\/torudake-demo\.mp4"/);
  assert.match(pageSource, /new File\(\[blob\], "torudake-demo\.mp4"/);
  assert.match(pageSource, /chooseFile\(sampleFile, \{ demo: true \}\)/);
  assert.match(pageSource, /isDemoSample[\s\S]*?DEMO_CAPTIONS\.map/);
  assert.match(pageSource, /サンプルを読込中/);
  assert.match(pageSource, /通信を確認して、もう一度お試しください/);
  assert.match(pageSource, /onTimeUpdate=/);
  assert.match(pageSource, /DEMO_CAPTIONS\.find/);
  assert.match(pageSource, /videoUnavailable/);
  assert.match(pageSource, /デモ動画を準備しています/);
});

test("keeps mobile account access and accessible touch targets visible", () => {
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*?\.accountButton\s*\{[\s\S]*?display:\s*inline-flex/);
  assert.match(cssSource, /\.siteShell :is\(button, select, textarea, summary, \[role="button"\]\),[\s\S]*?min-height:\s*44px/);
  assert.match(cssSource, /\.siteShell \.brandText small,[\s\S]*?\.siteShell footer :is\(span, a, small\),[\s\S]*?font-size:\s*12px/);
  assert.match(cssSource, /\.accentChoices > button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(cssSource, /\.brand\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(cssSource, /\.trialButton,[\s\S]*?\.transferButton\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(cssSource, /\.topbar nav a,[\s\S]*?\.footerLinks a\s*\{[\s\S]*?min-width:\s*44px/);
  assert.match(cssSource, /\.visuallyHidden\[type="file"\]\s*\{[\s\S]*?display:\s*none/);
  assert.match(
    cssSource,
    /\.accountBrand,[\s\S]*?\.accountSignOut,[\s\S]*?\.accountRecoveryHelp a,[\s\S]*?\.accountLegalLinks a,[\s\S]*?\.legalBack,[\s\S]*?\.legalPage article a,[\s\S]*?min-height:\s*44px/,
  );
  assert.match(
    cssSource,
    /\.workspace :is\(p, li, label\),[\s\S]*?\.legalPage :is\(p, li, dt, dd\)\s*\{[\s\S]*?font-size:\s*14px/,
  );
  assert.match(
    cssSource,
    /\.workspace small,[\s\S]*?\.operatorAccessPage small\s*\{[\s\S]*?font-size:\s*12px/,
  );
  assert.match(
    cssSource,
    /\.modalClose\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/,
  );
  assert.match(
    cssSource,
    /\.photoReelTopbar nav a\s*\{[\s\S]*?min-height:\s*44px/,
  );
  assert.match(
    cssSource,
    /\.photoReelShell \.photoReelIntro > p,[\s\S]*?\.photoReelShell \.photoReelHow article > p\s*\{[\s\S]*?font-size:\s*14px/,
  );
  assert.match(
    cssSource,
    /\.photoReelShell \.photoReelTrust > span,[\s\S]*?\.photoReelShell \.photoReelExportCard > div:first-child small,[\s\S]*?\.photoReelShell \.photoReelExportCard li\s*\{[\s\S]*?font-size:\s*12px/,
  );
  assert.match(cssSource, /\.accountHeaderActions\s*\{[\s\S]*?display:\s*flex/);
  assert.doesNotMatch(cssSource, /font-size:\s*max\(12px, 1em\)/);
  assert.match(cssSource, /@media \(max-width: 620px\)[\s\S]*?\.mobilePriceLink\s*\{[\s\S]*?display:\s*none/);
});

test("offers useful silent-video paths instead of ending with an empty transcript", () => {
  assert.match(pageSource, /nextTranscript\.length === 0/);
  assert.match(pageSource, /completedChunks > 0[\s\S]*?segments: \[\]/);
  assert.match(pageSource, /isSilentMediaError\(error\)/);
  assert.match(pageSource, /AIナレーションを付ける/);
  assert.match(pageSource, /音声なしのまま仕上げる/);
  assert.match(pageSource, /setSpokenCutMode\("none"\)/);
  assert.match(pageSource, /setSpokenCaptionsEnabled\(false\)/);
});

test("describes post copy only where AI narration provides it", () => {
  assert.match(pageSource, /AIナレーションモードなら投稿文も作れます/);
  assert.match(pageSource, /AIナレーションなら投稿文も作成/);
  assert.doesNotMatch(pageSource, /自動カット、自動テロップ、AIナレーション、表紙、投稿文まで/);
});

test("shows photo-reel preview and save pricing before editing", () => {
  assert.match(photoReelSource, /photoReelIntroOffer/);
  assert.match(photoReelSource, /仕上がりプレビューは無料/);
  assert.match(photoReelSource, /保存は1動画/);
  assert.match(photoReelSource, /STARTER_MONTHLY_VIDEO_LIMIT/);
  assert.match(photoReelSource, /STANDARD_MONTHLY_VIDEO_LIMIT/);
  assert.match(photoReelSource, /checkout=starter/);
  assert.match(photoReelSource, /checkout=standard/);
  assert.doesNotMatch(photoReelSource, /checkout=light/);
  assert.match(cssSource, /\.photoReelPurchaseOptions > div\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3/);
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*?\.photoReelPurchaseOptions > div\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(cssSource, /\.accountPlans\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3/);
  assert.ok(
    photoReelSource.indexOf('checkout=standard') <
      photoReelSource.indexOf('checkout=starter'),
  );
  assert.match(photoReelSource, /function moveRadioSelection/);
  assert.match(photoReelSource, /event\.key === "ArrowRight"/);
  assert.match(photoReelSource, /event\.key === "Home"/);
  assert.match(photoReelSource, /tabIndex=\{duration === seconds \? 0 : -1\}/);
  assert.match(photoReelSource, /tabIndex=\{templateId === option\.id \? 0 : -1\}/);
});

test("wires local visual scoring into narration and cover selection", () => {
  assert.match(pageSource, /createRepresentativeFrameSampleTimes\(duration\)/);
  assert.match(pageSource, /selectRepresentativeVideoFrames\(candidates/);
  assert.match(pageSource, /analyzeThumbnailFrameChoices\(videoUrl/);
  assert.match(pageSource, /selectThumbnailFrames\(candidates/);
  assert.match(pageSource, /src=\{choice\.previewDataUrl\}/);
  assert.match(pageSource, /seekVideoBeforePlayback\(video, coverFrame\.time\)/);
  assert.match(pageSource, /const analyzedCrop = coverFrame\.crop/);
  assert.match(pageSource, /FaceDetectorConstructor/);
  assert.match(pageSource, /calculateFaceFocusedCoverCrop/);
  assert.match(pageSource, /この端末では顔検出に対応していないため/);
  assert.doesNotMatch(pageSource, /selectThumbnailCandidates\(keptLines\)/);
});

test("keeps cover creation available without captions", () => {
  assert.match(
    pageSource,
    /captionProfile\.brandName\.trim\(\) \|\|[\s\S]*?"今日のハイライト"/,
  );
  assert.doesNotMatch(pageSource, /表紙に使う字幕を1つ以上残してください/);
  assert.match(pageSource, /!selectedThumbnailFrame/);
  assert.match(pageSource, /表紙のタイトル/);
});

test("rejects videos over five minutes before spending an API action", () => {
  assert.match(pageSource, /await getVideoDurationSeconds\(selected\)/);
  assert.match(pageSource, /validateVideoInputDuration/);
  assert.match(pageSource, /notify\(durationResult\.message\)/);
});
