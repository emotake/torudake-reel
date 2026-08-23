# アーキテクチャ

最終確認日: 2026-08-24

## 全体像

    利用者のブラウザ
      ├─ React / Vinext
      ├─ MediaBunny / Web Audio
      ├─ 動画・音声の抽出と分割
      └─ プレビューと動画書き出し
                │ HTTPS
                ▼
    Cloudflare Pages Functions（本番）
      ├─ 認証・セッション
      ├─ 利用枠・AI操作上限
      ├─ Stripe Checkout / Webhook
      └─ OpenAI APIのサーバー側呼び出し
                │
        ┌───────┼──────────┐
        ▼       ▼          ▼
       D1     OpenAI     Stripe / LINE

GitHub Actionsは、検証済みの同一成果物を試験環境から本番へ昇格します。アカウント削除の期限処理は専用のscheduled Workerが担当します。

## ブラウザの責務

- 動画・写真の選択と事前検証
- MOV/M4Vや大きな動画からの音声抽出・分割
- カット、テロップ、ナレーション、元動画音量のプレビュー
- 表紙候補の実フレーム抽出
- 動画のエンコードと保存

通常経路では動画素材自体を永続的なクラウドストレージへ保存しません。25MB以下の対応動画は直接処理し、それを超える動画やMOV/M4Vは端末内で音声を抽出・分割します。R2のMEDIA bindingは既定で宣言しません。

## Pages Functionsの責務

- LINE Loginとアプリ内セッション
- 操作予約、利用枠、完了記録
- 文字起こし、台本、音声生成の認可と中継
- AI操作回数のサーバー側制限
- Stripe Priceの検証とCheckout作成
- Webhook署名確認と冪等な課金状態更新
- アカウント設定、読み方辞書、編集設定の保存

OpenAIやStripeの秘密鍵をブラウザへ渡しません。

## データ

Cloudflare D1へ、アカウント、外部ID、セッション、料金状態、利用枠、操作予約、編集設定、削除予定を保存します。スキーマの正本は db/schema.ts、変更履歴は drizzle配下です。

映像・音声そのものは通常のD1保存対象ではありません。ログには秘密情報、トークン、顧客が入力した本文を不要に残さない方針です。

## ディレクトリ

| パス | 責務 |
| --- | --- |
| app | 画面とAPIルート |
| lib | 動画編集、字幕、利用枠、認証、課金の共通処理 |
| db/schema.ts | D1スキーマ |
| drizzle | 本番適用するD1マイグレーション |
| tests | セキュリティ、課金、字幕、プレビュー、書き出しの回帰テスト |
| scripts/operations | 公開、監視、復旧、運営用スクリプト |
| docs | 技術資料 |
| public | 公開画像、デモ素材、アイコン |

## 公開

1. GitHubへ変更をpushする。
2. CIでlint、テスト、ビルド、成果物検証を行う。
3. 試験用Pagesへ同じ成果物を公開し、smoke testを行う。
4. 手動承認後、成果物を変更せず本番へ昇格する。
5. 公開後の合成監視と決済smokeを確認する。

詳細と切り戻しは [本番運用](../operations/production-operations.md) を参照してください。

## 関連資料

- [機能仕様](../product/features.md)
- [認証・セキュリティ](../security/authentication.md)
- [Stripe課金](../billing/stripe.md)
- [災害復旧](../operations/disaster-recovery.md)
- [依存関係リスク台帳](../operations/dependency-risk-register.md)
