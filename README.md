# 撮るだけリール

素材動画から、自動カット、字幕、AIナレーション、テロップ、表紙、
投稿文、MP4書き出しまでをブラウザで行う縦動画編集サービスです。
Vinext、Cloudflare Pages、D1を使用します。

## Prerequisites

- Node.js `>=22.13.0`
- pnpm `11.9.0`

## Quick Start

```bash
pnpm install --frozen-lockfile
pnpm run dev
pnpm run test
```

依存関係の正本は `pnpm-lock.yaml` です。npmのlockfileは使用しません。

## 構成

- `app/`: 画面とAPIルート
- `lib/`: 動画編集、字幕、利用枠、認証・課金の共通処理
- `db/schema.ts`: D1スキーマ
- `drizzle/`: 本番適用するD1マイグレーション
- `tests/`: セキュリティ、課金、字幕、プレビュー、書き出しの回帰テスト
- `cloudflare-pages-entry.mjs`: Pages用エントリーとセキュリティヘッダー

## 認証と公開環境

公開Cloudflare Pagesでは、クライアントが偽装できる認証ヘッダーを信用しません。
`TRUST_SITES_AUTH_HEADERS` は未設定または `false` のままにしてください。
この値を `true` にできるのは、OpenAI Sitesの認証ディスパッチャー配下だけです。

一般公開環境のアカウント認証にはパスキーを使用します。認証用の秘密鍵は
利用者の端末から送信されず、サーバーには公開鍵とハッシュ化したセッションだけを
保存します。D1へ `drizzle/0010_passkey_accounts.sql` を適用してから公開してください。

無料体験の新規発行には、32文字以上のランダムな
`TRIAL_ISSUANCE_SECRET` が必要です。値はCloudflareのシークレットとして設定し、
リポジトリへ保存しないでください。

通常の動画編集はR2を使用せず、25MB以下の対応動画を直接音声認識へ送り、
それを超える動画やMOV/M4Vはブラウザ内で音声だけを分割します。
R2の `MEDIA` bindingは、公開導線のない開発用ファイル転送APIを使う場合だけ任意です。

Stripe課金には `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、
`STRIPE_PRICE_LIGHT_MONTHLY`、`STRIPE_PRICE_ONE_TIME` が必要です。月額価格は
1,480円・月8本、単品価格は300円・1本としてStripe側の価格を検証し、金額、通貨、
課金周期のいずれかが異なる場合はCheckoutを開始しません。本番キーを使う場合は、
Stripeアカウントの本人確認、事業者情報、入金口座を完了してから設定してください。

## コマンド

- `pnpm run dev`: ローカル開発
- `pnpm run build`: Vinextビルド
- `pnpm run build:cloudflare-pages`: Pages公開用バンドル生成
- `pnpm run test`: ビルドと全回帰テスト
- `pnpm run lint`: 静的検査
- `pnpm run db:generate`: Drizzleマイグレーション生成

## 関連資料

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
