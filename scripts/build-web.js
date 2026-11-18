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
// PWA（インストール・.kami のダブルクリックで開く）
html = html.replace('</head>', '<link rel="manifest" href="/manifest.webmanifest">\n<meta name="theme-color" content="#151824">\n<link rel="apple-touch-icon" href="/icons/icon-256.png">\n</head>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), path.join(OUT, 'icons', 'icon-512.png'));
fs.copyFileSync(path.join(ROOT, 'src-tauri', 'icons', '128x128@2x.png'), path.join(OUT, 'icons', 'icon-256.png'));
const version = require('../package.json').version;
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify({
  name: 'Kamishibai',
  short_name: 'Kamishibai',
  description: 'Markdown で書いて GUI で整える、HTML スライド作成ツール',
  lang: 'ja',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#151824',
  theme_color: '#151824',
  icons: [
    { src: '/icons/icon-256.png', sizes: '256x256', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  // インストールしたアプリで .kami を開けるようにする（Chrome / Edge。web-host.js の launchQueue）
  file_handlers: [{ action: '/', accept: { 'application/x-kamishibai': ['.kami'] }, icons: [{ src: '/icons/icon-256.png', sizes: '256x256', type: 'image/png' }] }],
  launch_handler: { client_mode: 'focus-existing' },
}, null, 2));

// 発表・資料・印刷のウィンドウ（app/viewer.js がエディタから HTML を受け取って書き込む）
fs.mkdirSync(path.join(OUT, 'viewer'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'viewer', 'index.html'), '<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><title>Kamishibai</title></head>\n<body><script src="/app/viewer.js"></script></body></html>\n');

// サービスワーカー（オフラインで動くように、全ファイルを手元に持つ）。中身が変わると名前（CACHE）が変わり、古いものは消える
function listFiles(dir, prefix, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '_headers') continue;
    if (e.isDirectory()) listFiles(path.join(dir, e.name), prefix + e.name + '/', out);
    else out.push(prefix + e.name);
  }
  return out;
}
const swSource = fs.readFileSync(path.join(OUT, 'app', 'sw.js'), 'utf8');
fs.rmSync(path.join(OUT, 'app', 'sw.js')); // ルート（/sw.js）に置く
const precache = listFiles(OUT, '/', []).map((f) => (f === '/index.html' ? '/' : f.endsWith('/index.html') ? f.slice(0, -'index.html'.length) : f));
const hash = require('crypto').createHash('sha256');
for (const f of listFiles(OUT, '', []).sort()) hash.update(f).update(fs.readFileSync(path.join(OUT, f)));
fs.writeFileSync(path.join(OUT, 'sw.js'), swSource
  .replace("'__CACHE__'", JSON.stringify('kamishibai-' + version + '-' + hash.digest('hex').slice(0, 12)))
  .replace('[] /* __FILES__ */', JSON.stringify(precache)));

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
  '',
  // ライブラリは大きく、めったに変わらないので 1 日はキャッシュする（新しい版はサービスワーカーの入れ替えでも届く）
  '/vendor/*',
  '  Cache-Control: public, max-age=86400',
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
