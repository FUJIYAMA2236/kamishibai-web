# Kamishibai Web 版（kamishibai-web）

このリポジトリは、デスクトップアプリ版 [FUJIYAMA2236/kamishibai](https://github.com/FUJIYAMA2236/kamishibai) から分かれた **Web 版**（Cloudflare Pages などで公開する静的サイト）です。
使い方・しくみは [docs/WEB.md](docs/WEB.md) を参照。

## 本流（デスクトップ版）との関係

- 分岐点: 本流の `217cba2`（0.4.1「セキュリティ修正: 受け取った .kami を開くだけで…」）。それ以前の履歴は本流と共通
- エディタ・描画・書き出しなどのコード（`src/core/`・`src/editor/`・`src/runtime/`・`src/app/backend.js`・`themes/`・`vendor/`）は本流と同じものを使う
- Web 版だけの仕様: **.kami のみ対応**（フォルダ形式のプロジェクトは作る・開く・保存するのどれも出さない）

### Web 版で足したファイル（本流には無い）

| ファイル | 役目 |
| --- | --- |
| `src/app/web-host.js` | `tauri-host.js` の代わり。backend.js を画面の中で動かし、ファイルはブラウザの中（メモリ + IndexedDB）に置く。File System Access API があれば手元の .kami に書き戻す。タブの排他・ドラッグ＆ドロップ・PWA の起動も |
| `src/app/viewer.js` | 発表・資料・印刷のウィンドウ（`/viewer/`）。組み立てた HTML をエディタから受け取って表示する |
| `src/app/sw.js` | サービスワーカー（オフライン対応）。ビルドで `/sw.js` になる |
| `scripts/build-web.js` | `web-dist/` を作る（`npm run build:web`）。index.html の tauri-host.js を web-host.js に差し替え、`_headers`・manifest・sw.js などを置く |
| `docs/WEB.md` | Web 版の説明 |

### 本流のファイルへの変更（同期のときに注意）

`src/editor/editor.js` だけ。どれも `window.KSWeb`（web-host.js が立てる）のときだけ働き、デスクトップ版の動作は変えない:

- `exportDialog()` … Web 版用の完了メッセージ（印刷ダイアログ / ダウンロード / 選んだファイルに保存）
- `renderThemeTab()` … 「テーマのフォルダを開く」ボタンを出さない
- `loadProject()` … ファイルメニューの保存場所の表示（中のパス `/local/…` を見せない）
- `showStart()` … スタート画面は「新規作成（.kami）」「ファイルを開く」「サンプル」だけ。最近使ったものの表示に `r.label` を使う
- `initFileMenu()` … フォルダの項目（新規作成・開く・保存）と「保存場所を表示」を出さない

ほかに `package.json`（`build:web` スクリプト）と `.gitignore`（`web-dist/`）。

## 本流の変更を取り込むとき

```
git remote add upstream https://github.com/FUJIYAMA2236/kamishibai.git
git fetch upstream
git merge upstream/main
npm test && npm run build:web
```

取り込み済みの本流: `714726d`（エディタの UI の見直し: 挿入メニュー・文字の大きさ・保存先の表示・テーマ一覧など。editor.js の「最近使ったもの」は Web 版の r.label を優先し、無ければ shortPlace。2026-11-26）
直前: `ff8bc57`（0.5.1。2026-11-23）

本流で次のものが変わったら、Web 版側も合わせて直すこと:

- **backend.js の host の約束**（`readFile` / `writeFile` / `stat` / `bundled` / `zip` など）や **API**（`/api/…`）… `web-host.js` の host / `api()`
- **tauri-host.js の `window.KSDesktop` / `window.kamishibaiApp` の窓口**（関数が増えた・名前が変わった）… `web-host.js` にも同じものを用意する
- **index.html の `<script src="/app/tauri-host.js">`** … `build-web.js` がこの行を目印に差し替えるので、書き方を変えたら合わせる
- **prepare-app.js で app-dist/ に入れるもの**（同梱ファイルの置き場所）… `build-web.js` も同じにする
- **editor.js の上の 5 か所** … 衝突しやすい。`window.KSWeb` の分岐を残すこと
