# アカウント復旧の運用手順

## 目的

全てのパスキーを紛失した有料利用者について、第三者による乗っ取りを防ぎながら、解約または復旧を支援するための手順です。

`POST /api/account/recovery` は復旧依頼を記録するだけです。ログイン権限、パスキー登録権限、Stripe Customer Portal のURLは発行しません。メール送信・メール所有確認の基盤が導入されるまでは、`approved` や `consumed` への更新を自動化しないでください。

## 利用者への案内

1. アカウント画面の「ログインできない場合」から、決済時のメールアドレスを入力して受付番号を取得してもらう。
2. 利用者本人から `torudake.reel@gmail.com` へ、受付番号と希望する対応（復旧または解約）を送ってもらう。
3. 「アカウントが存在する／しない」は画面や最初の返信で明かさない。

## 運営側の確認

最低でも次を照合し、1項目だけで本人と判断しないでください。

- `account_recovery_challenges.id` が利用者の受付番号と一致し、`status = 'requested'`、`expires_at` が未来であること
- 行に `user_id` があること（ない場合はアカウント不存在と断定せず、一般的な案内だけを返す）
- 該当ユーザーに紐づく Stripe Customer の決済メール、直近の決済日・金額
- Stripe Dashboard 上の不正利用・異議申し立て・本人確認上の警告がないこと

利用者へカード番号全桁、CVC、パスワード、パスキーの秘密情報を送らせてはいけません。

## 解約のみを希望する場合

本人確認後、Stripe Dashboard で対象CustomerとSubscriptionを再確認し、利用者の希望どおり「期間終了時に解約」または必要な緊急対応を行います。D1を直接書き換えて契約状態を作らず、Stripe webhook による同期を確認してください。

## ログイン復旧を希望する場合

現時点では、安全なメール所有確認と一回限りの復旧トークン配送が未実装です。手作業でパスキーやセッションを作成せず、解約支援を優先します。将来、次を全て満たしてから復旧完了APIを追加します。

- 有効期限が短い一回限りの復旧トークン
- トークンそのものを保存せずHMACまたはSHA-256ハッシュだけを保存
- Stripeの決済用メールへの所有確認
- 再利用防止の原子的な `consumed_at` 更新
- 復旧後に既存セッションを全失効し、新しいパスキー登録を必須化
- 操作監査ログと異常回数アラート

## 状態更新

- 調査開始時: `requested` → `reviewing`
- 本人と確認できない／依頼撤回: `rejected`
- 期限超過: `expired`
- `approved` と `consumed` は、安全なトークン配送基盤が完成するまで使用禁止

問い合わせ内容やメールアドレスの平文はD1へ保存しません。`contact_hash` と `network_hash` は照合・濫用防止専用で、画面へ返さないでください。

## アカウント削除予約

アカウント削除は即時実行せず、本人がパスキーで再認証した後に30日の猶予期間を設けます。月額プランが有効な間は予約を受け付けず、Stripe Customer Portalで自動更新を解約し、現在の利用期間が終了してから予約してもらいます。

`account_deletion_requests.status = 'scheduled'` の行は削除予定であり、即時の物理削除を意味しません。利用者は猶予期間中に予約を取り消せます。期限到来後は、運営者限定の削除executorが対象を1件ずつleaseし、契約・異議申立て・処理中の保存を再確認してから処理します。

### 毎日の実行

本番用秘密値はパスワード管理ツールからその都度読み込み、コマンド履歴やリポジトリへ保存しません。必ずdry-runを先に実行します。

```powershell
$env:ACCOUNT_DELETION_OPERATIONS_SECRET = "<password managerから取得>"
$env:TORUDAKE_SITE_ORIGIN = "https://torudake-reel.pages.dev"
pnpm ops:account-deletions -- --limit 5
```

`failed = 0` であり、`blocked` の理由を確認できた場合だけ、同じ件数上限で実行します。実行にはAPI本文とheaderの二重確認が必要です。

```powershell
pnpm ops:account-deletions -- --execute --confirm execute-due-account-deletions --limit 5
```

本番では `torudake-reel-account-deletion-scheduler` が毎日03:15（日本時間）に同じ上限5件で実行します。Cron Workerは公開URLを持たず、削除専用secretだけを保持します。手動コマンドは定期処理の障害調査と再実行に使用します。

- 1回の上限は25件、標準は5件です。大量処理でStripeやR2を圧迫しません。
- `processing` は30分leaseです。中断した処理はlease失効後に再取得でき、R2削除とD1削除はいずれも再実行可能です。multipart uploadのabortは「既に不存在」と通信障害を安全に区別できないため、どの失敗も成功扱いにせず、D1メタデータを残して次回へ再試行します。
- `active_subscription`、`open_dispute`、`active_usage_operation`、`billing_sync_in_progress` は削除せず `scheduled` へ戻します。原因解消後の日次処理で再確認します。
- Stripe応答不正、100件を超える履歴、R2失敗など「安全に確認できない」場合も削除せず `failed` とします。無理にD1を直接更新しません。
- 実行結果にはメールアドレスやStripe IDを返しません。問い合わせには `requestId` と24桁の `accountReference` を使用します。

### 削除・匿名化・保持

完了時のD1変更は1つのbatchで行い、途中失敗時はロールバックします。R2上の対象動画を先に削除し、R2が失敗した場合はD1の本人情報を消して「孤児動画」にする処理を進めません。

- 削除: passkey、全account session、本人に紐づく認証challenge・復旧受付、字幕設定、trial session/fingerprint、checkout lock/rate limit、利用予約とAI処理内訳、動画transferのR2 objectとD1 metadata。
- 匿名化して保持: `users` はメールを無作為な無効アドレスへ置換し、請求メール・氏名をNULLにして `account_deleted_at` を記録します。AI表示確認は`user_id`をNULL、session hashを行固有の無効値へ置換します。
- 法令・返金・異議対応のため保持: `billing_subscriptions`、`billing_purchases`、Stripe object ID、金額・契約期間・返金/異議状態、`stripe_events`。Stripe customer IDはWebhookの返金・異議更新を台帳へ反映するため匿名user行にのみ残します。元メールで再登録してもこの台帳へログインできません。
- 既にaccountと結び付かない集計: `product_events` と `product_feedback` は接続元を秘密値で不可逆化したactor hashしか持たず、account user IDとの対応表がありません。個別削除の対象にせず、通常の90日/180日保持期限で削除します。`provider_usage_daily` は日次集計だけなので保持します。

`account_deletion_execution_audit` には、生のuser ID・メール・Stripe IDを保存せず、不可逆な`account_reference`、request ID、結果理由、削除件数要約、時刻だけを保存します。法令上の保存期間は法務・税務確認後に別途確定し、未確定の間は自動削除しません。

削除APIの `ACCOUNT_DELETION_OPERATIONS_SECRET` は、定期監視へ渡す `OPS_HEALTH_SECRET` と必ず別の値にします。監視サービスや一般的な障害対応担当には削除用秘密値を共有しません。削除用秘密値は32文字以上の無作為値とし、漏えい時はCloudflare secretをローテーションしてから再実行します。

### 復元時の注意

バックアップを復元した場合は、公開再開前に本番の`account_deletion_execution_audit`と`account_deletion_requests.status = 'completed'`を復元先へ反映し、削除済みaccountやR2 objectが再公開されないことを確認します。月次restore drillでは、削除済みの無効メールからpasskey/sessionを復元できないことも検査します。
