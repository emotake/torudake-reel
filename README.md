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

## 災害復旧と秘密情報

公開リポジトリにはAPIキー、決済用secret、利用者データを保存しません。
必要な変数名は `.env.example`、復旧の境界と確認手順は
`docs/operations/disaster-recovery.md` に記載します。暗号化した復旧情報は
非公開リポジトリ `emotake/torudake-reel-recovery` で管理し、復号鍵は
GitHub外に保管します。

## 認証と公開環境

公開Cloudflare Pagesでは、クライアントが偽装できる認証ヘッダーを信用しません。
`TRUST_SITES_AUTH_HEADERS` は未設定または `false` のままにしてください。
この値を `true` にできるのは、OpenAI Sitesの認証ディスパッチャー配下だけです。

一般公開環境では、新しいアカウントをLINE Loginで作成します。認可scopeは
`openid` のみで、LINEのメールアドレス、表示名、プロフィール画像は取得しません。
Callback URLは `/api/account/oauth/line/callback` です。現在の本番では
`https://torudake-reel.pages.dev/api/account/oauth/line/callback` をLINE Developers
Consoleへ完全一致で登録し、`OIDC_CANONICAL_ORIGIN` はパスなしの
`https://torudake-reel.pages.dev` にします。

LINE LoginチャネルはWebアプリとして作成します。`OIDC_AUTH_SECRET` と
`LINE_LOGIN_CHANNEL_SECRET` は必ずCloudflare Pagesの暗号化されたSecretとして
設定し、平文の環境変数・vars・`.env`・リポジトリへ保存してはいけません。
`LINE_LOGIN_CHANNEL_ID` だけは非secretの環境変数として設定できます。

- Secret `OIDC_AUTH_SECRET`: 32文字以上のランダム値
- Secret `LINE_LOGIN_CHANNEL_SECRET`: LINE Loginチャネルシークレット
- 非secret変数 `LINE_LOGIN_CHANNEL_ID`: LINE LoginチャネルID

初期はLINE LoginチャネルをDevelopingのままにし、AdminまたはTesterに登録した
アカウントだけで、認可開始からcallback、アプリ内セッション、ログアウトまでの
E2E smokeを実施します。一般公開の直前にチャネルをPublishedへ変更します。
PublishedからDevelopingへは戻せないため、変更前に `LINE_LOGIN_ENABLED=false` で
LINEの新規認証入口を停止できる無効化候補を確保し、切り戻し手順を確認します。

設定とCallback URLを確認してから、`OIDC_AUTH_ENABLED=true` と
`LINE_LOGIN_ENABLED=true` を同時に有効化します。Google OAuthのルートは緊急時の
切り戻し用に残しますが、公開UIには表示せず、`GOOGLE_OIDC_ENABLED=false` のままにします。
LINEのアクセストークンとIDトークンはログイン確認にだけ使用し、継続保存しません。
認証完了後は直ちにLINE側の連携権限を解除するため、サービス退会時にLINE側の
連携権限は残りません。アプリ側のログイン状態は、有効期限と取消機能を持つ
独自の期限付きセッション（30日）で管理します。

公開前に `drizzle/0025_worried_lake.sql`、`drizzle/0026_odd_blob.sql`、
`drizzle/0027_personal_edit_preferences.sql` を順番に
適用します。0025に含まれる初回無料用テーブルは将来互換のための未使用schemaで、
このリリースでは対応するAPI・画面・集計処理を公開しません。認証方式をすべて無効の
まま本番公開すると、新規利用者がログインできません。`OIDC_AUTH_SECRET` と
`LINE_LOGIN_CHANNEL_ID` はLINE利用者識別子のハッシュ入力です。既存の
`account_external_identities` を移行せずに変更してはいけません。

Passkeyは最終的な独自ドメインとWebAuthn RP IDが確定するまで
`PASSKEY_AUTH_ENABLED=false` のままにします。D1 migrationと
`TRIAL_ISSUANCE_SECRET` を準備し、独自ドメインへの移行手順を確認した場合だけ
`true` に変更します。無効時はPasskeyの登録、ログイン、本人確認、公開UIをすべて
停止します。将来有効化しても、Passkey単独では新しいアカウントを作成せず、LINEで
作成したアカウントの予備ログイン方法としてだけ追加します。Passkeyの秘密鍵は利用者の
端末から送信されず、サーバーには公開鍵とハッシュ化したセッションだけを保存します。

編集とプレビュー用の利用枠予約は匿名trialでも利用できます。一方、外部AI原価が
発生する文字起こし・AI台本・AI音声の各APIは匿名trialを受け付けません。運営権限
またはLINEでログインしたアカウントが必要です。Passkeyを将来有効化した場合は、
登録済みPasskeyでログインしたアカウントも利用できます。

無料体験の新規発行には、32文字以上のランダムな
`TRIAL_ISSUANCE_SECRET` が必要です。値はCloudflareのシークレットとして設定し、
リポジトリへ保存しないでください。

AIナレーションは `gpt-realtime-2.1-mini` を主モデルとして使用し、Realtime接続を
PCM 24kHzのWAVへ変換してプレビューと書き出しへ渡します。接続開始前に失敗しても
別の声へ自動切替せず、同じモデルでもう一度試せるエラーとして返します。緊急時だけ
`NARRATION_SPEECH_MODE=legacy` を設定すると、運営判断で従来の
`gpt-4o-mini-tts` に切り替えられます。

キャラクター音声の人物像、台本指示、話速、基底音声は
`lib/narration-voice-profiles.ts` で一元管理します。`character-v1` の基底音声は
一次試聴で `shimmer` と `verse` が選定されましたが、`party`（ポップキャラクター）は
日本語イントネーションの品質調整中のため公開を一時停止しています。既存データとの
互換性を保つため内部定義は残し、公開UIと生成APIでは利用できない状態です。
公開環境では `NARRATION_VOICE_PROFILE=character-v1` を設定し、音声を戻す必要が
あるときだけ `classic` へ明示的に切り替えます。未設定または不正な値は安全側の
`classic` へ戻ります。

候補評価の準備は `pnpm run ops:prepare-character-voice-evaluation -- --output <出力先>`
で行います。この処理は採点票と乾式の費用見積もりだけを作り、OpenAI API、APIキー、
ネットワークを使用しません。詳しい手順と有料工程の境界は
`docs/operations/character-voice-evaluation.md` に記載しています。

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
- `pnpm release:pages`: clean HEADからPages成果物manifestを作成し、同一成果物だけを検証付きで公開
- `pnpm run ops:prepare-character-voice-evaluation`: APIを呼ばずにキャラクター音声の評価票と費用見積もりを作成

## リリース安全手順（Dドライブのみ）

本番はOpenAI Sitesではなく、Cloudflare Pagesの `torudake-reel` です。
誤って別のSitesプロジェクトへ公開しないよう、`.openai/hosting.json` は置きません。
ローカル開発用bindingは `config/local-bindings.json`、固定した本番対象は
`config/release-targets.json`、D1保守専用設定は `wrangler.d1.jsonc` に分離しています。
`wrangler.d1.jsonc` をPages公開に使ってはいけません。

PowerShellでは、Node、pnpm、一時ファイル、Wrangler認証情報とログをすべて
Dドライブへ固定してから作業します。

```powershell
$releaseRoot = 'D:\path\to\reviewed-clean-release-worktree'
$runtimeRoot = 'D:\path\to\pinned-node-runtime'
$releaseTemp = 'D:\path\to\release-temp'
$wranglerState = 'D:\path\to\wrangler-auth-state'
$pagesReleaseRoot = 'D:\path\to\private\pages-release-<commit>'
$pagesArtifactManifest = "$pagesReleaseRoot\pages-artifact.json"
$disabledPagesDeploymentRecord = "$pagesReleaseRoot\disabled.deployment.json"
$productionPagesDeploymentRecord = "$pagesReleaseRoot\production.deployment.json"
$rollbackManifest = $disabledPagesDeploymentRecord
$previousSchedulerManifest = 'D:\path\to\private\account-deletion-worker-<previous-commit>.json'
$newSchedulerManifest = 'D:\path\to\private\account-deletion-worker-<commit>.json'

New-Item -ItemType Directory -Force $releaseTemp | Out-Null
New-Item -ItemType Directory -Force $pagesReleaseRoot | Out-Null
New-Item -ItemType Directory -Force "$wranglerState\config" | Out-Null
New-Item -ItemType Directory -Force "$wranglerState\cache" | Out-Null
$env:TEMP = $releaseTemp
$env:TMP = $releaseTemp
$env:XDG_CONFIG_HOME = "$wranglerState\config"
$env:XDG_CACHE_HOME = "$wranglerState\cache"
$env:WRANGLER_LOG_PATH = "$wranglerState\wrangler.log"
$env:TORUDAKE_PAGES_ARTIFACT_MANIFEST = $pagesArtifactManifest
# $rollbackManifest はwrapperが排他的に作る出力先なので、disabled deployment検証後まで設定しない。
# 通常releaseでは既存activeを証明する、直前releaseの実在manifestを入力にする。
# $newSchedulerManifest はまだ存在しない出力先なので、ここには設定しない。
$env:TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST = $previousSchedulerManifest
$env:PATH = "$runtimeRoot\bin;$env:PATH"
Set-Location -LiteralPath $releaseRoot

# 必ずreview済みclean HEADであること。出力が1行でもあれば中止する。
git status --porcelain
git rev-parse HEAD
```

事前確認は次の状態を1つでも検出すると終了コード1で停止します。

- 作業場所または関連する一時領域がDドライブ以外
- OpenAI Sites用metadataの再混入、Pages/D1対象IDの変更、R2の再宣言
- 設定済みの `origin` がCドライブや `file://` などのローカルコピーを指している
- 未コミット変更
- Pages公開用directoryの追加・削除・置換、外部artifact manifestのcommit・全file SHA-256・
  aggregate SHA-256・deployment messageの不一致
- `drizzle/` と本番 `d1_migrations` の不一致
- D1の `quick_check` または外部キー検査の異常
- 外部rollback manifestのdeploymentをCloudflare ID直指定detail APIで確認できない、
  commit・branch・成功status・D1/Analytics Engine bindingが一致しない
- rollback deployment固有URLのhealthがreadyでない、または5つの認証flagが
  すべてfalseではない
- Analytics Engine SQL APIで `torudake_line_auth_events` を一意に照会できない
- 定期退会Workerのlocal Wrangler dry-run bundle、外部manifestの
  deployment/version/Cloudflare ETag、live Workerのannotation/binding、Cron
  `15 18 * * *` が一致しない

正式な共有リポジトリURLが未確定の場合は `origin` を設定せず、レビュー済みcommitを
Cloudflare PagesへDirect Uploadします。旧Cドライブなどローカルコピーをremoteへ
設定してはいけません。正式URLが確定した後だけ `git remote add origin` を行います。

外部変更より先に、同じclean commitで全test、lint、TypeScriptを含むbuild、Pages bundle、
Worker dry-runを完了します。

```powershell
& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" run test
& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" run lint
& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" exec tsc --noEmit
pnpm release:pages -- --prepare `
  --manifest $pagesArtifactManifest `
  --external-root $pagesReleaseRoot `
  --execute --confirm prepare-pages-release
& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" run ops:dry-run-account-deletion-scheduler
```

初回または定期退会Workerを変更したreleaseでは、Pagesより先に同じclean commitの
Worker versionを準備します。通常の `release:preflight` は古いWorkerのままPagesだけを
公開することを許可しません。

```powershell
# まずlocal artifactだけをdry-runし、commitとbundle SHAを確認する（外部変更なし）
pnpm ops:deploy-account-deletion-scheduler

# 通常release: 直前の外部manifestとlive activeが完全一致する場合だけpreviousに採用する。
# 新versionをuploadし、Cronを反映・live再照合してから100%へ切り替え、
# read-backを別の新規D外部manifestへatomicに保存する。
pnpm ops:deploy-account-deletion-scheduler -- --execute `
  --confirm deploy-account-deletion-scheduler `
  --manifest $newSchedulerManifest
$env:TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST = $newSchedulerManifest
```

初回に限り、既存manifestがないlegacy Workerを採用する場合は、上記環境変数を外して
別confirmationを明示します。これはmessage/tagがないlegacy activeだけに使え、通常releaseの
manifest不一致を迂回できません。

```powershell
Remove-Item Env:TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST -ErrorAction SilentlyContinue
pnpm ops:deploy-account-deletion-scheduler -- --execute `
  --bootstrap-previous-provenance `
  --confirm bootstrap-account-deletion-scheduler-provenance `
  --manifest $newSchedulerManifest
$env:TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST = $newSchedulerManifest
```

実行wrapperは、既存Workerが単一version 100%でない場合、または直前manifestとliveの
deployment/version/ETag/message/tag/time/binding/Cronが一致しない場合はupload前に停止します。
順序は確定dry-run bundleのprivate snapshot、`versions upload <snapshot> --no-bundle`、
`wrangler triggers deploy`、Schedules APIでexact Cron再照合、
100% activation、再read-back、manifest確定前後の再照合です。trigger操作後の失敗では、live
active setが記録済みpreviousだけならCronを復旧し、自分がuploadしたversionだけを含む場合に限り
previous versionを100%へ戻してETag/provenance/Cronを再検証します。foreign versionまたは不明な
状態を検出した場合は第三者のreleaseを上書きせず重大エラーで停止します。外部manifestはrelease
ごとに新しいpathを使います。
`15 18 * * *` はUTCで、日本時間では毎日03:15です。Cloudflare全拠点へのtrigger変更伝播は
最大15分かかる場合があり、manifestの `liveVerified` はcontrol-plane設定の一致を表します。
緊急rollbackはmanifestの `previousVersionId` をレビューしてから
`wrangler versions deploy <version-id>@100% --name
torudake-reel-account-deletion-scheduler --config
wrangler.account-deletion-scheduler.jsonc --yes` を実行し、続けて同configの
`wrangler triggers deploy` とSchedules APIでCronも再確認します。

次に `docs/operations/production-operations.md` の専用modeで、同じcommit・required
bindings・5認証flag=falseのPages rollback deploymentを作成します。wrapperは固有URLの
health/methods、Analytics Engine SQL、Cloudflare metadataを検証し、そのdeployment自体を
D外部rollback manifestへ排他的に記録した直後、元のLINE有効Productionへ自動で戻して
read-backします。`TORUDAKE_ROLLBACK_MANIFEST` をそのwrapper生成recordへ向けた後にだけ通常の
`pnpm release:preflight` を実行します。offline modeや2つのprovisioning modeは
Pages本番activationを許可しません。

```powershell
$env:TORUDAKE_ROLLBACK_MANIFEST = $rollbackManifest
```

Pagesの直接公開は必ず `release:pages` wrapperを使います。wrapperは外部artifact manifestを
安全に再読込し、全fileをrepo外のprivate snapshotへ固定して再照合します。Wranglerは生成済み
`.wrangler/deploy/config.json` を探索できない隔離cwdから、そのsnapshotだけを読みます。固定project・
branch・commit SHA・`commit_dirty=false`・artifact SHA入りmessageを渡し、公開後もProduction
全履歴・canonical project・detail APIで並行deployment、新規deployment、binding、status、
commit/message、mode別health/認証flag、Analytics Engine SQLを照合してD外部recordへ排他的に
保存します。失敗時は直前の検証済みProductionへAPI rollbackし、復旧を再確認します。raw
`wrangler pages deploy` は正式手順ではありません。
WranglerのCloudflare credentialには `Account Analytics: Read` が必要ですが、token値は
引数・manifest・ログ・チャットへ出してはいけません。

通常のonline preflight、全テスト、Pages用ビルドがすべて成功し、差分とcommit SHAを
確認した後だけ、固定したproject名とproduction branchを明示して公開します。

```powershell
& "$runtimeRoot\bin\node.exe" "$runtimeRoot\node_modules\pnpm\bin\pnpm.cjs" run release:preflight
pnpm release:pages -- --deploy `
  --manifest $pagesArtifactManifest `
  --external-root $pagesReleaseRoot `
  --deployment-record $productionPagesDeploymentRecord `
  --execute --confirm deploy-cloudflare-pages
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
