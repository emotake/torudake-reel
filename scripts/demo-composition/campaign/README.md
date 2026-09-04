# 認知施策用 3用途×2コピー

既存素材だけで制作する、追加API料金のない10.4秒・9:16の試作テンプレートです。

- `daily-a` / `daily-b`: 日常・お出かけ
- `talking-a` / `talking-b`: 会話・解説
- `shop-a` / `shop-b`: 商品・お店紹介

`rows.json`で冒頭コピーだけをA/Bし、本文・CTA・尺・レイアウトは固定します。これにより、コピー以外の差を最小化します。

公開用のUTMと判定方法は`docs/growth/recognition-pilot-2026-09.md`を正本とします。

## 再書き出し

FFmpegをPATHへ追加したうえで、このディレクトリから実行します。

```powershell
pnpm dlx hyperframes render --batch rows.json --output "../../../public/campaign/recognition-202609/{name}.mp4" --batch-concurrency 1 --batch-fail-fast --strict-variables --quality high --fps 30 --json
```

出力はH.264、1080×1920、30fps、10.4秒です。`manifest.json`は端末上の絶対パスを含むため、生成結果の確認後に削除し、GitHubへは保存しません。
