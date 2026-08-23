# 認証・セキュリティ

最終確認日: 2026-08-24

## 公開環境の方針

一般公開環境ではLINE Loginでアカウントを作成します。Cloudflare Pages上のアプリは、クライアントが偽装できる認証ヘッダーを信用しません。

| 設定 | 本番の意図 |
| --- | --- |
| OIDC_AUTH_ENABLED | true |
| LINE_LOGIN_ENABLED | true |
| GOOGLE_OIDC_ENABLED | false |
| EMAIL_AUTH_ENABLED | false |
| PASSKEY_AUTH_ENABLED | false |
| TRUST_SITES_AUTH_HEADERS | falseまたは未設定 |

TRUST_SITES_AUTH_HEADERSをtrueにできるのは、信頼できるOpenAI Sites認証ディスパッチャー配下だけです。公開Cloudflare Pagesでは有効にしません。

## LINE Login

- チャネル種別: Webアプリ
- scope: openidのみ
- 取得しない情報: メールアドレス、表示名、プロフィール画像
- 本番Callback URL: https://torudake-reel.pages.dev/api/account/oauth/line/callback
- canonical origin: https://torudake-reel.pages.dev

認可コード、IDトークン、アクセストークンはログイン確認に必要な間だけ扱い、継続保存しません。認証後はアプリ独自の取消可能な期限付きセッションを発行し、有効期限は30日です。

サービス退会時には、アプリ側データ削除に加えてLINE側の連携解除を実行します。

## 変数とSecret

| 名前 | 種別 | 用途 |
| --- | --- | --- |
| OIDC_AUTH_ENABLED | 変数 | OIDC認証全体の有効化 |
| OIDC_CANONICAL_ORIGIN | 変数 | 認証callbackの正規origin |
| OIDC_AUTH_SECRET | Secret | state、セッション、外部IDの保護 |
| LINE_LOGIN_ENABLED | 変数 | LINE Loginの有効化 |
| LINE_LOGIN_CHANNEL_ID | 変数 | LINE Loginチャネル識別子 |
| LINE_LOGIN_CHANNEL_SECRET | Secret | LINE OAuthクライアント認証 |
| TRIAL_ISSUANCE_SECRET | Secret | 無料体験発行の保護 |
| OPERATOR_ENROLLMENT_CODE | Secret | 運営端末登録 |

Secretの値はCloudflareの暗号化されたSecretへ保存し、リポジトリ、平文vars、ログ、Notionへ保存しません。必要な変数名だけを [.env.example](../../.env.example) に記載します。

OIDC_AUTH_SECRETとLINE_LOGIN_CHANNEL_IDは、保存するLINE利用者識別子のHMAC入力です。既存のaccount_external_identitiesを移行せずに変更すると、既存利用者を同じアカウントとして照合できなくなります。通常のローテーション対象として扱わず、変更時は移行計画が必要です。

## 無料体験とAI利用

匿名の無料体験でも、端末内編集とプレビューに必要な利用枠予約は行えます。ただし外部原価が発生する文字起こし、AI台本、AI音声のAPIは匿名利用を受け付けません。

AI機能を使えるのは次の利用者です。

- LINEでログインしたアカウント
- 運営権限を持つアカウント
- 将来Passkeyを有効化した場合の、既存アカウントへ登録済みのPasskeyログイン

無料体験を新規発行するTRIAL_ISSUANCE_SECRETは32文字以上のランダム値を使用します。

## Passkey

最終的な独自ドメインとWebAuthn RP IDが確定するまで無効にします。将来有効化しても、Passkey単独で新規アカウントを作成せず、LINEで作成済みのアカウントに追加する予備ログイン方法として扱います。

有効化の前提:

- 独自ドメインとRP IDが確定している
- 対応するD1マイグレーションが適用済み
- TRIAL_ISSUANCE_SECRETが設定済み
- ドメイン移行と切り戻し手順を検証済み

Passkeyの秘密鍵は利用者の端末から送信されません。サーバーには公開鍵とハッシュ化したセッションだけを保存します。

## Google OAuth

緊急時の切り戻し用ルートは残しますが、公開UIには表示せず、GOOGLE_OIDC_ENABLEDはfalseを維持します。有効化は別途セキュリティレビューとcallback設定の確認を必要とします。

## ログと監視

- 認証token、OAuth code、Secretをログへ出力しない
- state不一致、callback失敗、セッション失効を分類して計測する
- 利用者識別子は生値ではなく、用途に合う不可逆表現で扱う
- 運営権限の付与・取消は監査可能なイベントとして残す

具体的な監視と調査は [LINE認証の可観測性](../operations/line-auth-observability.md)、復旧は [アカウント復旧](../operations/account-recovery.md) を参照してください。
