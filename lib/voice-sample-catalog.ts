export type VoiceSampleStatus = "ready";
export type VoiceSampleRole = "current";
export type VoiceSampleVersion = "v5" | "v6";

export type VoiceSampleCatalogEntry = {
  id: "calm" | "bright" | "comedy" | "party";
  script: string;
  file: string;
  src: string;
  version: VoiceSampleVersion;
  status: VoiceSampleStatus;
  /** Whether the fixed preview uses the current production instruction profile. */
  productionParity: boolean;
  role: VoiceSampleRole;
  plannedReplacement: null;
};

export const VOICE_SAMPLE_CATALOG = {
  calm: {
    id: "calm",
    script:
      "朝の公園をゆっくり歩きました。木々の間から光が差し込み、穏やかな時間を楽しめました。",
    file: "calm-v5.wav",
    src: "/demo/voices/calm-v5.wav",
    version: "v5",
    status: "ready",
    productionParity: false,
    role: "current",
    plannedReplacement: null,
  },
  bright: {
    id: "bright",
    script:
      "海辺のカフェに立ち寄りました。窓から夕日が見えて、焼きたてのパンもとてもおいしかったです。",
    file: "bright-v5.wav",
    src: "/demo/voices/bright-v5.wav",
    version: "v5",
    status: "ready",
    productionParity: false,
    role: "current",
    plannedReplacement: null,
  },
  comedy: {
    id: "comedy",
    script: "たった10秒で、空気が変わる。見せ場は、ここからです。",
    file: "comedy-v6.wav",
    src: "/demo/voices/comedy-v6.wav",
    version: "v6",
    status: "ready",
    productionParity: false,
    role: "current",
    plannedReplacement: null,
  },
  party: {
    id: "party",
    script: "たった10秒で、空気が変わる。見せ場は、ここからです。",
    file: "party-v6.wav",
    src: "/demo/voices/party-v6.wav",
    version: "v6",
    status: "ready",
    productionParity: false,
    role: "current",
    plannedReplacement: null,
  },
} as const satisfies Record<string, VoiceSampleCatalogEntry>;

export type VoiceSampleStyle = keyof typeof VOICE_SAMPLE_CATALOG;

export const VOICE_SAMPLE_SCRIPTS = {
  calm: VOICE_SAMPLE_CATALOG.calm.script,
  bright: VOICE_SAMPLE_CATALOG.bright.script,
  comedy: VOICE_SAMPLE_CATALOG.comedy.script,
  party: VOICE_SAMPLE_CATALOG.party.script,
} as const satisfies Record<VoiceSampleStyle, string>;
