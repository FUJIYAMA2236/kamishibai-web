# Kamishibai

**書くことに集中できる、スライドツール。**
Markdown で内容を書くと、テーマに沿ってスライドが整います。見た目の調整は GUI で。発表・配布資料・.pptx / .odp への書き出しまで、1 つの原稿から。

![Kamishibai の編集画面。左にスライドのプレビュー、右に原稿](decks/demo/assets/screen-overview.jpg)

- **軽い** — デスクトップアプリは Tauri 製で、Windows では exe 1 本（約 6MB）。Node.js も Chrome も要りません
- **オフラインで動く** — ネット接続も、アカウント登録も不要
- **ファイルはあなたのもの** — 原稿はただのテキスト。フォルダのまま git で管理するのも、1 ファイル（.kami）で渡すのも自由

## 原稿を書くと、スライドになる

<table>
<tr>
<td width="46%">

```markdown
## 朝の 30 分プロジェクト

- 始業前に、1 日の段取りを決める
- 続けた人の **8 割** が「楽になった」
- 来月から、全社で試します

![朝日](assets/dawn.svg)
```

</td>
<td><img src="decks/demo/assets/example-slide.jpg" alt="上の原稿からできるスライド。左に見出しと箇条書き、右に画像"></td>
</tr>
</table>

見出し・箇条書き・画像を書くだけで、左右の配置などのレイアウトは自動で決まります。覚える記号は少しだけ:

| 原稿に書くこと | スライドでは |
| --- | --- |
| `# タイトル` | 表紙の大きな題 |
| `## 見出し` | 各スライドの見出し |
| `- 項目` | 箇条書き |
| `**強調**` | 太字 |
| `![説明](画像)` | 画像（ドラッグ＆ドロップや貼り付けでも入る） |
| `---` | ここで次のスライドへ |

記号が苦手でも、書式ボタンで同じことができます。書いた記号はその場で整形され、カーソルのある行にだけ表示されます。

## 主な機能

<table>
<tr>
<td width="50%"><img src="decks/demo/assets/screen-editor.jpg" alt="原稿エディタ"></td>
<td width="50%"><img src="decks/demo/assets/screen-design.jpg" alt="デザインパネルのテーマ選び"></td>
</tr>
<tr>
<td><b>書く</b> — 書きながら見た目に反映されるエディタ。書式ボタン、画像のドラッグ＆ドロップ、発表者ノート</td>
<td><b>整える</b> — 11 種類のテーマから選ぶだけで全スライドが揃う。色・フォント・余白・アニメーションはパネルで調整し、自分のテーマとして保存も。自作テーマの読み込み・書き出しにも対応</td>
</tr>
</table>

**テーマを変えても、原稿は 1 文字も変わりません。**

<p>
<img src="decks/demo/assets/theme-paper.jpg" width="32%" alt="Paper テーマ">
<img src="decks/demo/assets/theme-navy.jpg" width="32%" alt="Navy テーマ">
<img src="decks/demo/assets/theme-sakura.jpg" width="32%" alt="Sakura テーマ">
</p>

### 図形エディタ

工程図やブロック図を描いて、画像と同じようにスライドに置けます。図形の ● から線を引いてつなぎ、図形は好きな角度に回せて、写真も図の中に置けます。ダブルクリックでいつでも描き直せます。

![図形エディタ](decks/demo/assets/screen-diagram.jpg)

### 表エディタ・発表者ビュー・配布資料

<table>
<tr>
<td width="30%"><img src="decks/demo/assets/screen-table.jpg" alt="表エディタ"></td>
<td width="40%"><img src="decks/demo/assets/screen-presenter.jpg" alt="発表者ビュー"></td>
<td width="30%"><img src="decks/demo/assets/screen-handout.jpg" alt="配布資料"></td>
</tr>
<tr>
<td>表はセルに直接入力。<code>Tab</code> で次のセル</td>
<td>ノート・経過時間・次のスライドが手元にだけ出る（発表画面で <code>S</code>）</td>
<td>同じ原稿から、読み物形式の配布資料を作る</td>
</tr>
</table>

### そのほか

- **書き出し** — スライドは HTML（1 ファイルで発表できる）/ PDF / .pptx / .odp、配布資料は HTML / A4 の PDF / .docx / .odt。.pptx などは、書き出したあとも文字や図形を編集できる形で出ます
- **日本語がきれいに折り返る** — 言葉の途中で切らず、文節の切れ目で折り返します。短い文は行の長さもそろえます（.pptx / .odp に書き出しても同じ位置で改行）
- **図（mermaid 記法）** / コードの色付け / カラム（`|||` で区切る。横・縦・2 列の格子に並べ、枠線・塗り・カードの「箱」にも）/ 控えめなアニメーションと段階表示
- **設定** — 画面の文字の大きさ（`Ctrl` + `+` / `-` / `0`）、原稿の文字の大きさ、配色（OS に合わせる / ダーク / ライト）、起動時に前回のファイルを開く など

## 使う

**[Releases](https://github.com/FUJIYAMA2236/kamishibai/releases/latest) からダウンロードしてください**（Windows 10 / 11、64 ビット）。

- **インストーラー**（`Kamishibai_<版>_x64-setup.exe`）… おすすめ。インストールすると、`.kami` をダブルクリックで開けるようになります
- **インストール不要の exe**（`Kamishibai_<版>_x64_portable.exe`）… 置いた場所でそのまま起動できます

Windows 10 / 11 に入っている WebView2 を使います（無い PC ではインストーラーが自動で入れます）。

> 初回の起動時に「Windows によって PC が保護されました」と出たら、「詳細情報」→「実行」で起動できます（まだコード署名をしていないため）。
起動したら「サンプルを開く」で、Kamishibai 自身の紹介スライドを見られます。

決まった保存場所はありません。作る・開く・保存する場所は、毎回ダイアログで選びます。

| 形式 | 中身 | 向いている使い方 |
| --- | --- | --- |
| **フォルダ** | `slides.md`（原稿）・`deck.json`（見た目）・`assets/`（画像） | git で管理する、テキストエディタでも直す |
| **1 ファイル（.kami）** | 上のフォルダを zip にまとめたもの（使っている自作テーマも入る） | メール・チャットで渡す、USB で持ち運ぶ |

変更は自動で保存されます。左上のプロジェクト名を押すと、ファイルメニュー（新規作成 / 開く / 保存し直す / 閉じる）が開きます。

### 発表中のキー

`→` `Space` 次へ / `←` 前へ / `F` 全画面 / `S` 発表者ビュー / `O` 一覧 / `B` 暗転 / `数字 + Enter` ページ移動 / `?` ヘルプ

スライドは 1280×720 の固定サイズで作り、画面に合わせて拡大縮小するので、解像度が違っても崩れません。

### Markdown の書き方

上の表のほかに、発表者ノート（`???` から下）、カラム（`|||`、`::: columns` 〜 `:::`）、画像の大きさ（`{width=50%}`）、mermaid の図などが使えます。
詳しくは [docs/MARKDOWN.md](docs/MARKDOWN.md) を見てください。

### テーマを自作する

テーマは `theme.json`（色・フォント・余白などの値）と `theme.css`（飾り）だけのフォルダです。GUI で調整して保存するほか、
ファイルを書いて「デザイン」→「テーマ」→「自作テーマを読み込む」で読み込めます。zip に書き出して人に渡すこともできます。
作り方は [docs/THEMES.md](docs/THEMES.md)、書ける項目のすべては [docs/THEME_REFERENCE.md](docs/THEME_REFERENCE.md) にあります
（`theme.json` 用の JSON Schema: [docs/theme.schema.json](docs/theme.schema.json)）。

## ソースから作る

アプリ本体は **Rust（[Tauri](https://tauri.app/)）** でビルドします。**Node.js** は、その準備（画面のファイルを集める・Tauri の CLI を動かす）とテストに使います。
どちらもビルドする人だけに必要で、アプリを使う人には要りません。

| 必要なもの | 何に使うか |
| --- | --- |
| [Rust](https://www.rust-lang.org/) と [Tauri の前提ツール](https://tauri.app/start/prerequisites/)（Windows なら Microsoft C++ Build Tools など） | アプリ本体（exe）のコンパイル |
| [Node.js](https://nodejs.org/) 18 以上 | Tauri の CLI・画面のファイルの準備・テスト・ブラウザ版 |

```bash
npm install        # 初回のみ（Tauri の CLI などの開発用ツールを入れる）
npm run app        # 開発用にアプリを起動（tauri dev）
npm run dist       # 配布用を作る（tauri build）→ src-tauri/target/release/ に exe、bundle/nsis/ にインストーラー
npm test           # テスト
```

`npm run dist` の中では、次の順に動きます。

1. `scripts/prepare-app.js`（Node.js）が、画面のファイル（HTML・JS・テーマ・サンプル）を `app-dist/` に集める
2. Tauri の CLI が `cargo build --release` を呼び、Rust がアプリ本体をコンパイルする（`app-dist/` の中身は exe に埋め込まれる）
3. Tauri の CLI がインストーラー（NSIS）を作る

macOS / Linux 向けは、その OS で `npm run dist` を実行すると作れます（GitHub Actions の設定: [.github/workflows/build.yml](.github/workflows/build.yml)。PDF の書き出しは今のところ Windows のみ）。

`npm install` をしなくても、`node bin/kamishibai.js serve [<プロジェクト>]` でブラウザから使えます（画面のライブラリは `vendor/` に同梱）。
コマンドラインからの書き出しや .kami の作成・展開もできます:

```bash
node bin/kamishibai.js build 発表資料/ --no-embed   # フォルダのプロジェクトをスライド HTML に（画像はフォルダ参照）
node bin/kamishibai.js doc 発表.kami --pdf --notes   # .kami から資料 PDF（ノート付き）
node bin/kamishibai.js pack 発表資料/ 発表.kami      # フォルダを 1 ファイルにまとめる
node bin/kamishibai.js help
```

`decks/demo/` がサンプルのプロジェクト（アプリの「サンプルを開く」の中身）、`themes/` が同梱のテーマです。

## セキュリティ

受け取った .kami や原稿を開いても、パソコンのファイルを読み書きされたり、スクリプトを動かされたりしないように作っています。
考え方と、脆弱性の報告のしかたは [SECURITY.md](SECURITY.md) を見てください。

## ライセンス

Kamishibai は [MIT License](LICENSE) です。

含まれているオープンソースのソフトウェア（画面で使う markdown-it・mermaid・highlight.js・CodeMirror と、アプリ本体の Tauri などの Rust のクレート）の
ライセンスと本文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にまとめています（アプリの「設定」→「ライセンス」でも見られます）。
いずれも商用利用ができるライセンスです。ほとんどが MIT / Apache-2.0 で、コピーレフトのものはファイル単位の MPL-2.0・EPL-2.0（変更せずに使用）だけなので、Kamishibai 自身の MIT ライセンスには影響しません。
