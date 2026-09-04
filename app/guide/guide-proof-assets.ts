import type { GuideScreenshot } from "./guide-screenshots";

export const EDITOR_SCREENSHOTS: readonly GuideScreenshot[] = [
  {
    src: "/campaign/recognition-202609/editor-step-setup.png",
    alt: "撮るだけリールで投稿先と元音声を選ぶ実際の設定画面",
    title: "投稿先と音声を選ぶ",
    description: "Instagram・YouTube Shorts、元音声・AIナレーションを分けて選びます。",
  },
  {
    src: "/campaign/recognition-202609/editor-step-options.png",
    alt: "動画の長さ、テロップ、自動カット、固有名詞を選ぶ詳細設定画面",
    title: "必要な仕上げだけ決める",
    description: "長さ、テロップ、カット、固有名詞を同じ画面で確認できます。",
  },
  {
    src: "/campaign/recognition-202609/editor-step-preview.png",
    alt: "完成尺、テロップデザイン、投稿文、動画プレビューを確認する仕上がり画面",
    title: "保存前に仕上がりを確認",
    description: "完成尺、投稿文、見た目、動画を見てから保存方法を選びます。",
  },
] as const;

