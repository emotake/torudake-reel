# 認知施策パイロット（2026年9月）

## 目的

「機能が多い動画編集サービス」ではなく、**撮った素材はあるのに、編集が面倒で投稿できない状態を前へ進めるサービス**として認知されるかを45日間で検証する。

有料広告は使わない。公式Instagram ReelsとYouTube Shortsへ同じ6素材を出し、媒体・用途・冒頭コピー別に、サイト内の無料プレビューまで進んだ割合を比較する。

## UTM命名

- `utm_source`: `instagram` / `youtube`
- `utm_medium`: `organic_social`
- `utm_campaign`: `recognition_202609`
- `utm_content`: `{用途}_{コピー}`
- 用途: `daily` / `talking` / `shop`
- コピー: `a` / `b`

自由入力値は計測しない。サイトは上記の定義済み値だけを45日間、端末内へ保存し、匿名の操作イベントへ付与する。

## 6本の配信表

| ID | 用途 | 冒頭コピー | 遷移先 | Instagram用URL | YouTube用URL |
| --- | --- | --- | --- | --- | --- |
| daily_a | 日常・お出かけ | 撮ったのに、編集が面倒でまだ投稿していない。 | `/use-cases/daily-moments` | `https://torudake-reel.pages.dev/use-cases/daily-moments?utm_source=instagram&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=daily_a` | `https://torudake-reel.pages.dev/use-cases/daily-moments?utm_source=youtube&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=daily_a` |
| daily_b | 日常・お出かけ | カメラロールで眠る景色を、投稿できる1本へ。 | `/use-cases/daily-moments` | `https://torudake-reel.pages.dev/use-cases/daily-moments?utm_source=instagram&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=daily_b` | `https://torudake-reel.pages.dev/use-cases/daily-moments?utm_source=youtube&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=daily_b` |
| talking_a | 会話・解説 | 字幕を付けるだけで、投稿が今日も後回し。 | `/use-cases/talking-video` | `https://torudake-reel.pages.dev/use-cases/talking-video?utm_source=instagram&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=talking_a` | `https://torudake-reel.pages.dev/use-cases/talking-video?utm_source=youtube&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=talking_a` |
| talking_b | 会話・解説 | 話した内容はそのまま。見やすさだけ整える。 | `/use-cases/talking-video` | `https://torudake-reel.pages.dev/use-cases/talking-video?utm_source=instagram&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=talking_b` | `https://torudake-reel.pages.dev/use-cases/talking-video?utm_source=youtube&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=talking_b` |
| shop_a | 商品・お店紹介 | 紹介したいのに、並べ方で投稿が止まる。 | `/use-cases/shop-introduction` | `https://torudake-reel.pages.dev/use-cases/shop-introduction?utm_source=instagram&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=shop_a` | `https://torudake-reel.pages.dev/use-cases/shop-introduction?utm_source=youtube&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=shop_a` |
| shop_b | 商品・お店紹介 | 外観も店内も商品も。撮った順番から1本へ。 | `/use-cases/shop-introduction` | `https://torudake-reel.pages.dev/use-cases/shop-introduction?utm_source=instagram&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=shop_b` | `https://torudake-reel.pages.dev/use-cases/shop-introduction?utm_source=youtube&utm_medium=organic_social&utm_campaign=recognition_202609&utm_content=shop_b` |

## 流入別ファネル

運営専用画面で、媒体×投稿素材ごとに次を表示する。

1. `acquisition_landing`: UTM付きページへ着地した匿名端末
2. `video_selected` / `demo_started`: 動画選択またはサンプル体験を開始
3. `preview_completed`: 無料プレビューが完成
4. `checkout_started`: 購入手続きへ進んだ
5. `export_completed`: 書き出しが完了

主指標は `preview_completed ÷ acquisition_landing`。認知施策であっても、再生数だけでなく「自分の素材で試したい」と思われたかを優先する。

## 配信順

- 1週目: daily_a / talking_a / shop_a
- 2週目: daily_b / talking_b / shop_b
- InstagramとYouTubeは同日・近い時刻に配信し、媒体差以外の条件をそろえる
- 投稿文とハッシュタグは用途内で共通にし、最初の1文だけA/Bで変える
- 有料広告、インフルエンサー起用、景品はこの試作に含めない

## 投稿文案

投稿文は用途ごとに固定し、動画内の冒頭コピーだけをA/Bする。これにより、計測結果をコピー差として比較しやすくする。

### 日常・お出かけ

撮った景色が、編集を後回しにしたままカメラロールで眠っていませんか。撮るだけリールなら、使いたい場面と仕上げ方を選び、投稿できる1本まで進められます。プロフィールのリンクから無料で仕上がりを確認できます。

`#撮るだけリール #動画編集 #リール編集 #YouTubeショート #日常動画`

### 会話・解説

話した動画はあるのに、字幕起こしや不要部分の確認で止まってしまう人へ。文字と使う発話を確認しながら、見やすいショート動画へ整えられます。プロフィールのリンクから無料で仕上がりを確認できます。

`#撮るだけリール #自動テロップ #動画字幕 #リール編集 #YouTubeショート`

### 商品・お店紹介

外観、店内、商品を撮ったあと、並べ方で迷って投稿できない人へ。素材の順番を確認しながら、紹介に使える縦型動画へまとめられます。プロフィールのリンクから無料で仕上がりを確認できます。

`#撮るだけリール #店舗紹介 #商品紹介 #ショート動画 #SNS運用`

## Search Console確認

1. `https://torudake-reel.pages.dev/sitemap.xml` が「成功」になっているか確認
2. URL検査で次の4URLを確認
   - `/`
   - `/use-cases/daily-moments`
   - `/use-cases/talking-video`
   - `/use-cases/shop-introduction`
3. 「URLはGoogleに登録されています」になっていなければ、公開後にインデックス登録をリクエスト
4. 7日後と21日後に「ページのインデックス登録」と「動画ページ」を再確認

## 45日後に残す上位2テーマ

- 各テーマ30着地未満: 勝敗を決めず継続して母数を増やす
- 30着地以上: 主指標のプレビュー完了率で順位付け
- 差が3ポイント以内: サイト側の購入開始率、次に各SNSの3秒視聴率で判定
- 上位2テーマ: 新しい冒頭コピーを1本ずつ追加
- 最下位テーマ: 削除せず用途ページは残し、SNS投稿の追加制作だけ止める

## 公開前に必要な設定

- `NEXT_PUBLIC_INSTAGRAM_URL`: `https://www.instagram.com/torudake_reel/`（設定済み）
- `NEXT_PUBLIC_YOUTUBE_URL`: 公式YouTubeチャンネルのHTTPS URL

Instagramはソースコードにも公開既定値を保持し、環境を復旧した直後からフッターとOrganization構造化データの`sameAs`へ反映する。YouTubeは設定すると同じ2か所へ反映され、未設定時は誤ったリンクを出さない。
