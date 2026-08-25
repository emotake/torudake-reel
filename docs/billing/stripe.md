# Stripe課金

最終確認日: 2026-08-24

## 販売プラン

| プラン | 価格 | 利用枠 | 販売状態 |
| --- | ---: | ---: | --- |
| 無料体験 | 0円 | 合計3分または2動画まで編集・プレビュー | 提供中。完成動画の保存は有料枠が必要 |
| 月3動画 | 月額500円 | 月3動画 | 新規販売中 |
| 月7動画 | 月額1,000円 | 月7動画 | 新規販売中 |
| 1動画作成 | 1回200円 | 1動画 | 新規販売中 |
| 旧月8動画 | 月額1,480円 | 月8動画 | 既存契約者のみ。新規販売しない |

価格を変更する場合は、画面の文言だけでなくStripe Product / Price、サーバー側検証、特定商取引法表記、テストを同時に更新します。

## 利用枠の扱い

- 編集とプレビューは無料体験の範囲で利用できます。
- 完成動画を正常に検証して保存した時点で、動画1本分を消費します。
- 複数動画をつないだ場合も、完成した1ファイルを1動画として扱います。
- 失敗した書き出しや、表紙・字幕ファイルだけの保存では動画枠を消費しません。
- Webhookの重複配送で利用枠を重複付与しません。

AI生成回数は動画枠と別に制限します。

| 区分 | 1本の編集でのAI操作上限 |
| --- | ---: |
| 無料 | 3回 |
| 月額プラン | 6回 |
| 1動画作成 | 5回 |
| 運営 | 10回 |

## Checkoutの安全条件

サーバーは設定されたStripe Priceを取得し、次を検証してからCheckout Sessionを作成します。

- 通貨がJPY
- 月3動画が500円、月次
- 月7動画が1,000円、月次
- 1動画作成が200円、1回払い
- 旧月8動画を扱う場合は1,480円、月次で既存契約の継続にだけ使用

金額、通貨、課金周期、販売状態のいずれかが期待値と異なる場合はCheckoutを開始しません。クライアントから送られた金額やPrice IDをそのまま信用しません。

## 必要なSecretと変数

| 名前 | 種別 | 用途 |
| --- | --- | --- |
| STRIPE_SECRET_KEY | Secret | Stripe API |
| STRIPE_WEBHOOK_SECRET | Secret | Webhook署名検証 |
| STRIPE_PRICE_STARTER_MONTHLY | 変数 | 月3動画 |
| STRIPE_PRICE_STANDARD_MONTHLY | 変数 | 月7動画 |
| STRIPE_PRICE_ONE_TIME | 変数 | 1動画作成 |
| STRIPE_PRICE_LIGHT_MONTHLY | 変数・任意 | 旧月8動画の既存契約互換 |
| LINE_PAYMENT_NOTIFICATION_ENABLED | 変数・任意 | 運営LINE通知の明示的な有効化 |
| LINE_PAYMENT_NOTIFICATION_ACCESS_TOKEN | Secret・任意 | LINE Messaging APIチャネルアクセストークン |
| LINE_PAYMENT_NOTIFICATION_TO | Secret・任意 | 通知先の運営ユーザー・グループ・トークルームID |

値はCloudflareのSecretまたは環境別varsへ設定します。秘密鍵、Webhook secret、顧客情報をリポジトリやNotionへ保存しません。

## Webhook

- Stripe署名を検証する
- event IDで冪等性を保証する
- Checkout完了、支払い成功・失敗、subscription更新・解約を区別する
- Price IDを内部プランへサーバー側で対応付ける
- 不明なPriceやaccountを自動で有効化しない
- 処理失敗は再送可能な状態にし、利用枠の二重付与を防ぐ

カード番号は本サービスのサーバーやD1へ保存せず、Stripe Checkoutで扱います。

## 運営LINEへの決済通知

`LINE_PAYMENT_NOTIFICATION_ENABLED=true`で、ほかの2つのLINE通知用Secretが設定済みの
場合だけ、署名検証と課金台帳への反映が完了した決済を運営者へ通知します。

- 1動画作成の有料決済
- 月額プランの初回決済
- 月額プランの更新・変更決済

0円決済、決済失敗、解約、返金はこの通知の対象外です。通知内容はプラン、実際の金額、
決済区分、時刻、Stripe eventの末尾12文字だけとし、氏名、メールアドレス、カード情報、
Stripe Customer IDやPaymentIntent IDは送信しません。

Stripe event IDから決定的な`X-Line-Retry-Key`を生成し、StripeのWebhook再送やLINEの
一時障害で同じ通知が重複しないようにします。LINE通知が失敗しても課金台帳と利用枠の
反映は取り消さず、秘密値を含まない運用ログへ失敗を記録します。

日本のLINE公式アカウントは、コミュニケーションプランなら月200通まで固定費0円です。
Push messageは送信通数に数えられ、上限到達後は無料プランでは送信されません。コードが
有料プランへ自動変更したり、追加メッセージを購入したりすることはありません。

参考:

- https://developers.line.biz/en/docs/messaging-api/pricing/
- https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
- https://developers.line.biz/en/reference/messaging-api/#send-push-message

## 本番有効化の前提

- Stripe本番アカウントの本人確認、事業者情報、入金口座が完了
- 本番Product / Priceが上記の条件と一致
- 本番Webhook endpointと署名Secretを設定
- Cloudflare本番環境へSecretとPrice IDを設定
- D1マイグレーションを適用
- 特定商取引法表記、料金ページ、返金・解約導線を確認
- 少額の実決済、Webhook、利用枠付与、解約、返金を運営アカウントで確認
- 公開後の決済smokeとアラートを有効化

公開と検証の具体的手順は [本番運用](../operations/production-operations.md)、問い合わせ対応は [サポート手順](../operations/support-playbook.md) を参照してください。

## 変更時のテスト

- Priceの金額・通貨・周期が不一致ならCheckoutを拒否する
- 非販売の旧プランを新規購入できない
- Webhook再送で付与が重複しない
- 成功した動画保存だけが利用枠を消費する
- 解約後の有効期限と残数表示が一致する
- テスト環境と本番環境のStripeキーを混在させない
