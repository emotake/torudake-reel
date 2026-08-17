# 撮るだけリール

素材動画から、自動カット、字幕、AIナレーション、テロップ、表紙、
投稿文、MP4書き出しまでをブラウザで行う縦動画編集サービスです。
Vinext、Cloudflare Pages、D1を使用します。

複数動画の合成では、最大5本の素材を選択できます。素材は選択した順番を
保ち、各素材から1〜2カットを時間順につないで完成動画を1本作ります。
入力上限は全素材の合計で500MB・5分です。複数素材をつないだ場合も、
完成した1本の書き出しを保存すると、料金プランの動画1本分を使用します。

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

一般公開環境では、新しいアカウントをGoogleで作成します。Passkeyは登録済み
アカウントのログイン・本人確認・予備鍵としてのみ使用し、Passkey単独では新しい
アカウントを作成しません。Passkeyの秘密鍵は利用者の端末から送信されず、サーバー
には公開鍵とハッシュ化したセッションだけを保存します。GoogleのCallback URLは
`/api/account/oauth/google/callback` です。`OIDC_CANONICAL_ORIGIN` には公開originを
パスなしで設定し、Google Cloud側のredirect URIと完全一致させてください。

公開前に `drizzle/0025_worried_lake.sql` と `drizzle/0026_odd_blob.sql` を順番に
適用します。0025に含まれる初回無料用テーブルは将来互換のための未使用schemaで、
このリリースでは対応するAPI・画面・集計処理を公開しません。Googleの資格情報と
callbackを準備してから `OIDC_AUTH_ENABLED=true` と
`GOOGLE_OIDC_ENABLED=true` を同時に有効化してください。認証方式をすべて無効の
まま本番公開すると、新規利用者がログインできません。
`OIDC_AUTH_SECRET` と `GOOGLE_OIDC_CLIENT_ID` はGoogle利用者識別子のハッシュ入力
です。既存の `account_external_identities` を移行せずに変更してはいけません。

編集とプレビュー用の利用枠予約は匿名trialでも利用できます。一方、外部AI原価が
発生する文字起こし・AI台本・AI音声の各APIは匿名trialを受け付けません。運営権限
またはGoogle／登録済みPasskeyでログインしたアカウントが必要です。

無料体験の新規発行には、32文字以上のランダムな
`TRIAL_ISSUANCE_SECRET` が必要です。値はCloudflareのシークレットとして設定し、
リポジトリへ保存しないでください。

AIナレーションは `gpt-realtime-2.1-mini` を主モデルとして使用し、Realtime接続を
PCM 24kHzのWAVへ変換してプレビューと書き出しへ渡します。接続開始前に失敗した
場合は `tts-1-hd` へ安全に切り替わります。緊急時だけ
`NARRATION_SPEECH_MODE=legacy` を設定すると、従来の `gpt-4o-mini-tts` に戻せます。

通常の動画編集はR2を使用せず、25MB以下の対応動画を直接音声認識へ送り、
それを超える動画やMOV/M4Vはブラウザ内で音声だけを分割します。
R2の `MEDIA` bindingは既定では宣言しません。公開導線のない開発用ファイル転送APIを
明示的に有効化するときだけ、Cloudflare側へ別途追加します。

Stripe課金には `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、
`STRIPE_PRICE_STARTER_MONTHLY`、`STRIPE_PRICE_STANDARD_MONTHLY`、
`STRIPE_PRICE_ONE_TIME` が必要です。月3本プランは1か月500円で動画3本まで、月7本プランは
1か月1,000円で動画7本まで、動画1本プランは1回200円で動画1本までとしてStripe側の価格を検証し、金額、通貨、
課金周期のいずれかが異なる場合はCheckoutを開始しません。

旧1,480円・月8本プランは既存契約者だけに提供し、新規販売しません。既存契約を
継続する環境では、互換用の `STRIPE_PRICE_LIGHT_MONTHLY` を任意で設定します。
本番キーを使う場合は、Stripeアカウントの本人確認、事業者情報、入金口座を完了してから
設定してください。

## コマンド

- `pnpm run dev`: ローカル開発
- `pnpm run build`: Vinextビルド
- `pnpm run build:cloudflare-pages`: Pages公開用バンドル生成
- `pnpm run test`: ビルドと全回帰テスト
- `pnpm run lint`: 静的検査
- `pnpm run db:generate`: Drizzleマイグレーション生成
- `pnpm run release:preflight`: 公開先・Git・本番D1を読み取り専用で事前確認
- `pnpm run release:preflight:offline`: ローカル項目だけ確認（公開許可には使用不可）

## リリース安全手順（Dドライブのみ）

本番はOpenAI Sitesではなく、Cloudflare Pagesの `torudake-reel` です。
誤って別のSitesプロジェクトへ公開しないよう、`.openai/hosting.json` は置きません。
ローカル開発用bindingは `config/local-bindings.json`、固定した本番対象は
`config/release-targets.json`、D1保守専用設定は `wrangler.d1.jsonc` に分離しています。
`wrangler.d1.jsonc` をPages公開に使ってはいけません。

PowerShellでは、Node、pnpm、一時ファイル、Wrangler認証情報とログをすべて
Dドライブへ固定してから作業します。

```powershell
$releaseRoot = 'D:\CodexTemp\torudake-release-src-20260810'
$runtimeRoot = 'D:\CodexTemp\torudake-node-runtime'
$releaseTemp = 'D:\CodexTemp\torudake-runtime-temp'
$wranglerState = 'D:\CodexTemp\wrangler-auth'

New-Item -ItemType Directory -Force $releaseTemp | Out-Null
New-Item -ItemType Directory -Force "$wranglerState\config" | Out-Null
New-Item -ItemType Directory -Force "$wranglerState\cache" | Out-Null
$env:TEMP = $releaseTemp
$env:TMP = $releaseTemp
$env:XDG_CONFIG_HOME = "$wranglerState\config"
$env:XDG_CACHE_HOME = "$wranglerState\cache"
$env:WRANGLER_LOG_PATH = "$wranglerState\wrangler.log"
$env:PATH = "$runtimeRoot\bin;$env:PATH"
Set-Location -LiteralPath $releaseRoot

& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" run release:preflight
```

事前確認は次の状態を1つでも検出すると終了コード1で停止します。

- 作業場所または関連する一時領域がDドライブ以外
- OpenAI Sites用metadataの再混入、Pages/D1対象IDの変更、R2の再宣言
- 設定済みの `origin` がCドライブや `file://` などのローカルコピーを指している
- 未コミット変更
- `drizzle/` と本番 `d1_migrations` の不一致
- D1の `quick_check` または外部キー検査の異常

正式な共有リポジトリURLが未確定の場合は `origin` を設定せず、レビュー済みcommitを
Cloudflare PagesへDirect Uploadします。旧Cドライブなどローカルコピーをremoteへ
設定してはいけません。正式URLが確定した後だけ `git remote add origin` を行います。

事前確認、全テスト、Pages用ビルドがすべて成功し、差分とcommit SHAを確認した後だけ、
固定したプロジェクト名とproduction branchを明示して公開します。

```powershell
& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" run test
& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" run lint
& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" run build:cloudflare-pages
& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" exec wrangler pages deploy dist/cloudflare-pages --project-name torudake-reel --branch main
```

### D1 migration ledgerの整合

`d1_migrations` と `drizzle/` が一致しない間は、
`wrangler d1 migrations apply --remote` を実行してはいけません。既に反映済みのSQLを
Wranglerが未適用と判断し、再実行する危険があるためです。`release:preflight` 自体は
`SELECT` と `PRAGMA` だけを実行し、履歴を書き換えません。

2026-08-13に、0000〜0019を空DBへ順番に適用した結果と本番を照合し、
アプリ用179列、79索引、その全列順・一意性が一致することを確認しました。
直前のTime Travel bookmarkと完全exportをDドライブへ保存したうえで、
`scripts/operations/baseline-d1-migration-ledger-0000-0019.sql` により、既に適用済みの
20ファイル名だけを履歴へ記録しました。`quick_check=ok`、外部キー違反0、
`wrangler d1 migrations list` は未適用0件です。このbaseline SQLは一度限りの監査記録で、
再実行してはいけません。照合値と切り戻し情報は
`docs/operations/2026-08-13-d1-ledger-baseline.md` に記録しています。
今後の新規migrationは通常どおりWranglerで適用します。

`release:preflight:offline` は認証がない端末でローカル設定を点検するためだけのものです。
本番D1を確認しないため、成功してもリリース許可にはなりません。

## 関連資料

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
- [Dependency risk register](docs/operations/dependency-risk-register.md)
