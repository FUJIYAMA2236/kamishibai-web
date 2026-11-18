/*
 * build-web.js — Web 版（Cloudflare Pages などの静的ホスティング）のファイルを web-dist/ にそろえる。
 *   node scripts/build-web.js   （npm run build:web）
 *
 * 中身はデスクトップアプリ（prepare-app.js の app-dist/）とほぼ同じ。違いは:
 *   ・index.html に app/web-host.js を足す（裏側の処理を画面の中で動かし、ファイルはブラウザの中に置く）
 *   ・_headers（CSP など。Cloudflare Pages / Netlify が読む）と 404.html（SPA 扱いにさせない）を置く
 *
 * Cloudflare Pages の設定: ビルドコマンド `node scripts/build-web.js`、出力ディレクトリ `web-dist`
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { removeDir } = require('../src/node/fsutil');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, process.argv[2] || 'web-dist');

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip && skip(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, skip);
    else fs.copyFileSync(a, b);
  }
}
function tree(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) out[e.name] = e.isDirectory() ? tree(path.join(dir, e.name)) : null;
  return out;
}

removeDir(OUT);
fs.mkdirSync(OUT, { recursive: true });
const skipDist = (n) => n === 'dist' || n.startsWith('.');
copyDir(path.join(ROOT, 'src', 'editor'), path.join(OUT, 'editor'), (n) => n === 'index.html');
copyDir(path.join(ROOT, 'src', 'core'), path.join(OUT, 'core'));
copyDir(path.join(ROOT, 'src', 'runtime'), path.join(OUT, 'runtime'));
copyDir(path.join(ROOT, 'src', 'app'), path.join(OUT, 'app'), (n) => n === 'tauri-host.js');
copyDir(path.join(ROOT, 'vendor'), path.join(OUT, 'vendor'));
copyDir(path.join(ROOT, 'themes'), path.join(OUT, 'themes'));
copyDir(path.join(ROOT, 'decks', 'demo'), path.join(OUT, 'sample'), skipDist);
fs.mkdirSync(path.join(OUT, 'legal'), { recursive: true });
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, 'legal', f));
fs.writeFileSync(path.join(OUT, 'bundle.json'), JSON.stringify({ themes: tree(path.join(OUT, 'themes')), sample: tree(path.join(OUT, 'sample')) }));

// index.html: tauri-host.js の代わりに web-host.js を読む
let html = fs.readFileSync(path.join(ROOT, 'src', 'editor', 'index.html'), 'utf8');
const tauri = '<script src="/app/tauri-host.js"></script>';
if (html.indexOf(tauri) < 0) throw new Error('index.html に tauri-host.js の読み込みが見つかりません');
html = html.replace(tauri, '<script src="/app/web-host.js"></script>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// 発表・資料・印刷のウィンドウ（app/viewer.js がエディタから HTML を受け取って書き込む）
fs.mkdirSync(path.join(OUT, 'viewer'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'viewer', 'index.html'), '<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><title>Kamishibai</title></head>\n<body><script src="/app/viewer.js"></script></body></html>\n');

fs.writeFileSync(path.join(OUT, '404.html'), '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found</p>\n');

// エディタの CSP（Node のサーバー版 server.js の EDITOR_CSP と同じ考え方。blob: は画像・発表ウィンドウ・書き出しに使う）
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');
fs.writeFileSync(path.join(OUT, '_headers'), [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  Cache-Control: no-cache',
  '',
  '/',
  '  Content-Security-Policy: ' + CSP,
  '/index.html',
  '  Content-Security-Policy: ' + CSP,
  '',
  // 同梱のサンプル・テーマの画像などは、ページとして開かれてもスクリプトを動かさない
  '/sample/*',
  "  Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  '/themes/*',
  "  Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  '',
].join('\n'));

console.log(path.relative(ROOT, OUT) + '/ を用意しました（Cloudflare Pages の出力ディレクトリに指定してください）');
