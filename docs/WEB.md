# Web 版（Cloudflare Pages で公開する）

デスクトップアプリと同じエディタを、静的なファイル（HTML / JavaScript）だけで動かす版です。サーバー側の処理はありません。

## ビルドと公開

```
node scripts/build-web.js      # → web-dist/
```

Cloudflare Pages（Git 連携）の設定:

| 項目 | 値 |
| --- | --- |
| フレームワーク | なし |
| ビルドコマンド | `node scripts/build-web.js` |
| ビルド出力ディレクトリ | `web-dist` |

手元から直接上げる場合は `npx wrangler pages deploy web-dist`。

## しくみ

- `src/app/web-host.js` が、デスクトップ版の `tauri-host.js` の代わりに裏側（`backend.js`）を画面の中で動かす。ファイルはブラウザの中（メモリ + IndexedDB）に置く
- 扱うのは .kami だけ（フォルダの形のプロジェクトは、作る・開く・保存するのどれも出さない。デスクトップ版で使う）
- Chrome / Edge（File System Access API あり）: 開いた .kami に直接書き戻す。保存・書き出しは保存先を選ぶダイアログ
- Firefox / Safari: 開く = アップロード、保存・書き出し = ダウンロード。作業中の内容はブラウザの中に自動保存（手元のファイルには反映されない）
- 発表・資料のプレビューは `/viewer/`（`src/app/viewer.js`）が組み立てた HTML を受け取って表示する
- PDF は印刷ダイアログ（「PDF に保存」）で作る
- HTML の書き出しは常に画像を埋め込む（`_files` フォルダは作らない）
- `_headers` でエディタに CSP を付ける
