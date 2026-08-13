export const VOICE_SAMPLE_SCRIPTS = {
  calm:
    "朝の公園をゆっくり歩きました。木々の間から光が差し込み、穏やかな時間を楽しめました。",
  bright:
    "海辺のカフェに立ち寄りました。窓から夕日が見えて、焼きたてのパンもとてもおいしかったです。",
  comedy:
    "週末は友だちと夏祭りへ行きました。焼きそばを食べて、音楽を聴いて、最後は大きな花火を楽しみました。",
  party:
    "友だちと夜景を見に行きました。写真もきれいに撮れて、笑顔いっぱいの楽しい一日になりました。",
} as const;

export type VoiceSampleStyle = keyof typeof VOICE_SAMPLE_SCRIPTS;
