// バックエンド（src/app/backend.js）を Node の上で動かすテスト（プロジェクト・.kami・書き出し・サーバー）。
// デスクトップアプリ（Tauri）も同じバックエンドを使うので、ここで裏側の動きを確かめる。一時フォルダだけを使う。実行: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ユーザーの設定（最近使ったもの・テーマ）を本物の %APPDATA% に書かないよう、先に差し替える
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kamishibai-userdata-'));
process.env.KAMISHIBAI_USERDATA = USERDATA;

const { createBackend } = require('../src/app/backend');
const P = require('../src/app/pathx');
const { createNodeHost, TOOL_ROOT } = require('../src/node/host');
const { writeZip, readZip } = require('../src/node/zip');
const { createServer, listen } = require('../src/node/server');
const { removeDir, removeFile } = require('../src/node/fsutil');

const PNG_1PX_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_1PX = new Uint8Array(Buffer.from(PNG_1PX_B64, 'base64'));
const userThemes = path.join(USERDATA, 'themes');
test.after(() => removeDir(USERDATA));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kamishibai-test-'));
  t.after(() => removeDir(dir));
  return dir;
}
function newBackend(t) {
  return createBackend(createNodeHost(), {
    workRoot: path.join(tempDir(t), 'work'),
    markdownit: require(path.join(TOOL_ROOT, 'vendor', 'markdown-it.min.js')),
    hljs: require(path.join(TOOL_ROOT, 'vendor', 'highlight.min.js')),
  });
}
async function newProject(t, name) {
  const b = newBackend(t);
  const p = await b.createFolder(path.join(tempDir(t), name || 'talk'), { title: 'テスト発表' });
  return { b, p };
}

test('pathx: Windows と POSIX のパス', () => {
  assert.equal(P.join('C:\\a\\b', '..', 'c.txt'), 'C:\\a\\c.txt');
  assert.equal(P.join('/a/b', 'c'), '/a/b/c');
  assert.equal(P.dirname('C:\\a\\b.kami'), 'C:\\a');
  assert.equal(P.basename('C:\\a\\発表.kami', '.kami'), '発表');
  assert.equal(P.extname('a/b.diagram.svg'), '.svg');
  assert.equal(P.relative('C:\\a', 'C:\\a\\b\\c.png'), 'b/c.png');
  assert.equal(P.inside('C:\\a', '../b'), null);
  assert.equal(P.inside('/a', 'b/../c'), '/a/c');
  assert.ok(P.same('C:\\A\\b', 'c:/a/b'));
  assert.equal(P.resolve('C:\\a', 'D:\\x'), 'D:\\x');
});

test('プロジェクト: 作成・読み書き（LF・末尾改行・整形済み JSON）', async (t) => {
  const { b, p } = await newProject(t);
  assert.equal(p.name, 'talk');
  assert.match((await p.read()).md, /# テスト発表/);
  assert.ok(fs.existsSync(path.join(p.dir, '.gitignore')));
  await p.writeMd('# A\r\n\r\n---\r\n\r\n## B');
  assert.equal(fs.readFileSync(path.join(p.dir, 'slides.md'), 'utf8'), '# A\n\n---\n\n## B\n');
  await p.writeDesign({ theme: 'paper', tokens: { accent: '#ff0000', bg: '' } });
  assert.equal(fs.readFileSync(path.join(p.dir, 'deck.json'), 'utf8'), '{\n  "theme": "paper",\n  "tokens": {\n    "accent": "#ff0000"\n  }\n}\n');
  await assert.rejects(b.createProject(tempDir(t)), /slides\.md が見つかりません/);
});

test('画像の保存: 安全な名前・重複は連番・同じ内容は使い回し・図形の上書き', async (t) => {
  const { p } = await newProject(t);
  assert.equal(await p.saveAsset('../../evil name.png', PNG_1PX), 'assets/evil-name.png');
  assert.equal(await p.saveAsset('evil name.png', PNG_1PX), 'assets/evil-name.png');
  assert.equal(await p.saveAsset('evil name.png', Uint8Array.from([...PNG_1PX, 0])), 'assets/evil-name-2.png');
  await assert.rejects(p.saveAsset('x.exe', PNG_1PX), /対応していない/);
  assert.equal(await p.saveAsset('flow.diagram.svg', new TextEncoder().encode('<svg/>')), 'assets/flow.diagram.svg');
  assert.equal(await p.saveAsset('flow.diagram.svg', new TextEncoder().encode('<svg>2</svg>')), 'assets/flow-2.diagram.svg');
  await p.writeAsset('assets/flow.diagram.svg', new TextEncoder().encode('<svg>new</svg>'));
  assert.equal(fs.readFileSync(path.join(p.dir, 'assets', 'flow.diagram.svg'), 'utf8'), '<svg>new</svg>');
  await assert.rejects(p.writeAsset('../slides.md', PNG_1PX), /assets/);
  await assert.rejects(p.writeAsset('assets/../../x.png', PNG_1PX), /assets/);
});

test('テーマ: 同梱テーマが見え、作ったテーマはユーザーのテーマとして保存される', async (t) => {
  const { p } = await newProject(t);
  const themes = await p.listThemes();
  for (const id of ['snow', 'paper', 'midnight', 'ink']) assert.ok(themes[id], id);
  assert.equal(themes.midnight.editable, false);
  const saved = await p.writeTheme('my-theme', { name: '自分用', tokens: { accent: '#123456' }, css: '.x{}' });
  assert.equal(saved.editable, true);
  assert.ok(fs.existsSync(path.join(userThemes, 'my-theme', 'theme.css')));
  await assert.rejects(p.writeTheme('Bad Id', {}), /テーマID/);
});

test('自作テーマ: フォルダ・theme.json・zip から読み込み、zip に書き出せる', async (t) => {
  const b = newBackend(t);
  const api = (method, url, body) => b.api(method, url.split('/').filter(Boolean), {}, body);
  const base = tempDir(t);
  // 1) フォルダ（ID はフォルダ名を英小文字に）。知らないトークンと選べない値は警告
  const dir = path.join(base, 'My_Brand');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: '自社', tokens: { accent: '#ff0000', nope: 1, headingStyle: 'wavy' } }));
  fs.writeFileSync(path.join(dir, 'theme.css'), '.ks-deck h1 { color: red; }\r\n');
  let r = await api('POST', '/api/themes/import', { path: dir });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.imported, [{ id: 'my_brand', name: '自社' }]);
  assert.equal(r.json.warnings.length, 2);
  assert.equal(fs.readFileSync(path.join(userThemes, 'my_brand', 'theme.css'), 'utf8'), '.ks-deck h1 { color: red; }\n');
  // 2) 同じ ID は上書きの確認（409）→ overwrite で上書き
  r = await api('POST', '/api/themes/import', { path: path.join(dir, 'theme.json') });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.exists, ['my_brand']);
  r = await api('POST', '/api/themes/import', { path: path.join(dir, 'theme.json'), overwrite: true });
  assert.equal(r.status, 200);
  // 3) 書き出した zip は、別の名前のテーマとしてそのまま読み込める
  const zip = path.join(base, 'out', 'shared');
  r = await api('POST', '/api/themes/export', { id: 'my_brand', out: zip });
  assert.equal(r.json.file, zip + '.zip');
  const names = readZip(fs.readFileSync(zip + '.zip')).map((e) => e.name).sort();
  assert.deepEqual(names, ['my_brand/theme.css', 'my_brand/theme.json']);
  removeDir(path.join(userThemes, 'my_brand'));
  r = await api('POST', '/api/themes/import', { path: zip + '.zip' });
  assert.deepEqual(r.json.imported.map((x) => x.id), ['my_brand']);
  const state = await api('GET', '/api/state');
  assert.equal(state.json.themes.my_brand.tokens.accent, '#ff0000');
  // 4) 同梱テーマと同じ ID・壊れた JSON・theme.json の無いフォルダは読み込まない
  const paper = path.join(base, 'paper');
  fs.mkdirSync(paper);
  fs.writeFileSync(path.join(paper, 'theme.json'), '{}');
  await assert.rejects(api('POST', '/api/themes/import', { path: paper }), /同梱のテーマと同じ ID/);
  const broken = path.join(base, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'theme.json'), '{ nope');
  await assert.rejects(api('POST', '/api/themes/import', { path: broken }), /JSON として読めません/);
  await assert.rejects(api('POST', '/api/themes/import', { path: base + path.sep + 'out' }), /theme\.json が見つかりません/);
  removeDir(path.join(userThemes, 'my_brand'));
});

test('zip: 書いて読むと同じ（日本語のファイル名・圧縮あり / なし）', () => {
  const entries = [
    { name: 'slides.md', data: Buffer.from('# あいう\n'.repeat(50)) },
    { name: 'assets/画像.png', data: Buffer.from(PNG_1PX) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const back = readZip(writeZip(entries));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  back.forEach((e, i) => assert.ok(e.data.equals(entries[i].data), e.name));
  assert.throws(() => readZip(Buffer.from('not a zip')), /zip/);
});

test('.kami: 使っているユーザーテーマも同梱し、展開すると元に戻る', async (t) => {
  const { b, p } = await newProject(t, '発表');
  await p.saveAsset('写真.png', PNG_1PX);
  await p.writeTheme('kami-theme', { name: '同梱テスト', tokens: { accent: '#00aa00' } });
  await p.writeDesign({ theme: 'kami-theme' });
  fs.mkdirSync(path.join(p.dir, 'dist'));
  fs.writeFileSync(path.join(p.dir, 'dist', 'out.html'), 'x');
  const dir = tempDir(t);
  const file = await b.packProject(p, path.join(dir, '発表.kami'));
  const names = readZip(fs.readFileSync(file)).map((e) => e.name).sort();
  assert.deepEqual(names, ['assets/写真.png', 'deck.json', 'slides.md', 'themes/kami-theme/theme.json']);
  // 別の PC（ユーザーテーマが無い）で開いても、同梱のテーマで表示できる
  removeDir(path.join(userThemes, 'kami-theme'));
  const out = await b.unpackKami(file, path.join(dir, 'open'));
  const opened = await b.createProject(out);
  assert.equal((await opened.readTheme('kami-theme')).name, '同梱テスト');
  await assert.rejects(b.unpackKami(path.join(dir, 'open', 'slides.md'), path.join(dir, 'x')), /開けませんでした/);
});

test('セッション: フォルダ / .kami を開く・新規作成・保存し直す・最近使ったもの', async (t) => {
  const dir = tempDir(t);
  const b = newBackend(t);
  assert.equal(b.project, null);

  const folder = await b.createFolder(path.join(dir, 'フォルダ版'), { title: 'フォルダ版' });
  assert.equal(folder.kamiFile, null);
  fs.mkdirSync(path.join(dir, '使用中'));
  fs.writeFileSync(path.join(dir, '使用中', 'memo.txt'), 'x');
  await assert.rejects(b.createFolder(path.join(dir, '使用中')), /空ではない/);

  // .kami として新規作成 → 編集すると少し後に .kami へ書き戻される
  const kamiPath = path.join(dir, '一枚.kami');
  const kami = await b.createKami(kamiPath);
  assert.equal(kami.kamiFile, kamiPath);
  assert.equal(kami.name, '一枚');
  await kami.writeMd('# 書き戻しテスト');
  await b.flush();
  assert.match(readZip(fs.readFileSync(kamiPath)).find((e) => e.name === 'slides.md').data.toString(), /書き戻しテスト/);

  // サンプル（未保存）→ .kami に保存すると、以後その .kami を編集する
  const sample = await b.openSample();
  assert.ok(sample.temporary);
  assert.ok(fs.existsSync(path.join(sample.dir, 'assets', 'process.diagram.svg')));
  const saved = await b.saveAsKami(path.join(dir, 'サンプル.kami'));
  assert.equal(saved.kamiFile, path.join(dir, 'サンプル.kami'));
  assert.ok(!saved.temporary);

  const asFolder = await b.saveAsFolder(path.join(dir, '展開'));
  assert.equal(asFolder.dir, path.join(dir, '展開'));
  assert.ok(fs.existsSync(path.join(dir, '展開', 'assets', 'dawn.svg')));

  assert.equal((await b.open(path.join(dir, 'フォルダ版', 'slides.md'))).dir, path.join(dir, 'フォルダ版'));
  await assert.rejects(b.open(path.join(dir, 'nope')), /見つかりません/);

  const recent = (await b.recent()).map((r) => r.path);
  assert.equal(recent[0], path.join(dir, 'フォルダ版'));
  assert.ok(recent.includes(kamiPath));
  await b.close();
  assert.equal(b.project, null);
});

test('書き出し: 埋め込み（1 ファイル）と フォルダ参照（_files）', async (t) => {
  const { b, p } = await newProject(t);
  await p.saveAsset('a.png', PNG_1PX);
  await p.writeMd('# 表紙\n\n---\n\n## 画像\n\n![](assets/a.png)\n\n![](assets/missing.png)\n\n---\n\n```mermaid\nflowchart LR\n  A --> B\n```');
  const out = tempDir(t);

  const embedded = await b.exportDeck(p, { out: path.join(out, 'one.html') });
  assert.match(embedded.html, /src="data:image\/png;base64,/);
  assert.ok(embedded.warnings.some((w) => /missing\.png/.test(w)));
  assert.ok(embedded.bytes > 1024 * 1024, 'mermaid を埋め込む');
  assert.ok(!fs.existsSync(path.join(out, 'one_files')));

  const ref = await b.exportDeck(p, { out: path.join(out, '発表.html'), embed: false });
  assert.match(ref.html, /src="%E7%99%BA%E8%A1%A8_files\/assets\/a\.png"/);
  assert.match(ref.html, /<script src="%E7%99%BA%E8%A1%A8_files\/mermaid\.min\.js"><\/script>/);
  assert.ok(ref.bytes < 300 * 1024);
  assert.ok(fs.existsSync(path.join(out, '発表_files', 'assets', 'a.png')));
  assert.ok(fs.existsSync(path.join(out, '発表_files', 'mermaid.min.js')));

  assert.equal((await b.exportDeck(p)).file, path.join(p.dir, 'dist', 'talk.html'));
  assert.equal((await b.exportDocument(p)).file, path.join(p.dir, 'dist', 'talk-資料.html'));
  // 画面で作ったファイル（Word など）の保存先
  assert.equal((await b.saveExportFile(p, 'doc', 'docx', null, PNG_1PX)).file, path.join(p.dir, 'dist', 'talk-資料.docx'));
  await assert.rejects(b.saveExportFile(p, 'doc', 'exe', null, PNG_1PX), /対応していない/);
});

test('書き出し: 1 ファイルの HTML・テーマが無ければ警告・資料は A4', async (t) => {
  const { b, p } = await newProject(t);
  await p.writeDesign({ theme: 'no-such-theme' });
  await p.writeMd('# 表紙\n\n---\n\n## 本文\n\nテキスト\n\n???\nメモ');
  const r = await b.buildDeck(p);
  assert.ok(r.warnings.some((w) => /no-such-theme/.test(w)));
  assert.doesNotMatch(r.html, /<script src=|<link rel="stylesheet"/);
  assert.match(r.html, /Kamishibai\.start\(/);
  assert.match(r.html, /@page \{ size: 1280px 720px/);
  assert.ok(r.html.includes("classList.add('ks-ready')"));
  const d = await b.buildDocument(p);
  assert.match(d.html, /@page \{ size: A4/);
  assert.doesNotMatch(d.html, /メモ/);
  assert.match((await b.buildDocument(p, { notes: true })).html, /ks-doc-note[\s\S]*メモ/);
});

test('同梱テーマ: 定義が正しく、シンプルなテーマにはグラデーションが無い', () => {
  const schema = require('../src/core/schema');
  const keys = new Set(schema.TOKENS.map((d) => d.key));
  const dir = path.join(__dirname, '..', 'themes');
  const ids = fs.readdirSync(dir).filter((id) => fs.existsSync(path.join(dir, id, 'theme.json')));
  assert.ok(ids.length >= 11);
  for (const id of ids) {
    const theme = JSON.parse(fs.readFileSync(path.join(dir, id, 'theme.json'), 'utf8'));
    assert.ok(theme.name && theme.description, id);
    assert.ok(['simple', 'decorative'].includes(theme.category), id + ' の category');
    for (const k of Object.keys(theme.tokens || {})) assert.ok(keys.has(k), id + ' の未知のトークン: ' + k);
    for (const def of schema.TOKENS.filter((d) => d.type === 'select')) {
      const v = (theme.tokens || {})[def.key];
      if (v !== undefined) assert.ok(def.options.some((o) => o[0] === v), id + ' の ' + def.key + '=' + v);
    }
    if (theme.category === 'simple') {
      const tk = theme.tokens || {};
      assert.doesNotMatch([tk.bgSlide, tk.bgTitle, tk.bgSection].join(''), /gradient/, id + ' はシンプルなのに背景がグラデーション');
      assert.notEqual(tk.headingStyle, 'gradient', id + ' はシンプルなのに見出しがグラデーション');
    }
  }
});

test('日本語を含むパスのファイル・フォルダを消してもプロセスが落ちない（fs.rmSync を使わない）', (t) => {
  const dir = path.join(tempDir(t), '日本語のフォルダ');
  fs.mkdirSync(path.join(dir, '中'), { recursive: true });
  fs.writeFileSync(path.join(dir, '資料.pdf'), 'x');
  fs.writeFileSync(path.join(dir, '中', '画像.png'), 'x');
  removeFile(path.join(dir, '資料.pdf'));
  removeFile(path.join(dir, '資料.pdf')); // 無くても例外にならない
  assert.ok(!fs.existsSync(path.join(dir, '資料.pdf')));
  removeDir(dir);
  assert.ok(!fs.existsSync(dir));
  for (const f of ['src/node/pdf.js', 'src/node/host.js', 'src/node/server.js', 'bin/kamishibai.js', 'scripts/update-vendor.js', 'scripts/prepare-app.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /\.rmSync\(/, f);
  }
});

function request(port, opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(Object.assign({ host: '127.0.0.1', port }, opts), (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('サーバー: 開く前はスタート状態・API・Host/Origin 検査・パストラバーサル', async (t) => {
  const dir = tempDir(t);
  const server = createServer({ workRoot: path.join(dir, 'work') });
  const port = await listen(server, 0, 0);
  t.after(() => server.close());
  const host = { Host: 'localhost:' + port };
  const json = Object.assign({ 'Content-Type': 'application/json' }, host);

  let state = JSON.parse((await request(port, { path: '/api/state', headers: host })).body);
  assert.equal(state.project, null);
  assert.ok(state.themes.snow);
  assert.equal((await request(port, { path: '/api/project', headers: host })).status, 409);

  const target = path.join(dir, 'ブラウザ版');
  assert.equal((await request(port, { method: 'POST', path: '/api/new', headers: json }, JSON.stringify({ path: target }))).status, 200);
  state = JSON.parse((await request(port, { path: '/api/state', headers: host })).body);
  assert.equal(state.project.dir, target);

  fs.writeFileSync(path.join(target, 'assets', 'a.png'), PNG_1PX);
  const put = await request(port, { method: 'PUT', path: '/api/project/md', headers: Object.assign({ 'Content-Type': 'text/plain' }, host) }, '# 更新\n\n![](assets/a.png)');
  assert.equal(put.status, 200);
  assert.equal(fs.readFileSync(path.join(target, 'slides.md'), 'utf8'), '# 更新\n\n![](assets/a.png)\n');

  const present = await request(port, { path: '/present', headers: host });
  assert.match(present.body, /<h1>更新<\/h1>/);
  assert.match(present.body, /src="\/files\/assets\/a\.png"/); // プレビューは画像を /files/ から読む
  assert.match((await request(port, { path: '/doc?notes=1', headers: host })).body, /class="ks-doc-page"/);

  const outFile = path.join(dir, 'out', 'スライド.html');
  const ex = await request(port, { method: 'POST', path: '/api/project/export', headers: json }, JSON.stringify({ kind: 'slides', format: 'html', out: outFile, embed: false }));
  assert.equal(ex.status, 200);
  assert.equal(JSON.parse(ex.body).file, outFile);
  const docx = await request(port, { method: 'POST', path: '/api/project/export-file?kind=doc&format=docx', headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, host) }, 'PK');
  assert.equal(JSON.parse(docx.body).file, path.join(target, 'dist', 'ブラウザ版-資料.docx'));
  assert.equal((await request(port, { method: 'POST', path: '/api/reveal', headers: json }, JSON.stringify({ path: path.join(dir, 'other.txt') }))).status, 404);

  assert.equal((await request(port, { path: '/', headers: host })).status, 200);
  assert.equal((await request(port, { path: '/app/backend.js', headers: host })).status, 200);
  assert.equal((await request(port, { path: '/api/state', headers: { Host: 'evil.example:' + port } })).status, 403);
  assert.equal((await request(port, { method: 'PUT', path: '/api/project/md', headers: Object.assign({ Origin: 'http://evil.example' }, host) }, 'x')).status, 403);
  assert.equal((await request(port, { path: '/files/..%2F..%2Fpackage.json', headers: host })).status, 404);
  assert.equal((await request(port, { path: '/core/..%2F..%2Fpackage.json', headers: host })).status, 404);
  assert.equal((await request(port, { method: 'POST', path: '/api/open', headers: json }, JSON.stringify({ path: path.join(dir, 'nope') }))).status, 404);

  await request(port, { method: 'POST', path: '/api/close', headers: json }, '{}');
  assert.equal(JSON.parse((await request(port, { path: '/api/state', headers: host })).body).project, null);
});

test('セキュリティ: 書き出す HTML は CSP で自分のスクリプトだけを許し、原稿の HTML とプロジェクトの外の画像は入らない', async (t) => {
  const crypto = require('crypto');
  const { b, p } = await newProject(t);
  const outside = path.join(path.dirname(p.dir), 'secret.png');
  fs.writeFileSync(outside, PNG_1PX);
  await p.writeMd('# 表紙\n\n<img src=x onerror="alert(1)">\n\n![外](../secret.png)\n\n```mermaid\nflowchart LR\n  A --> B\n```');
  for (const built of [await b.buildDeck(p), await b.buildDocument(p)]) {
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(built.html);
    assert.ok(meta, 'CSP がある');
    const policy = meta[1].replace(/&#39;/g, "'");
    assert.match(policy, /default-src 'none'/);
    assert.doesNotMatch(policy, /unsafe-inline'[^;]*;?\s*$|script-src[^;]*unsafe/);
    // インラインのスクリプトは、すべてハッシュで許されている（それ以外は無い）
    const scripts = Array.from(built.html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]);
    assert.ok(scripts.length >= 1);
    for (const s of scripts) assert.ok(policy.includes("'sha256-" + crypto.createHash('sha256').update(s).digest('base64') + "'"));
    assert.ok(!/<img src="x"|onerror="alert/.test(built.html), '原稿の img は文字になる');
    assert.ok(built.warnings.some((w) => /フォルダの外/.test(w)), '外の画像は警告');
    assert.ok(!built.html.includes(PNG_1PX_B64), '外の画像は埋め込まない');
  }
  // 書き出し先の拡張子は形式に合わせる（.hta などにはならない）
  const out = path.join(tempDir(t), 'x.hta');
  const r = await b.exportDeck(p, { out });
  assert.equal(r.file, out + '.html');
});

test('セキュリティ: ブラウザ版のサーバーは CSP を付け、プロジェクトのファイルはページとして動かない', async (t) => {
  const dir = tempDir(t);
  const server = createServer({ workRoot: path.join(dir, 'work') });
  const port = await listen(server, 0, 0);
  t.after(() => server.close());
  const host = { Host: 'localhost:' + port };
  const json = Object.assign({ 'Content-Type': 'application/json' }, host);
  const target = path.join(dir, 'p');
  await request(port, { method: 'POST', path: '/api/new', headers: json }, JSON.stringify({ path: target }));
  fs.writeFileSync(path.join(target, 'assets', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const index = await request(port, { path: '/', headers: host });
  assert.match(index.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(index.body, /<script>|\son(load|error)=/); // インラインのスクリプトが無い
  const svg = await request(port, { path: '/files/assets/x.svg', headers: host });
  assert.match(svg.headers['content-security-policy'], /sandbox/);
  assert.match(svg.headers['content-security-policy'], /default-src 'none'/);
});

test('.kami: 置き場所のフォルダを作れなくても（アプリの許可の外）書き戻せる・失敗は stat で知らせる', async (t) => {
  const dir = tempDir(t);
  const kamiPath = path.join(dir, '許可.kami');
  // アプリと同じく「選んだファイル」だけが許可で、親フォルダの mkdir は拒否する host
  const host = createNodeHost();
  const mkdir = host.mkdir;
  let failWrite = false;
  host.mkdir = async (p) => { if (P.same(p, dir)) throw new Error('KS_DENIED: 許可の外'); return mkdir(p); };
  const writeFile = host.writeFile;
  host.writeFile = async (p, d) => { if (failWrite && p.endsWith('.saving')) throw new Error('KS_DENIED: 書けない'); return writeFile(p, d); };
  const b = createBackend(host, {
    workRoot: path.join(tempDir(t), 'work'),
    markdownit: require(path.join(TOOL_ROOT, 'vendor', 'markdown-it.min.js')),
  });
  fs.writeFileSync(kamiPath, await require('../src/node/zip').writeZip([{ name: 'slides.md', data: Buffer.from('# 最初') }]));
  await b.openKami(kamiPath);
  const put = (md) => b.api('PUT', ['api', 'project', 'md'], {}, md);
  const stat = async () => (await b.api('GET', ['api', 'project', 'stat'], {})).json;

  await put('# 書き換えた');
  await b.flush();
  assert.match(readZip(fs.readFileSync(kamiPath)).find((e) => e.name === 'slides.md').data.toString(), /書き換えた/);
  assert.equal((await stat()).saveError, null);

  failWrite = true;
  await put('# 書けない');
  await b.flush();
  assert.match((await stat()).saveError, /書けない/);
  assert.match(readZip(fs.readFileSync(kamiPath)).find((e) => e.name === 'slides.md').data.toString(), /書き換えた/);

  failWrite = false; // 直ったら、次の書き戻しで失敗が消え、取りこぼした変更も入る
  await b.flush();
  assert.equal((await stat()).saveError, null);
  assert.match(readZip(fs.readFileSync(kamiPath)).find((e) => e.name === 'slides.md').data.toString(), /書けない/);
});
