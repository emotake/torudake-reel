# 撮るだけリール

動画や写真を選ぶだけで、Instagram ReelsやYouTube Shortsへ投稿できる縦動画に仕上げるブラウザ編集サービスです。

[公開サイト](https://torudake-reel.pages.dev/) · [1本の動画から作る](https://torudake-reel.pages.dev/video-edit) · [複数動画から作る](https://torudake-reel.pages.dev/video-mix) · [写真から作る](https://torudake-reel.pages.dev/photo-reel)

![撮るだけリール](public/og.png)

## このプロダクトについて

撮影はできても、カット、字幕、ナレーション、表紙、投稿文まで整える負担が大きく、投稿を諦めてしまう人のためのサービスです。専門的なタイムライン操作を前提にせず、素材と仕上げ方を選ぶだけで投稿直前まで進められる体験を目指しています。

Instagram ReelsだけでなくYouTube Shortsにも対応し、同じ編集結果から投稿先に合う文章を用意できます。

## 主な機能

- 1本の動画、2〜5本の動画、2〜10枚の写真から縦動画を作成
- 元の音声を活かす編集とAIナレーション編集を選択
- テロップの表示有無、文章、雰囲気、色を調整
- 自動カット、手動カット、カットしない仕上げを選択
- 動画内の実フレームから9:16の表紙を作成
- Instagram投稿文とYouTube Shorts用タイトル・説明文を作成
- SRT・VTT字幕とテロップ文章を保存
- スマートフォンで扱いやすい動画形式へ書き出し

## 仕上げ方

### 元の音声を活かす

音声認識した内容からテロップを作り、不要な発話区間のカットや字幕修正を行えます。映像を音声に合わせてつなぎ直すか、元動画の流れを保つかも利用者が選べます。

### AIナレーション

台本、読み方、声、元動画の音量を調整してナレーション付き動画を作れます。公開中の声は「自然な男性」「自然な女性」「ハイテンショントーク」の3種類です。表示する漢字を変えずに読み方だけを修正でき、カットやテロップも個別に有効・無効を選べます。

### テロップ

枠付きの「ナチュラル」「インパクト」と、文字のみの「クリア」「ポップ」「Vlogシンプル」「シネマ」を用意しています。仕上がりを比較してから書き出せます。

## 設計上の特徴

- 動画の抽出・プレビュー・書き出しを可能な範囲で端末内処理し、サーバー転送量を抑制
- 外部AIを使う操作と端末内だけで完結する操作を分離し、API原価を制御
- LINE Login、期限付きセッション、サーバー側の利用枠検証でアカウントを保護
- StripeのPrice情報をサーバーで検証し、Webhookを冪等に処理
- GitHub Actionsから同一成果物を試験環境・本番へ昇格するCI/CD
- D1マイグレーション、合成監視、切り戻し手順をリポジトリ内で管理

## システム概要

    ブラウザ
      ├─ React / Vinext UI
      ├─ MediaBunnyによる動画・音声処理
      └─ プレビュー・書き出し
             │
             ▼
    Cloudflare Pages Functions
      ├─ D1: アカウント・利用枠・決済状態
      ├─ OpenAI API: 音声認識・台本・AI音声
      ├─ Stripe: Checkout・Webhook
      └─ LINE Login: 本人認証

通常の動画編集経路では、素材動画そのものを永続保存しません。25MBを超える動画やMOV/M4Vは、ブラウザ側で音声を抽出・分割して音声認識へ渡します。

## 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| Web | TypeScript, React 19, Next.js 16, Vinext, Tailwind CSS 4 |
| 動画・音声 | MediaBunny, AAC Encoder, Web Audio API |
| 実行基盤 | Cloudflare Pages / Workers |
| データ | Cloudflare D1, Drizzle ORM |
| AI | OpenAI Audio / Realtime API |
| 認証 | LINE Login, SimpleWebAuthn |
| 決済 | Stripe Checkout / Webhook |
| 品質・公開 | Node Test Runner, ESLint, GitHub Actions, Wrangler |

## ローカル開発

### 必要環境

- Node.js 22.13.0以上
- pnpm 11.9.0

### 起動

    pnpm install --frozen-lockfile
    pnpm run dev

### 検証

    pnpm run lint
    pnpm run test

依存関係の正本は [pnpm-lock.yaml](pnpm-lock.yaml) です。秘密情報はコミットせず、必要な変数名だけを [.env.example](.env.example) で管理します。

## ドキュメント

技術情報の正本はこのGitHubリポジトリです。READMEはポートフォリオと入口に限定し、実装・認証・課金・復旧などの詳細は [docs/README.md](docs/README.md) から参照できます。

- [機能仕様](docs/product/features.md)
- [AIナレーション](docs/product/ai-narration.md)
- [アーキテクチャ](docs/architecture/overview.md)
- [認証・セキュリティ](docs/security/authentication.md)
- [課金](docs/billing/stripe.md)
- [本番運用](docs/operations/production-operations.md)
- [ドキュメント管理方針](docs/documentation-policy.md)

企画、顧客インタビュー、仮説、コピー案は、必要になった段階でNotionに分離します。実装や運用に影響する決定は、必ずこのリポジトリの資料へ反映します。

## 現在の状態

公開サイトは継続改善中です。キャラクター性の強い「ポップキャラクター」音声は、日本語イントネーションの品質調整のため公開を停止しています。対応状況と意図的な制約は [機能仕様](docs/product/features.md) に記録します。
