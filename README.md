# CEDEC 2026 講演検索（非公式）

CEDEC 2026 のセッションをスマホで探すための非公式ビューアです。
片手で操作でき、電波の弱い会場でもオフラインで開けます。

**公開ページ**: https://dandymania.github.io/cedec-timetable/

## できること

- **話し言葉で検索** — 「AIで開発を効率化する話」のような文でも探せます。
  タイトル・説明・受講して得られるもの・登壇者・所属会社・キーワードが対象です。
  「サイゲ」「バンナム」「スクエニ」のような略称、「描画 / レンダリング」のような
  言い換えにも辞書で対応しています。
- **オフライン対応** — 一度開けば、圏外でも表示できます。
  ホーム画面に追加するとアプリのように起動します。
- **リスト表示と表表示** — 時系列のリストと、会場 × 時刻のタイムテーブルを切り替えられます。
  当日は「今やってる講演へ」で現在時刻に飛べます。
- **マイプラン** — ★を押した講演だけをまとめて見られます（端末内に保存され、外部には送りません）。
- **絞り込み** — カテゴリ・会場・キーワードタグ。

## データについて

セッション情報は CEDEC 2026 公式が配布している JSON を取り込んでいます。

- 出典: `https://stat.cedec.cesa.or.jp/download/2026/cedec_schedule.json`
- 会場（部屋番号）は公式 JSON に含まれないため、
  [CEDEC非公式タイムテーブル](https://kazunori-toybox.com/cedec_schedule/) のデータを利用しています。
- GitHub Actions が 2 時間おきに取り直し、変更があれば自動で反映します。

公式の最新情報は [CEDEC 2026 公式サイト](https://cedec.cesa.or.jp/2026/) を確認してください。
本サイトは有志による非公式なものであり、CESA / CEDEC 運営委員会とは関係ありません。

## 開発

ビルドは不要です。素の HTML / CSS / JavaScript のみで動きます。

```sh
node scripts/fetch-data.mjs   # 公式 JSON を取り込んで data/ を更新
node scripts/serve.mjs        # http://localhost:8787/ で確認
```

`node scripts/fetch-data.mjs --no-room` で会場データのマージを省けます。

ローカル（localhost）では Service Worker を登録しません。編集が古いキャッシュに
隠れるのを避けるためです。オフライン動作を確認したいときは `?sw` を付けてアクセスしてください。

### ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` / `app.css` | 画面 |
| `app.js` | 表示・絞り込み・マイプラン・詳細 |
| `search.js` | 検索（正規化・同義語・スコアリング） |
| `sw.js` | オフライン用 Service Worker |
| `data/sessions.json` | 正規化済みのセッション |
| `data/meta.json` | 日別件数・カテゴリ・会場などの索引 |
| `scripts/fetch-data.mjs` | データ取り込み |
| `scripts/serve.mjs` | ローカル確認用の簡易サーバ |
