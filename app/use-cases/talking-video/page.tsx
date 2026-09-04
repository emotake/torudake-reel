import type { Metadata } from "next";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import UseCasePage from "../use-case-page";

const title = "会話・解説動画に自動テロップ｜撮るだけリール";
const description = "話して撮った動画の音声を活かし、不要な場面を選び直して自動テロップを付ける使い方を動画で紹介します。";
export const metadata: Metadata = buildPublicPageMetadata({
  title,
  description,
  path: "/use-cases/talking-video",
  image: {
    path: "/campaign/recognition-202609/talking-poster.jpg",
    width: 1080,
    height: 1920,
    alt: "会話・解説動画に自動テロップを付けた完成例",
  },
});

export default function TalkingVideoPage() {
  return <UseCasePage content={{
    slug: "talking-video",
    eyebrow: "会話・解説動画",
    title: "話した内容はそのまま。見やすさだけ整える。",
    lead: description,
    pain: "字幕起こしと無言部分の調整だけで、投稿前に時間がなくなる。",
    outcome: "文字を直し、使わない発話を外し、元の音声を活かして仕上げる。",
    steps: ["話している動画を選んで文字起こし", "テロップの文字と使う発話を確認", "映像をつなぎ直すか、そのまま残すか選ぶ"],
    video: "/campaign/recognition-202609/talking-a.mp4",
    poster: "/campaign/recognition-202609/talking-poster.jpg",
    videoName: "会話・解説動画の自動テロップ実演",
    videoDescription: "元音声を活かしながら、テロップと編集方法を選ぶ流れの試作実演です。",
    ctaHref: "/video-edit",
    ctaLabel: "自動テロップを無料で試す",
    fit: [
      "解説、レビュー、会話など、話し声の入った動画を投稿したい",
      "字幕起こしや無言部分の確認に時間を取られている",
      "自動処理のあとに文字や使う発話を自分で確認したい",
    ],
    choices: [
      {
        title: "認識した文字を投稿前に修正",
        body: "音声から作ったテロップは入力欄で直せます。漢字や固有名詞の誤認識があっても、そのまま書き出す必要はありません。",
        href: "/guide/automatic-video-captions",
        linkLabel: "自動テロップの修正手順",
      },
      {
        title: "使わない発話と映像の扱いを別々に選択",
        body: "不要なテロップを表示しない設定に加え、その発話中の映像を残すかカットするかも選べます。内容を削りすぎない仕上げが可能です。",
      },
      {
        title: "映像をつなぎ直すか、元の流れを保つか",
        body: "声に合わせて映像を整える方法と、カットせず元動画を保つ方法を選べます。ナレーションや字幕だけを加えたい場合も対応できます。",
      },
    ],
    faqs: [
      {
        question: "テロップの漢字が違う場合は直せますか？",
        answer: "直せます。画面に表示する文字を編集し、AI音声を使う場合は表示文字と読み方を分けて指定できます。",
      },
      {
        question: "テロップなしでも保存できますか？",
        answer: "できます。元音声を活かす仕上げでも、テロップを付けるかどうかは投稿内容に合わせて選べます。",
      },
      {
        question: "自動カットで短くなるのを避けられますか？",
        answer: "避けられます。映像をつなぎ直さず、元動画の流れを保つ設定でプレビューと書き出しを行えます。",
      },
    ],
  }} />;
}
