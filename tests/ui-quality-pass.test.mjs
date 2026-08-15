import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  pageSource,
  landingSource,
  cssSource,
  photoReelSource,
  videoMixSource,
  voiceCatalogSource,
] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/landing-router.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(
    new URL("../app/photo-reel/photo-reel-client.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../app/video-mix/video-mix-client.tsx", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../lib/voice-sample-catalog.ts", import.meta.url), "utf8"),
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
  assert.match(setupSource, /会話・解説がある動画におすすめ/);
  assert.match(setupSource, /元の声をAI音声へ置き換えたいとき/);
  assert.match(setupSource, /recommendedPresetTitle/);
  assert.match(setupSource, /`\$\{length\}秒以内/);
  assert.match(setupSource, /spokenCutMode === "manual"/);
});

test("loads the sample as a real File and keeps the caption-synchronised demo fallback", () => {
  assert.match(pageSource, /fullDemoRequested[\s\S]*?\/demo\/torudake-demo\.mp4[\s\S]*?\/demo\/torudake-demo-lite\.mp4/);
  assert.match(pageSource, /muted=\{!fullDemoRequested\}/);
  assert.match(pageSource, /poster="\/demo\/torudake-demo-poster\.jpg"/);
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

test("presents four readable, no-cost AI voice examples for distinct use cases", async () => {
  assert.match(pageSource, /import \{ VOICE_SAMPLE_SCRIPTS \} from "\.\.\/lib\/voice-sample-catalog"/);
  assert.match(voiceCatalogSource, /朝の公園をゆっくり歩きました/);
  assert.match(voiceCatalogSource, /海辺のカフェに立ち寄りました/);
  assert.match(voiceCatalogSource, /週末は友だちと夏祭りへ行きました/);
  assert.doesNotMatch(voiceCatalogSource, /ナイトマーケット/);
  assert.match(voiceCatalogSource, /笑顔いっぱいの楽しい一日になりました/);
  assert.match(pageSource, /用途別の例文で、4つの話し方を聴き比べられます/);
  assert.match(
    pageSource,
    /src=\{`\/demo\/voices\/\$\{style\.id\}-v5\.wav`\}/,
  );
  assert.match(pageSource, /aria-describedby=\{exampleId\}/);
  assert.match(pageSource, /trackClientEvent\("voice_sample_played"/);
  assert.doesNotMatch(pageSource, /同じ短い文章を4つの声で/);
  assert.doesNotMatch(pageSource, /用途別の例文で、4つの声を/);
  assert.match(
    cssSource,
    /\.voiceSampleTypes \.voiceSampleExample\s*\{[\s\S]*?font-size:\s*13px;[\s\S]*?line-height:\s*1\.65/,
  );
  assert.match(cssSource, /\.voiceSampleExample q\s*\{[\s\S]*?quotes:\s*"「" "」"/);
  const voiceManifestUrl = new URL(
    "../public/demo/voices/manifest-v5.json",
    import.meta.url,
  );
  const voiceManifest = JSON.parse(await readFile(voiceManifestUrl, "utf8"));
  const expectedSamples = {
    calm: {
      voice: "cedar",
      speed: 0.99,
      script:
        "朝の公園をゆっくり歩きました。木々の間から光が差し込み、穏やかな時間を楽しめました。",
    },
    bright: {
      voice: "marin",
      speed: 1,
      script:
        "海辺のカフェに立ち寄りました。窓から夕日が見えて、焼きたてのパンもとてもおいしかったです。",
    },
    comedy: {
      voice: "cedar",
      speed: 1,
      script:
        "週末は友だちと夏祭りへ行きました。焼きそばを食べて、音楽を聴いて、最後は大きな花火を楽しみました。",
    },
    party: {
      voice: "marin",
      speed: 1,
      script:
        "友だちと夜景を見に行きました。写真もきれいに撮れて、笑顔いっぱいの楽しい一日になりました。",
    },
  };
  assert.equal(voiceManifest.samples.length, 4);
  assert.equal(voiceManifest.sampleModel, "gpt-realtime-2.1-mini");
  assert.equal(voiceManifest.productionModel, "gpt-realtime-2.1-mini");
  assert.equal(voiceManifest.productionParity, true);
  assert.match(voiceManifest.parityScope, /Same model, voice, speed/);
  assert.doesNotMatch(pageSource, /固定見本は試聴用モデル/);
  assert.doesNotMatch(pageSource, /実際の動画では本番モデル/);
  for (const sample of voiceManifest.samples) {
    const expected = expectedSamples[sample.id];
    assert.ok(expected);
    assert.equal(sample.model, voiceManifest.productionModel);
    assert.equal(sample.voice, expected.voice);
    assert.equal(sample.speed, expected.speed);
    assert.equal(sample.script, expected.script);
    assert.match(sample.profile, new RegExp(`:${sample.id}:gpt-realtime-2\\.1-mini:${expected.voice}:`));
    const audio = await readFile(
      new URL(`../public/demo/voices/${sample.file}`, import.meta.url),
    );
    assert.equal(audio.byteLength, sample.bytes);
    assert.equal(createHash("sha256").update(audio).digest("hex"), sample.sha256);
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
    assert.equal(audio.toString("ascii", 8, 12), "WAVE");
    assert.equal(audio.readUInt16LE(20), 1);
    assert.equal(audio.readUInt16LE(22), 1);
    assert.equal(audio.readUInt32LE(24), 24_000);
    assert.equal(audio.readUInt16LE(34), 16);
    assert.ok(sample.durationSeconds >= 6 && sample.durationSeconds <= 9);
    assert.ok(sample.integratedLufs >= -21 && sample.integratedLufs <= -20);
    assert.ok(sample.truePeakDbtp <= -3);
    assert.equal(sample.postRollSeconds, 0.35);
    assert.equal(sample.transcriptionMatch, "exact_after_orthography_normalization");
  }
});

test("labels the permanent hero value instead of presenting it as news", () => {
  assert.match(
    landingSource,
    /<span>かんたん動画編集<\/span>\s*素材を選ぶだけで、投稿できる動画へ/,
  );
  assert.match(landingSource, /動画や写真を、/);
  assert.match(landingSource, /<em>リールに。<\/em>/);
  assert.match(landingSource, /必要な機能だけを選んで仕上げられます。/);
  assert.doesNotMatch(landingSource, /<span>AI自動編集<\/span>/);
  assert.doesNotMatch(landingSource, /<span>新着<\/span>/);
  assert.doesNotMatch(landingSource, /素材を選んで、|作り方をひとつ選ぶだけ。/);
});

test("describes the finish sample without an ambiguous start-work claim", () => {
  assert.match(landingSource, /実際の仕上がり/);
  assert.match(landingSource, /サンプル動画で、仕上がりを確認できます。/);
  assert.match(landingSource, /映像・音声・テロップをまとめて確認できます。登録は必要ありません。/);
  assert.doesNotMatch(landingSource, /先に見てから、作り始められます。/);
});

test("explains media processing without hiding full-video AI uploads", () => {
  assert.match(landingSource, /カットや書き出しは、お使いのスマホ・タブレット・パソコンで行います/);
  assert.match(landingSource, /写真と選んだ音源を外部のAIサービスへ送信しません/);
  assert.match(landingSource, /動画ファイル、または動画から取り出した音声・静止画を外部サービスへ送信/);
  assert.doesNotMatch(landingSource, /必要な音声・静止画だけを安全に送信/);
  assert.match(pageSource, /動画ファイル、または動画から取り出した音声・静止画を外部サービスへ送信/);
});

test("keeps first-screen trial and purchase claims precise", () => {
  assert.match(pageSource, /無料体験：合計3分以内・最大2動画まで/);
  assert.match(pageSource, /AI処理は1動画につき3回/);
  assert.match(pageSource, /プラン購入時に決済・書き出し成功時に1本分を使用/);
  assert.doesNotMatch(pageSource, /完成動画を保存するまでは料金がかかりません/);

  assert.match(photoReelSource, /className="photoReelHeroCta"/);
  assert.match(photoReelSource, /無料体験はサービス共通で合計3分以内・最大2動画まで/);
  assert.match(photoReelSource, /購入手続き完了時に決済されます/);
  assert.ok(
    photoReelSource.indexOf('className="photoReelHeroCta"') <
      photoReelSource.indexOf('className="photoReelWorkspace"'),
  );

  assert.match(videoMixSource, /className="videoMixHeroCta"/);
  assert.match(videoMixSource, /プラン購入時に決済・書き出し成功時に完成動画1本分の利用枠を使用/);
  assert.ok(
    videoMixSource.indexOf('className="videoMixHeroCta"') <
      videoMixSource.indexOf('className="videoMixWorkspace"'),
  );
});

test("keeps mobile navigation and first-screen actions accessible", () => {
  assert.equal((videoMixSource.match(/aria-current=\{mobileStep === [123] \? "step" : undefined\}/g) ?? []).length, 3);
  assert.match(
    cssSource,
    /@media \(max-width: 420px\)[\s\S]*?\.topActions \.trialButton\s*\{[\s\S]*?display:\s*inline-flex/,
  );
  assert.doesNotMatch(
    cssSource,
    /@media \(max-width: 420px\)[\s\S]*?\.topActions \.trialButton\s*\{[^}]*display:\s*none/,
  );
  assert.match(cssSource, /\.lineSaveMark\s*\{[^}]*color:\s*#062d19/);
  assert.match(cssSource, /\.lineSaveCard > a\s*\{[^}]*color:\s*#062d19/);
  assert.match(cssSource, /\.trustRow\s*\{[^}]*color:\s*var\(--muted\)/);
});

test("uses declared font stacks and Japanese-first decorative labels", () => {
  assert.match(cssSource, /--font-display:\s*"Avenir Next", var\(--font-sans\)/);
  assert.match(cssSource, /--font-serif:/);
  assert.doesNotMatch(cssSource, /font-family:\s*"DM Sans"/);
  assert.doesNotMatch(cssSource, /font-family:\s*"Noto Sans JP"/);

  for (const label of [
    "AI音声を試聴",
    "かんたん3ステップ",
    "このサービスでできること",
    "料金プラン",
    "次の投稿を作る",
    "新しい動画",
    "AIで編集中",
    "AI音声の調整",
    "テロップ編集",
    "表紙を作る",
    "投稿の準備",
    "保存前の確認",
  ]) {
    assert.match(pageSource, new RegExp(label));
  }
  assert.match(photoReelSource, /写真からリールへ · 端末内編集/);
  assert.match(videoMixSource, /<span>複数動画編集<\/span>/);
});

test("keeps mobile account access and accessible touch targets visible", () => {
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*?\.accountButton\s*\{[\s\S]*?display:\s*inline-flex/);
  assert.match(cssSource, /\.siteShell :is\(button, select, textarea, summary, \[role="button"\]\),[\s\S]*?min-height:\s*44px/);
  assert.match(cssSource, /\.siteFooterBrandLink small\s*\{[^}]*font-size:\s*12px/);
  assert.match(cssSource, /\.accentChoices > button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(cssSource, /\.brand\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(cssSource, /\.trialButton,[\s\S]*?\.transferButton\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(cssSource, /\.topbar nav a\s*\{[^}]*min-width:\s*44px/);
  assert.match(
    cssSource,
    /\.siteFooterGroup a\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px[^}]*font-size:\s*14px/,
  );
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

test("guides voiced videos toward original audio while keeping AI replacement available", () => {
  assert.match(pageSource, /元の音声を活かす/);
  assert.match(pageSource, /AIナレーションにする/);
  assert.match(pageSource, /会話・解説がある動画におすすめ/);
  assert.match(pageSource, /話し声のない動画、または元の声をAI音声へ置き換えたいとき/);
  assert.match(pageSource, /setAudioMode\("narration"\);[\s\S]*?setNarrationOriginalAudio\(0\)/);
  assert.match(pageSource, /元動画に話し声がある場合は0%がおすすめ/);
  assert.match(pageSource, /narrationOriginalAudio === 0/);
  assert.match(pageSource, /話し声を重ねたくない場合は0%にしてください/);
  assert.doesNotMatch(pageSource, /narrationSpeechFreeConfirmed/);
  assert.doesNotMatch(pageSource, /話し声がある場合、AIナレーションは使用しません/);
  assert.doesNotMatch(pageSource, /話し声が見つからなかった動画だけで利用できます/);
  assert.doesNotMatch(pageSource, /会話ありにおすすめ/);
  assert.doesNotMatch(pageSource, /元の声を控えめに残す/);
  assert.doesNotMatch(pageSource, /元の音声の有無を問わず/);
  assert.doesNotMatch(pageSource, /会話や周りの音が入った動画にも使えます/);
});

test("defaults voiced videos to no burned-in telops while keeping them optional", () => {
  assert.match(
    pageSource,
    /const \[spokenCaptionsEnabled, setSpokenCaptionsEnabled\] = useState\(false\)/,
  );
  assert.match(
    pageSource,
    /setAudioMode\("spoken"\);\s*setSpokenCaptionsEnabled\(true\);/,
  );
  assert.match(
    pageSource,
    /setAudioMode\("spoken"\);\s*setSpokenCaptionsEnabled\(false\);\s*setSpokenCutMode\("auto"\)/,
  );
  assert.match(pageSource, /テロップを付けない[\s\S]*?元の話し声をそのまま聞かせる[\s\S]*?<b>おすすめ<\/b>/);
  assert.match(pageSource, /自動テロップを付ける/);
  assert.match(pageSource, /テロップは必要なときだけ追加/);
  assert.match(pageSource, /必要に応じたテロップ/);
  assert.match(
    pageSource,
    /const \[narrationCaptionsEnabled, setNarrationCaptionsEnabled\] =\s*useState\(true\)/,
  );
});

test("describes post copy only where AI narration provides it", () => {
  assert.match(pageSource, /AIナレーションモードなら投稿文も作れます/);
  assert.match(pageSource, /AIナレーションなら投稿文も作成/);
  assert.doesNotMatch(pageSource, /自動カット、自動テロップ、AIナレーション、表紙、投稿文まで/);
});

test("shows photo-reel preview and save pricing before editing", () => {
  assert.match(photoReelSource, /photoReelIntroOffer/);
  assert.match(photoReelSource, /仕上がりプレビューは無料/);
  assert.match(photoReelSource, /ONE_TIME_PLAN_LABEL\}は1回の購入で動画1本まで/);
  assert.match(photoReelSource, /STARTER_MONTHLY_VIDEO_LIMIT/);
  assert.match(photoReelSource, /STANDARD_MONTHLY_VIDEO_LIMIT/);
  assert.match(photoReelSource, /checkout=starter/);
  assert.match(photoReelSource, /checkout=standard/);
  assert.doesNotMatch(photoReelSource, /checkout=light/);
  assert.match(cssSource, /\.photoReelPurchaseOptions > div\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3/);
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*?\.photoReelPurchaseOptions > div\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(cssSource, /\.accountPlans\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3/);
  assert.ok(
    photoReelSource.indexOf('checkout=one_time') <
      photoReelSource.indexOf('checkout=starter'),
  );
  assert.match(photoReelSource, /function moveRadioSelection/);
  assert.match(photoReelSource, /event\.key === "ArrowRight"/);
  assert.match(photoReelSource, /event\.key === "Home"/);
  assert.match(photoReelSource, /tabIndex=\{duration === seconds \? 0 : -1\}/);
  assert.match(photoReelSource, /tabIndex=\{templateId === option\.id \? 0 : -1\}/);
});

test("publishes an explicit landing entry for the five-video editor", () => {
  assert.match(pageSource, /href="\/video-mix"/);
  assert.match(pageSource, /動画をつないで作る/);
  assert.match(pageSource, /最大5本・素材の順番を保って1本に合成/);
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

test("restores paid export access safely after returning from checkout", () => {
  assert.match(pageSource, /payload\.aiOperationsRemaining/);
  assert.match(pageSource, /rememberReservationAiQuota\(reservation\)/);
  assert.match(pageSource, /paidAccessCheckRef\.current/);
  assert.match(pageSource, /window\.addEventListener\("focus", recheckAfterCheckout\)/);
  assert.match(
    pageSource,
    /document\.addEventListener\("visibilitychange", recheckAfterCheckout\)/,
  );
  assert.match(pageSource, /onClick=\{markCheckoutStarted\}/);
  assert.match(pageSource, /保存を有効にする（再確認）/);
  assert.match(pageSource, /動画の書き出しを再開できます/);
  assert.doesNotMatch(
    pageSource,
    /checkPaidExportAccess\([^)]*\)\.then\([^)]*requestVideoExport/,
  );

  assert.match(photoReelSource, /fetch\("\/api\/billing\/status"/);
  assert.match(photoReelSource, /purchaseCheckRef\.current/);
  assert.match(
    photoReelSource,
    /window\.addEventListener\("focus", recheckAfterCheckout\)/,
  );
  assert.match(photoReelSource, /上の「写真リールを書き出す」を押す/);
  assert.doesNotMatch(
    photoReelSource,
    /checkPurchaseAfterReturn\([^)]*\)\.then\([^)]*startExport/,
  );
});

test("keeps setup choices accessible and labels the actual video shape", () => {
  assert.match(pageSource, /aria-pressed=\{goal === item\.id\}/);
  assert.match(pageSource, /aria-pressed=\{length === item\}/);
  assert.match(pageSource, /aria-pressed=\{spokenCaptionsEnabled\}/);
  assert.match(pageSource, /aria-pressed=\{narrationCaptionsEnabled\}/);
  assert.match(pageSource, /onLoadedMetadata=\{\(event\) =>/);
  assert.match(pageSource, /ratio > 1\.08[\s\S]*?"横動画"/);
  assert.match(pageSource, /ratio < 0\.92[\s\S]*?"縦動画"/);
  assert.match(pageSource, /"正方形動画"/);
  assert.match(pageSource, /5分までの縦・横・正方形動画/);
  assert.doesNotMatch(pageSource, /MB`}・縦動画/);
});

test("keeps the built-in sample free of narration API use", () => {
  assert.match(
    pageSource,
    /if \(options\.demo\) \{\s*setAudioMode\("spoken"\);\s*setSpokenCaptionsEnabled\(true\);/,
  );
  assert.match(
    pageSource,
    /aria-describedby=\{isDemoSample \? "sampleNarrationNotice" : undefined\}/,
  );
  assert.match(pageSource, /disabled=\{isDemoSample\}/);
  assert.match(pageSource, /if \(isDemoSample\) \{[\s\S]*?API利用や無料体験の回数を消費せず/);
});

test("explains that completed AI work is not restored when an edit is discarded", () => {
  assert.match(pageSource, /正常に完了したAI処理の回数は、この編集を保存せず終了した場合も戻りません/);
});

test("removes the unreachable transfer UI while keeping export work serialized", () => {
  assert.doesNotMatch(pageSource, /type Stage = [^;]*transfer/);
  assert.doesNotMatch(pageSource, /function TransferPortal/);
  assert.doesNotMatch(pageSource, /function uploadVideoInChunks/);
  assert.match(
    pageSource,
    /const isMediaBusy =[\s\S]*?isAnalyzingThumbnailFrames/,
  );
  assert.match(pageSource, /addCutBoundaryFades\(/);
  assert.match(pageSource, /PORTABLE_AUDIO_CUT_FADE_SECONDS/);
});

test("warns early about long iPhone exports and snaps narration captions locally", () => {
  assert.match(pageSource, /selectedVideoDuration > 120 && keepsOriginalVideo/);
  assert.match(pageSource, /iPhone・iPadでは120秒を超えるノーカット動画/);
  assert.match(pageSource, /snapNarrationTimelineToAudioSilence/);
  assert.match(pageSource, /resolveNarrationAudioBoundaries/);
  assert.match(pageSource, /buildNarrationAudioSpans/);
});
