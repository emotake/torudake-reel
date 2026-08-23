# Codex解約後の運用と復旧

最終確認日: 2026-08-24

## 結論

Codexは開発支援にだけ使用し、本番サービスの実行、ソースコード、利用者データ、
決済、認証、秘密情報の正本にはしません。Codexの契約を終了しても、Cloudflare、
GitHub、Stripe、OpenAI API、LINE Developersの各契約と所有者アカウントが継続して
いれば、公開サイトはそのまま動作します。

Codexのタスク履歴や添付ファイルを復旧元として扱いません。

## Codex外部にある正本

| 対象 | 正本 |
| --- | --- |
| ソース、テスト、DBマイグレーション | GitHub `emotake/torudake-reel` |
| 復旧台帳、暗号化秘密情報 | 非公開GitHub `emotake/torudake-reel-recovery` |
| 本番アプリ、実行時Secret | Cloudflare Pages `torudake-reel` |
| 利用者、利用枠、決済台帳 | Cloudflare D1 `torudake-reel-db` |
| 長期データバックアップ | OneDriveのage暗号化D1エクスポート |
| age復号鍵 | WindowsのSOPS age保管先と、利用者が管理する外部保管先 |
| 決済情報 | Stripe本番アカウント |
| AI利用資格 | OpenAI APIプロジェクト |
| ログイン設定 | LINE Developersチャネル |

APIキー、Webhook Secret、利用者データをNotionや公開GitHubへ転記しません。

## 解約前後に行う確認

1. GitHubで両リポジトリへログインできることを確認します。
2. Cloudflare、Stripe、OpenAI Platform、LINE Developersへ2要素認証でログインできる
   ことを確認します。
3. 非公開復旧リポジトリをcloneし、次を実行します。

   ```powershell
   node scripts/verify-recovery.mjs --scope codex-cancellation
   ```

4. `OK: Codex解約後の継続運用に必要な外部資産を確認しました` と表示されることを
   確認します。
5. age秘密鍵は、Codex、公開GitHub、暗号化バックアップと同じ場所だけに置かず、
   パスワード管理アプリまたは暗号化USBにも保管します。

## Codexを使わず変更・公開する方法

1. GitHub Desktopまたは`git clone`でソースを取得します。
2. Node.js 22とpnpm 11を導入します。
3. `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test`を実行します。
4. GitHubへpushするとCIと隔離Pagesプレビューが動きます。
5. 本番公開はGitHub Actionsの`Deploy Production`を手動実行し、現在のmainの
   40文字commit SHAを入力します。

本番workflowはCloudflareトークンをGitHubの`production` Environment Secretから
受け取り、Cloudflare Pagesの実行時Secretを読み戻さずに既存設定を維持します。

## D1復旧

暗号化バックアップの復元検査は、ソースリポジトリから次を実行します。

```powershell
./scripts/operations/restore-drill.ps1 `
  -EncryptedBackup "<OneDrive上の.sql.age>" `
  -AgeIdentity "$env:APPDATA\sops\age\keys.txt" `
  -SqliteExecutable "<sqlite3.exeのパス。PATH設定済みなら省略可>"
```

検査はローカルSQLiteだけを使用し、本番D1へ書き込みません。復号したSQLと検査用
SQLiteは終了時に削除され、結果JSONだけが残ります。

## 復旧範囲の違い

`codex-cancellation`は、GitHubと各提供元アカウントが存続する前提です。
Cloudflareを含む提供元アカウントまで完全に失った場合は、非公開復旧庫で次を実行し、
全Secretとサービス識別子が回収済みであることを別途確認します。

```powershell
node scripts/verify-recovery.mjs --scope full-provider-loss
```

この検査が失敗している間は、提供元アカウントまで失う災害からの完全復旧は保証しません。
