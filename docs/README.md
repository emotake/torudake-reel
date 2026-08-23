# 技術ドキュメント

撮るだけリールの詳細な技術情報を管理する入口です。

## 管理原則

- 技術情報の正本はGitHubです。
- ルートREADMEはポートフォリオと全体像に限定します。
- 実装、運用、認証、課金、復旧の詳細はこのdocs配下で版管理します。
- Notionは必要になった時点で企画・顧客視点のメモに使い、技術仕様の正本にはしません。
- 実装に影響する変更は、コードと同じPull Requestまたはコミットで資料も更新します。
- APIキー、決済secret、利用者データはGitHubにもNotionにも保存しません。

詳しい境界は [ドキュメント管理方針](documentation-policy.md) を参照してください。

## プロダクト

- [機能仕様](product/features.md) — 入力、編集モード、テロップ、書き出し、現在の制約
- [AIナレーション](product/ai-narration.md) — 声、読み方修正、生成処理、原価制御、切り戻し

## アーキテクチャ

- [システム概要](architecture/overview.md) — ブラウザ、Pages Functions、D1、外部サービスの責務

## セキュリティと課金

- [認証・セキュリティ](security/authentication.md) — LINE Login、セッション、Passkey方針、秘密情報
- [Stripe課金](billing/stripe.md) — 販売プラン、利用枠、Checkout、Webhook

## 運用

- [本番運用](operations/production-operations.md) — 公開、検証、監視、切り戻し
- [災害復旧](operations/disaster-recovery.md) — 復旧対象、秘密情報、復元確認
- [Codex解約後の運用と復旧](operations/codex-independent-recovery.md) — Codexに依存しない正本、公開、D1復元
- [アカウント復旧](operations/account-recovery.md) — 利用者対応と本人確認
- [サポート手順](operations/support-playbook.md) — 問い合わせ対応
- [LINE認証の可観測性](operations/line-auth-observability.md) — 監視指標と調査手順
- [プロバイダー利用状況](operations/provider-usage.md) — 外部サービスとデータ境界
- [依存関係リスク台帳](operations/dependency-risk-register.md) — 更新方針と既知リスク
- [キャラクター音声評価](operations/character-voice-evaluation.md) — 候補生成、評価、費用上限
- [D1マイグレーション台帳](operations/2026-08-13-d1-ledger-baseline.md) — 適用履歴の基準

## 更新時の確認

1. 実装と資料の説明が一致しているか。
2. 公開停止中または未実装の機能を提供中と書いていないか。
3. 環境変数名だけを記載し、値や個人情報を含めていないか。
4. READMEから詳細へ到達でき、詳細から関連する運用手順へ移動できるか。
5. ローカルリンクとコマンドが現在のリポジトリで有効か。
