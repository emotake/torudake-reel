import assert from "node:assert/strict";
import test from "node:test";

import {
  CHARACTER_V1_NARRATION_VOICE_PROFILE,
  CLASSIC_NARRATION_VOICE_PROFILE,
  formatNarrationScriptRules,
  narrationVoiceProfileLogValue,
  resolveNarrationVoiceProfile,
} from "../lib/narration-voice-profiles.ts";

test("defaults missing and invalid voice profile flags to the production classic profile", () => {
  for (const value of [
    undefined,
    null,
    "",
    "classic",
    "character-v2",
    " character-v1 ",
    1,
  ]) {
    assert.equal(resolveNarrationVoiceProfile(value).key, "classic");
  }

  assert.equal(
    resolveNarrationVoiceProfile(undefined),
    CLASSIC_NARRATION_VOICE_PROFILE,
  );
  assert.equal(CLASSIC_NARRATION_VOICE_PROFILE.productionReady, true);
  assert.equal(CLASSIC_NARRATION_VOICE_PROFILE.activation, "default");
  assert.deepEqual(
    Object.keys(CLASSIC_NARRATION_VOICE_PROFILE.styles).sort(),
    ["bright", "calm", "comedy", "party"],
  );
});

test("keeps every classic voice, pace, and script persona unchanged", () => {
  const profile = CLASSIC_NARRATION_VOICE_PROFILE;
  assert.equal(profile.version, "2026-08-23-japanese-v5");
  assert.deepEqual(
    ["calm", "bright", "comedy", "party"].map((style) => ({
      realtimeVoice: profile.styles[style].realtimeVoice,
      legacyVoice: profile.styles[style].legacyVoice,
      speed: profile.styles[style].speed,
      naturalCharactersPerSecond:
        profile.styles[style].naturalCharactersPerSecond,
    })),
    [
      {
        realtimeVoice: "cedar",
        legacyVoice: "cedar",
        speed: 0.99,
        naturalCharactersPerSecond: 4.5,
      },
      {
        realtimeVoice: "marin",
        legacyVoice: "marin",
        speed: 1,
        naturalCharactersPerSecond: 4.7,
      },
      {
        realtimeVoice: "cedar",
        legacyVoice: "cedar",
        speed: 1,
        naturalCharactersPerSecond: 4.9,
      },
      {
        realtimeVoice: "marin",
        legacyVoice: "marin",
        speed: 1,
        naturalCharactersPerSecond: 4.9,
      },
    ],
  );
  assert.match(
    formatNarrationScriptRules(profile.styles.comedy),
    /20代のクラブカルチャーや音楽イベント/,
  );
  assert.match(
    formatNarrationScriptRules(profile.styles.party),
    /20代のギャル系ファッションやクラブカルチャー/,
  );
});

test("activates the selected character profile only through its explicit flag", () => {
  const profile = resolveNarrationVoiceProfile("character-v1");
  assert.equal(profile, CHARACTER_V1_NARRATION_VOICE_PROFILE);
  assert.equal(profile.key, "character-v1");
  assert.equal(profile.productionReady, true);
  assert.equal(profile.activation, "explicit-flag");
  assert.equal(
    narrationVoiceProfileLogValue(profile),
    "character-v1@2026-08-23-character-v1-selected",
  );
  assert.equal(profile.styles.party.realtimeVoice, "shimmer");
  assert.equal(profile.styles.party.legacyVoice, "shimmer");
  assert.equal(profile.styles.comedy.realtimeVoice, "verse");
  assert.equal(profile.styles.comedy.legacyVoice, "verse");
  assert.equal(profile.styles.party.speed, 1);
  assert.equal(profile.styles.comedy.speed, 1);

  const characterInstructions = [
    profile.styles.party.speechInstructions,
    profile.styles.party.scriptStyleInstruction,
    ...profile.styles.party.scriptRules,
    profile.styles.comedy.speechInstructions,
    profile.styles.comedy.scriptStyleInstruction,
    ...profile.styles.comedy.scriptRules,
  ].join("\n");
  assert.doesNotMatch(characterInstructions, /20代|クラブ|ギャル/);
  assert.match(characterInstructions, /ポップキャラクター/);
  assert.match(characterInstructions, /大人の日常動画/);
  assert.match(characterInstructions, /幼児・アニメ調/);
  assert.match(characterInstructions, /重要語だけ.*弾み/);
  assert.match(characterInstructions, /ハイテンショントーク/);
  assert.match(characterInstructions, /導入.*素早く/);
  assert.match(characterInstructions, /要点の直前.*一拍/);
  assert.match(characterInstructions, /結論.*明瞭に強調/);
  assert.match(characterInstructions, /常時大げさにせず/);
  assert.match(characterInstructions, /実在人物.*模倣しない/);
});
