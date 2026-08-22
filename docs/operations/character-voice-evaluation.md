# キャラクター音声候補の評価手順

この手順は「ポップキャラクター」と「ハイテンショントーク」を、追加サービスなし・OpenAIの内蔵音声だけで選定するためのものです。評価準備と費用見積もりはローカル処理だけで完了し、OpenAI APIを呼びません。

## 決定済みの方向性

| 仕上がり | 候補 | 対照 | インパクトの作り方 |
| --- | --- | --- | --- |
| ポップキャラクター | `coral` / `shimmer` / `ballad` | `marin` | 不自然な高音や叫びではなく、語頭の立ち上がり・明るい抑揚・短い間 |
| ハイテンショントーク | `ash` / `verse` / `echo` | `cedar` | 常時早口にせず、重要語の強調・畳みかけ・オチ直前の間 |

実在人物、声優、既存キャラクターを模倣する調整は対象外です。

## トークンを抑える二段階評価

### 1. 絞り込み

全8音声を、違いを判定しやすい3台本・各1回だけで比較します。長音・促音・撥音、冒頭の引き、会話調のテンポと間を確認し、明らかに合わない候補を早い段階で外します。数字・日時・助数詞・英字・固有語・30秒長文は、選抜候補だけを使う最終確認で検査します。

```powershell
node scripts/operations/character-voice-evaluation.mjs --output D:\CodexTemp\torudake-voice-screening
```

このコマンドは採点票と費用見積もりを作るだけです。音声は生成しません。

### 2. 最終確認

各カテゴリで1候補に絞った後、候補と対照の合計4音声だけを、全10台本・各2回で確認します。

```powershell
node scripts/operations/character-voice-evaluation.mjs `
  --phase validation `
  --pop-finalist coral `
  --high-tension-finalist ash `
  --output D:\CodexTemp\torudake-voice-validation
```

候補名は絞り込み結果に置き換えます。最終確認を全候補で行わないことで、不要な再生成を避けます。

## 出力物

- `evaluator/blind-evaluation.csv`: 音声名を伏せた採点票
- `evaluator/reading-reference.csv`: 数字、固有語、長音などの正しい読み方
- `evaluator/guide.md`: 評価基準と採点方法
- `operator/sample-key.csv`: サンプルIDと内蔵音声名の対応表（評価者には渡さない）
- `cost-estimate.json`: 承認前に確認する乾式の費用見積もり

## 採点項目

自然さ、聞き取りやすさ、耳に残る度、インパクト、狙いとの一致、他候補との違いを1〜5で評価します。さらに、誤読、言葉の脱落、勝手な追加、語尾切れ、音割れ・歪みを個別に記録します。

評価は3人以上の日本語母語話者が望ましく、普段使うスマートフォンの本体スピーカーでも確認します。最終候補は平均点だけでなく、指定読みの誤りが0件であることを必須条件にします。

## 料金の考え方

見積もりは `gpt-realtime-2.1-mini` の公式料金を定数化しています。2026年8月23日時点で、テキスト入力は100万トークンあたり0.60米ドル、テキスト出力は2.40米ドル、音声出力は20.00米ドルです。アシスタント音声は約50ミリ秒あたり1トークンとして計算します。

- [OpenAI公式モデル料金](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)
- [OpenAI公式 Realtime APIの費用管理](https://developers.openai.com/api/docs/guides/realtime-costs)

為替、特殊トークン、出力尺の揺れに備えて、既定では15%の予備を加えています。これは承認用の概算であり、実額は実際に生成した際の `response.done` 利用量で確認します。

## 課金を発生させない安全策

評価パック作成プログラムには、API通信、音声生成、APIキー読み取りを実装していません。既定の乾式実行だけでなく、実行オプション自体が存在しないため、この準備工程から課金は発生しません。

実際の音声候補生成は、見積もりと上限額を確認してから別工程として行います。自動再試行や全候補の一括再生成は行わず、失敗時もまず原因を確認します。

## 生成済みポップ音声を無料で再比較する

既に生成・品質確認済みのポップ候補を、追加生成なしでブラインド評価パックへ組み直せます。元WAVを読み取り、SHA-256とWAV形式を検査し、評価用コピーだけを -22.5 LUFS、true peak -3 dBTP以下へローカル正規化して匿名名で保存します。元WAVは上書きしません。API、ネットワーク、APIキーは使用しません。

-22.5 LUFSは、今回の11本すべてをコンプレッサーやリミッターで変形せず、線形ゲインだけで同じ音量へ揃えられる値です。より大きい目標ではピークの鋭い候補だけがtrue peak上限に当たり、候補間の音量差が残るため採用しません。

取り込み前に、元生成結果の評価定義SHA-256が現在の評価定義と一致すること、各候補の出力トランスクリプトが台本と正規化一致していることを必須確認します。古い定義、未確認、または不一致の音声は評価へ混ぜずに停止します。

```powershell
pnpm ops:prepare-pop-voice-blind-pack -- `
  --source D:\CodexTemp\torudake-character-voice-screening-20260823-r2 `
  --output D:\CodexTemp\torudake-pop-voice-blind-evaluation-20260823-v3
```

出力先は必ず未作成の新しいフォルダーを指定します。同じ元データと同じ `--seed` なら、匿名IDと再生順を再現できます。

- `evaluator/index.html`: 音声プレイヤーと1〜5点の採点画面。入力結果をJSONでローカル保存できます。
- `evaluator/blind-evaluation.csv`: 表計算ソフト向け採点票。
- `evaluator/audio/`: 候補名を含まない匿名WAV。
- `operator/sample-key.csv`: 匿名IDと内蔵音声名、正規化前後のLUFS/true peakの対応表。採点完了まで評価者へ渡しません。
- `operator/pack-manifest.json`: 元マニフェストと正規化前後の各WAVのSHA-256、LUFS/true peak、並び順シード、欠けている組み合わせを記録します。

4候補すべてに同一台本がある比較を本判定とし、元の品質検査で除外された音声がある台本は「発音補助比較」として明確に分けます。欠けた音声を再生成して穴埋めしないため、追加料金は0円です。

## 課金を伴う一次試聴サンプルの生成

一次試聴だけを生成する専用コマンドは、乾式計画コマンドから分離しています。次の条件をすべて満たさない限り、OpenAIへ接続しません。

- 固定済みデータの SHA-256 と、24サンプルの一次選考計画が一致する
- `--execute` と確認句 `generate-24-character-voice-samples` が明示される
- 円建て上限が20円以下で、未生成の全サンプルを含む保守的な残額計算が上限内に収まる
- `OPENAI_API_KEY` がプロセス環境だけに渡される（ファイル、引数、結果JSONには保存しない）
- 出力先に同名WAVまたは既存の生成結果JSONがない

```powershell
pnpm ops:generate-character-voice-screening -- `
  --execute `
  --confirm generate-24-character-voice-samples `
  --budget-jpy 20 `
  --output D:\CodexTemp\torudake-character-voice-screening
```

各サンプルは別々のRealtimeセッションで順番に1回だけ生成します。自動再試行はありません。最初の通信・提供元エラー、利用量欠落、音声品質エラーで停止します。`response.done` の利用量が欠けた場合は、そのサンプルの予約上限を消費済みとして計上します。

音声は、想定尺の50%以上かつ想定尺+3秒以下、無音でないこと、クリッピングが閾値内であることを確認してからWAVへ保存します。APIが出力トランスクリプトを返した場合だけ、台本との正規化比較結果を記録します。返らなかった場合は「利用不可」と記録し、一致したとは扱いません。
