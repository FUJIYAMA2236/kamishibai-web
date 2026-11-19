// core（parse / render / schema）のテスト。実行: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const schema = require('../src/core/schema');
const parse = require('../src/core/parse');
const render = require('../src/core/render');

const vendor = (f) => path.join(__dirname, '..', 'vendor', f);
const md = render.createMarkdown(require(vendor('markdown-it.min.js')), require(vendor('highlight.min.js')));
const renderOne = (text, design) => render.renderDeck(parse.parseDeck(text), design || {}, {}, { md });

test('front matter とスライド区切り', () => {
  const p = parse.parseDeck('---\ntitle: 発表\nauthor: 私\n---\n\n# 表紙\n\n---\n\n## 二枚目\n\n本文');
  assert.equal(p.meta.title, '発表');
  assert.equal(p.meta.author, '私');
  assert.equal(p.slides.length, 2);
  assert.equal(p.slides[0].title, '表紙');
  assert.equal(p.slides[1].title, '二枚目');
});

test('front matter が無ければ最初の見出しがタイトルになる', () => {
  const p = parse.parseDeck('# はじめに\n\n---\n\n## 次');
  assert.equal(p.meta.title, 'はじめに');
  assert.equal(p.slides.length, 2);
});

test('直前が空行でない --- は区切りにならない（setext 見出し等）', () => {
  const p = parse.parseDeck('## A\n\nテキスト\n---\n\n## B');
  assert.equal(p.slides.length, 1);
});

test('コードフェンス内の --- / ??? / ||| は無視される', () => {
  const p = parse.parseDeck('## A\n\n```\n\n---\n???\n|||\n```\n\n---\n\n## B');
  assert.equal(p.slides.length, 2);
  assert.equal(p.slides[0].columns.length, 1);
  assert.equal(p.slides[0].notes, '');
});

test('ノートとカラム', () => {
  const p = parse.parseDeck('## A\n\n左\n\n|||\n\n右\n\n???\nメモ\n|||\nメモ2');
  const s = p.slides[0];
  assert.equal(s.columns.length, 2);
  assert.match(s.columns[1], /右/);
  assert.equal(s.notes, 'メモ\n|||\nメモ2');
  const p2 = parse.parseDeck('## A\n\nNote:\nこちらでも書ける');
  assert.equal(p2.slides[0].notes, 'こちらでも書ける');
});

test('ID: 見出しから自動生成・重複は連番・明示 ID が優先', () => {
  const p = parse.parseDeck('## 同じ\n\n---\n\n## 同じ\n\n---\n\n<!-- id: fixed -->\n## 別\n\n---\n\n本文だけ');
  assert.deepEqual(p.slides.map((s) => s.id), ['同じ', '同じ-2', 'fixed', 'slide']);
  assert.equal(p.slides[2].explicitId, 'fixed');
});

test('pinSlideId は内容の直前に ID コメントを入れる', () => {
  const text = '# 表紙\n\n---\n\n## 二枚目\n\n本文\n';
  const p = parse.parseDeck(text);
  const r = parse.pinSlideId(text, p.slides[1]);
  assert.match(r.text, /---\n\n<!-- id: 二枚目 -->\n## 二枚目/);
  const again = parse.parseDeck(r.text);
  assert.equal(again.slides[1].explicitId, '二枚目');
  assert.equal(again.slides.length, 2);
});

test('slideIndexAtLine', () => {
  const p = parse.parseDeck('# A\n\n---\n\n## B\n\nx\n\n---\n\n## C');
  assert.equal(parse.slideIndexAtLine(p, 0), 0);
  assert.equal(parse.slideIndexAtLine(p, 5), 1);
  assert.equal(parse.slideIndexAtLine(p, 100), 2);
});

test('レイアウトの自動判定', () => {
  const layouts = renderOne([
    '# タイトル\n\nサブ',
    '## セクション',
    '## 標準\n\n- a\n- b',
    '一言だけ',
    '> 引用',
    '## 画像\n\n説明\n\n- a\n\n![x](a.png)',
    '## カラム\n\n左\n\n|||\n\n右',
  ].join('\n\n---\n\n')).slides.map((s) => s.layout);
  assert.deepEqual(layouts, ['title', 'section', 'content', 'center', 'quote', 'image-right', 'columns']);
});

test('deck.json のスライド設定が反映され、画像がなければ画像レイアウトは標準に戻る', () => {
  const out = renderOne('## A\n\n本文\n\n---\n\n## B\n\n本文', {
    // ID は見出しから作られ、小文字化される
    slides: { a: { layout: 'center', animation: { build: 'items' } }, b: { layout: 'image-left' } },
  });
  assert.equal(out.slides[0].layout, 'center');
  assert.match(out.slides[0].html, /data-build="items"/);
  assert.equal(out.slides[1].layout, 'content');
});

test('画像の属性指定とパス解決', () => {
  const out = render.renderDeck(parse.parseDeck('![猫](assets/cat.png){width=40% .shadow}'), {}, {}, {
    md, resolveAsset: (src) => '/files/x/' + src,
  });
  const html = out.slides[0].html;
  assert.match(html, /src="\/files\/x\/assets\/cat\.png"/);
  assert.match(html, /width:40%/);
  assert.match(html, /class="shadow"/);
  assert.doesNotMatch(html, /\{width/);
});

test('mermaid はソースを残して描画用の器を出す', () => {
  const out = renderOne('```mermaid\nflowchart LR\n  A --> B\n```');
  assert.ok(out.usesMermaid);
  assert.match(out.slides[0].html, /class="ks-mermaid-src">flowchart LR\n  A --&gt; B/);
  assert.equal(renderOne('## 図なし').usesMermaid, false);
});

test('コードはハイライトされ、HTML はエスケープされる', () => {
  const html = renderOne('```js\nconst a = "<b>";\n```').slides[0].html;
  assert.match(html, /hljs-keyword/);
  assert.match(html, /&lt;b&gt;/);
});

test('ノートはスライド内の aside に入る', () => {
  const s = renderOne('## A\n\n???\n**大事**').slides[0];
  assert.match(s.notesHtml, /<strong>大事<\/strong>/);
  assert.match(s.html, /<aside class="ks-notes">/);
});

test('デザイン解決: 既定 < テーマ < デッキ', () => {
  const r = render.resolveDesign({ tokens: { accent: '#111111' }, aspect: '4:3' }, { tokens: { accent: '#222222', text: '#333333' } });
  assert.equal(r.tokens.accent, '#111111');
  assert.equal(r.tokens.text, '#333333');
  assert.equal(r.tokens.bg, schema.DEFAULT_TOKENS.bg);
  assert.deepEqual(r.size, schema.ASPECTS['4:3']);
});

test('トークンは CSS 変数になり、危険な文字は落とされる', () => {
  const css = render.tokensToStyle({ baseSize: 30, accent: 'red;}</style>', headingStyle: 'bar' });
  assert.match(css, /--ks-base-size:30px/);
  assert.match(css, /--ks-accent:red\/style/);
  assert.doesNotMatch(css, /heading-style/); // data 属性で出す項目は CSS 変数にしない
});

test('serialize はキーを並べ替え、空の値を落とす', () => {
  const text = render.serialize({ theme: 'x', slides: { b: {}, a: { layout: '' } }, chrome: { footer: 'f' } });
  assert.equal(text, '{\n  "chrome": {\n    "footer": "f"\n  },\n  "theme": "x"\n}\n');
});

test('findImages: 順番・位置・属性。コード内は除く', () => {
  const text = '# A\n\n![x](a.png){width=40% .shadow} `![n](b.png)`\n\n```\n![c](c.png)\n```\n\n![d](<d e.png> "t")';
  const imgs = parse.findImages(text);
  assert.deepEqual(imgs.map((i) => i.src), ['a.png', 'd e.png']);
  assert.equal(text.slice(imgs[0].start, imgs[0].end), '![x](a.png){width=40% .shadow}');
  assert.deepEqual(imgs[0].attrs, { width: '40%', classes: ['shadow'] });
  assert.equal(imgs[1].title, 't');
  assert.equal(parse.findImages(text, 0, 3).length, 1); // 行範囲で絞れる
});

test('setImageAttrs: {…} を付け替え・外す', () => {
  const text = 'a ![x](a.png){width=40%} b';
  const im = parse.findImages(text)[0];
  assert.equal(parse.setImageAttrs(text, im, { width: '60%', classes: ['round'] }), 'a ![x](a.png){width=60% .round} b');
  assert.equal(parse.setImageAttrs(text, im, { classes: [] }), 'a ![x](a.png) b');
});

test('画像の通し番号はスライド内の Markdown の順番と一致する（ノートは数えない）', () => {
  const text = '## A\n\n![1](one.png)\n\n|||\n\n![2](two.png) と ![3](three.png)\n\n???\n![n](note.png)';
  const html = renderOne(text).slides[0].html;
  const tags = html.match(/data-img="\d+" data-src="[^"]+"/g);
  assert.deepEqual(tags, ['data-img="0" data-src="one.png"', 'data-img="1" data-src="two.png"', 'data-img="2" data-src="three.png"']);
  const slide = parse.parseDeck(text).slides[0];
  const r = parse.slideBodyRange(slide);
  assert.deepEqual(parse.findImages(text, r.start, r.end).map((i) => i.src), ['one.png', 'two.png', 'three.png']);
});

test('insertBlockAt: スライド末尾（ノートの前・区切りの前）に空行をはさんで入る', () => {
  const text = '# A\n\n本文\n\n---\n\n## B\n\nテキスト\n\n???\nノート';
  const slides = parse.parseDeck(text).slides;
  const a = parse.insertBlockAt(text, parse.slideBodyRange(slides[0]).end, '![](x.png)');
  assert.equal(a.text, '# A\n\n本文\n\n![](x.png)\n\n---\n\n## B\n\nテキスト\n\n???\nノート');
  assert.equal(parse.parseDeck(a.text).slides.length, 2);
  const b = parse.insertBlockAt(text, parse.slideBodyRange(slides[1]).end, 'X');
  assert.match(b.text, /テキスト\n\nX\n\n\?\?\?\nノート$/);
  assert.equal(b.line, 10);
});

test('カラムの囲み: 属性・色・文字色・縦中央が出る', () => {
  const t = '## 機能\n\n### ①\n\n図面\n\n|||\n\n### ②\n\n見積';
  let s = renderOne(t, { slides: { '機能': { colStyle: 'fill', colColors: ['#ffffff', '#000000'] } } }).slides[0].html;
  assert.match(s, /data-col-style="fill"/);
  assert.match(s, /data-col-align="center"/);
  assert.match(s, /data-valign="center"/);
  assert.match(s, /--ks-col-1:#ffffff;--ks-on-col-1:#1b1b1f;--ks-col-2:#000000;--ks-on-col-2:#ffffff/);
  s = renderOne(t, { slides: { '機能': { colStyle: 'fill', colColors: ['#ffffff'], colText: 'light' } } }).slides[0].html;
  assert.match(s, /--ks-on-col-1:#ffffff/);
  // デッキ全体の設定（トークン）でも効き、スライドで「なし」に戻せる
  assert.match(renderOne(t, { tokens: { colStyle: 'outline' } }).slides[0].html, /data-col-style="outline"/);
  assert.match(renderOne(t, { tokens: { colStyle: 'outline' }, slides: { '機能': { colStyle: 'none' } } }).slides[0].html, /data-col-style="none" data-col-align="left"/);
  // カラム以外のレイアウトには付かない
  assert.doesNotMatch(renderOne('## x\n\n本文').slides[0].html, /data-col-style/);
});

test('横・全面に置いた画像には {width} を効かせない（右端に隙間ができる不具合の再発防止）', () => {
  const t = '## A\n\n文\n\n- a\n- b\n\n![](a.png){width=40% .shadow}';
  const right = renderOne(t).slides[0];
  assert.equal(right.layout, 'image-right');
  const media = /<div class="ks-media">(<img[^>]*>)/.exec(right.html)[1];
  assert.doesNotMatch(media, /style=/);
  assert.match(media, /class="shadow"/); // 影などのクラスは残す
  const full = renderOne(t, { slides: { a: { layout: 'image-full' } } }).slides[0].html;
  assert.doesNotMatch(/<div class="ks-bg">(<img[^>]*>)/.exec(full)[1], /style=/);
  // 本文の中の画像には効く
  assert.match(renderOne(t, { slides: { a: { layout: 'content' } } }).slides[0].html, /style="width:40%"/);
});

test('箱の角丸（boxRadius）は CSS 変数として出る', () => {
  assert.ok(schema.TOKENS.some((d) => d.key === 'boxRadius'));
  assert.match(render.tokensToStyle({ boxRadius: 24 }), /--ks-box-radius:24px/);
});

test('画像の表示位置（focus）', () => {
  const t = '## A\n\n文\n\n- a\n\n![](a.png)';
  assert.match(renderOne(t, { slides: { a: { focus: '20% 75.5%' } } }).slides[0].html, /--ks-media-pos:20% 75\.5%/);
  assert.doesNotMatch(renderOne(t, { slides: { a: { focus: 'evil;}' } } }).slides[0].html, /--ks-media-pos/);
});

test('editorBlocks: ブロック・区切り・ノート・カラム・ID 行に分かれる', () => {
  const t = '---\ntitle: T\n---\n\n# A\n\n本文\n\n---\n\n<!-- id: b -->\n## B\n\n- 1\n- 2\n\n|||\n\n```js\nx\n\n---\n```\n\n???\nメモ';
  const { items } = render.editorBlocks(t, md);
  assert.deepEqual(items.map((i) => i.type), ['front', 'block', 'block', 'end', 'sep', 'id', 'block', 'block', 'col', 'block', 'end', 'notes', 'block']);
  const lines = t.split('\n');
  const code = items.filter((i) => i.type === 'block')[4];
  assert.equal(lines.slice(code.start, code.end).join('\n'), '```js\nx\n\n---\n```'); // フェンス内の --- は区切りではない
  assert.equal(items.find((i) => i.type === 'notes').line, 24);
  assert.ok(items.filter((i) => i.type === 'block').pop().note);
});

test('renderDocument: 表紙・カラム・ノートの有無', () => {
  const t = '---\ntitle: 資料\nauthor: 私\n---\n\n# 資料\n\nサブ\n\n---\n\n## 比較\n\n左\n\n|||\n\n右\n\n???\nメモ';
  const p = parse.parseDeck(t);
  const plain = render.renderDocument(p, {}, {}, { md }).html;
  assert.match(plain, /ks-doc-cover[\s\S]*<h1>資料<\/h1>[\s\S]*ks-doc-meta">私/);
  assert.match(plain, /<h2>比較<\/h2>\n<div class="ks-doc-cols" data-col-style="none"/);
  assert.doesNotMatch(plain, /ks-doc-note/);
  assert.match(render.renderDocument(p, {}, {}, { md, notes: true }).html, /ks-doc-note[\s\S]*メモ/);
  // h1 が無ければ title から表紙を作る
  assert.match(render.renderDocument(parse.parseDeck('---\ntitle: 題\n---\n\n## x'), {}, {}, { md }).html, /<h1>題<\/h1>/);
});

test('schema: 全トークンに既定値と GUI 用の情報がある', () => {
  const groups = schema.TOKEN_GROUPS.map((g) => g[0]);
  for (const t of schema.TOKENS) {
    assert.ok(t.key && t.label && t.type, t.key);
    assert.ok(groups.includes(t.group), t.key + ' の group');
    if (t.type === 'select') assert.ok(t.options.some((o) => o[0] === t.default), t.key + ' の既定値が選択肢にない');
  }
});

// ---- カラムの囲み・カラム内の位置・箇条書きの記号 ----
test('::: columns 〜 ::: で囲むと、前後の文章はカラムに入らない', () => {
  const text = '## 見出し\n\n前の文\n\n::: columns\n\n左\n\n|||\n\n右\n\n:::\n\n後ろの文';
  const s = parse.parseDeck(text).slides[0];
  assert.equal(s.fenced, true);
  assert.deepEqual(s.columns, ['左', '右']);
  assert.match(s.pre, /前の文/);
  assert.equal(s.post, '後ろの文');
  const html = renderOne(text).slides[0].html;
  assert.match(html, /ks-cols-pre[\s\S]*前の文[\s\S]*ks-cols[\s\S]*左[\s\S]*右[\s\S]*ks-cols-post[\s\S]*後ろの文/);
  // 囲みが無い従来の書き方は、スライド全体がカラム
  const legacy = parse.parseDeck('## A\n\n左\n\n|||\n\n右\n\n後ろ').slides[0];
  assert.equal(legacy.fenced, false);
  assert.equal(legacy.columns.length, 2);
  assert.match(legacy.columns[1], /後ろ/);
});

test('editorBlocks: ::: columns と ::: は印の行として分かれる', () => {
  const { items } = render.editorBlocks('## A\n\n::: columns\n\n左\n\n|||\n\n右\n\n:::\n\n後', md);
  assert.deepEqual(items.filter((i) => /cols|col$/.test(i.type)).map((i) => i.type), ['colsopen', 'col', 'colsclose']);
});

test('カラム内の縦位置と、デッキ全体のカラムの色', () => {
  const text = '## A\n\n左\n\n|||\n\n右';
  let html = renderOne(text, { tokens: { colStyle: 'fill', colColor1: '#ff8800', colValign: 'bottom' } }).slides[0].html;
  assert.match(html, /data-col-valign="bottom"/);
  assert.match(html, /--ks-col-1:#ff8800/);
  // スライド個別の指定が優先
  html = renderOne(text, { tokens: { colStyle: 'fill', colColor1: '#ff8800' }, slides: { a: { colColors: ['#112233'], colValign: 'top' } } }).slides[0].html;
  assert.match(html, /--ks-col-1:#112233/);
  assert.match(html, /data-col-valign="top"/);
  // 囲みなしの既定は上詰め
  assert.match(renderOne(text).slides[0].html, /data-col-valign="top"/);
});

test('箇条書きの記号を自由に決められる（CSS の文字列として出る）', () => {
  const out = renderOne('- a', { tokens: { bulletStyle: 'custom', bulletChar: '★' } });
  assert.equal(out.deckAttrs['data-bullet-style'], 'custom');
  assert.match(out.deckStyle, /--ks-bullet-char:"★  "/);
});

// ---- 図形 ----
test('diagram: SVG に保存して、編集用のデータを取り出せる', () => {
  const D = require('../src/core/diagram');
  const model = D.newModel('sans-serif');
  model.items.push({ id: 'a', type: 'shape', shape: 'chevron', x: 0, y: 0, w: 160, h: 60, text: '受付 & <確認>', style: {} });
  model.items.push({ id: 'b', type: 'shape', shape: 'diamond', x: 220, y: 0, w: 120, h: 80, text: '判断', style: {} });
  model.items.push({ id: 'l', type: 'line', route: 'elbow', from: { id: 'a' }, to: { id: 'b' }, text: '', style: {} });
  const svg = D.toSvg(model);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="'));
  assert.ok(svg.includes('受付 &amp; &lt;確認&gt;'));
  assert.deepEqual(D.fromSvg(svg), model);
  assert.equal(D.fromSvg('<svg></svg>'), null);
  assert.ok(D.isDiagramPath('assets/a.diagram.svg?v=1'));
  assert.ok(!D.isDiagramPath('assets/a.svg'));
  // 線は図形の辺から出る
  const pts = D.linePoints(model.items[2], D.byId(model));
  assert.equal(pts[0].x, 160);
  assert.equal(pts[pts.length - 1].x, 220);
});

test('diagram: 画像は SVG に 1 回だけ埋め込み、読み戻せる', () => {
  const D = require('../src/core/diagram');
  const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const model = D.newModel('');
  model.items.push({ id: 'p1', type: 'shape', shape: 'image', src, ratio: 1.5, x: 0, y: 0, w: 150, h: 100, text: '写真', style: { fit: 'cover', stroke: '#ffffff' } });
  model.items.push({ id: 'p2', type: 'shape', shape: 'image', src, ratio: 1, x: 200, y: 0, w: 100, h: 100, text: '', style: {} });
  const svg = D.toSvg(model);
  assert.equal(svg.split(src).length - 1, 2); // 2 枚それぞれ 1 回ずつ（metadata には入らない）
  assert.ok(svg.includes('preserveAspectRatio="xMidYMid slice"'));
  assert.ok(svg.includes('preserveAspectRatio="xMidYMid meet"'));
  assert.deepEqual(D.fromSvg(svg), model);
  // 枠線を指定しない画像には枠も塗りも描かない
  assert.ok(!D.itemSvg(model.items[1], {}, {}).includes('<rect'));
});

test('diagram: 長い文字は図形の幅で折り返す', () => {
  const D = require('../src/core/diagram');
  const lines = D.wrapText('とても長い文章を図形の中に書いたときの折り返し', 100, 20, false);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.length <= 6));
});

// ---- Word / ODF / PowerPoint ----
const zip = require('../src/core/zip');
const names = (entries) => entries.map((e) => e.name);
function demoDoc() {
  const docmodel = require('../src/core/docmodel');
  const text = '---\ntitle: T\nauthor: 私\n---\n\n# 表紙\n\n---\n\n## 見出し\n\n- **太字** と [リンク](https://example.com)\n- 二つ目\n  1. 入れ子\n\n| A | B |\n| :-- | --: |\n| 1 | 2 |\n\n![図](assets/a.png){width=50%}\n\n```js\nconst a = 1;\n```\n\n---\n\n## カラム\n\n左\n\n|||\n\n右';
  return docmodel.build(text, { tokens: { colStyle: 'outline' } }, {}, { md, notes: false });
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 20, 8, 6, 0, 0, 0]);
const fakeMedia = { image: () => ({ data: PNG, mime: 'image/png', width: 40, height: 20 }), mermaid: () => null };

test('docmodel: 見出し・リスト・表・画像・コード・カラムに分かれる', () => {
  const doc = demoDoc();
  const types = doc.blocks.map((b) => b.type);
  for (const t of ['heading', 'para', 'table', 'image', 'code', 'columns']) assert.ok(types.includes(t), t);
  const nested = doc.blocks.find((b) => b.list && b.list.level === 1);
  assert.equal(nested.list.ordered, true);
  const bold = doc.blocks.find((b) => b.list).runs.find((r) => r.bold);
  assert.equal(bold.text, '太字');
  assert.equal(doc.blocks.find((b) => b.type === 'image').width, '50%');
});

test('docx / odt: 必要な部品がそろい、zip にして読み戻せる', () => {
  const docx = require('../src/core/docx').buildDocx(demoDoc(), fakeMedia, { title: 'T' });
  for (const n of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels', 'word/media/image1.png']) assert.ok(names(docx).includes(n), n);
  const doc = docx.find((e) => e.name === 'word/document.xml').data;
  assert.ok(/<w:hyperlink r:id="rIdK\d+">/.test(doc));
  assert.ok(doc.includes('<w:tbl>'));
  const odt = require('../src/core/odt').buildOdt(demoDoc(), fakeMedia, { title: 'T' });
  assert.equal(odt[0].name, 'mimetype');
  assert.equal(odt[0].store, true);
  assert.ok(/<text:list text:style-name="L_bullet">[\s\S]*<text:list text:style-name="L_num">/.test(odt.find((e) => e.name === 'content.xml').data));
  const back = zip.readZip(zip.writeZip(odt), { inflate: (b) => require('zlib').inflateRawSync(b) });
  assert.equal(back[0].name, 'mimetype');
  assert.equal(new TextDecoder().decode(back[0].data), 'application/vnd.oasis.opendocument.text');
});

test('pptx / odp: シーンからスライド・ノート・図形・表・画像が作られる', () => {
  const run = { text: '見出し', size: 40, color: '#ffffff', bold: true, font: 'Yu Gothic', ea: 'Yu Gothic' };
  const scene = {
    w: 1280, h: 720, bg: { color: '#0b1020', gradient: [] }, notes: 'ノート\n二行目',
    items: [
      { kind: 'text', x: 80, y: 60, w: 600, h: 60, single: true, paras: [{ align: 'l', runs: [run] }], inset: [0, 0, 0, 0] },
      { kind: 'text', x: 80, y: 160, w: 600, h: 200, paras: [{ align: 'l', bullet: { char: '◆', color: '#7c9cff' }, marL: 30, indent: -20, runs: [Object.assign({}, run, { text: '項目', bold: false })] }] },
      { kind: 'shape', geom: 'roundRect', x: 700, y: 160, w: 300, h: 200, radius: 20, fill: '#223344', line: '#7c9cff', lineWidth: 2 },
      { kind: 'image', x: 0, y: 400, w: 40, h: 20, data: PNG, mime: 'image/png' },
      { kind: 'line', points: [{ x: 100, y: 500 }, { x: 300, y: 500 }, { x: 300, y: 600 }], color: '#ffffff', width: 2, tail: 'arrow' },
      { kind: 'table', x: 80, y: 620, w: 400, h: 60, cols: [200, 200], rows: [{ h: 30, cells: [{ paras: [{ runs: [run] }] }, { paras: [] }] }, { h: 30, cells: [{ paras: [] }, { paras: [] }] }] },
      { kind: 'group', x: 900, y: 400, w: 200, h: 100, items: [{ kind: 'shape', geom: 'chevron', poly: [[0, 0], [150, 0], [200, 50], [150, 100], [0, 100], [50, 50]], x: 900, y: 400, w: 200, h: 100, fill: '#ffffff', paras: [{ align: 'ctr', runs: [run] }] }] },
    ],
  };
  const pptx = require('../src/core/pptx').buildPptx([scene, Object.assign({}, scene, { notes: '' })], { title: 'T' });
  for (const n of ['ppt/presentation.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/notesSlides/notesSlide1.xml', 'ppt/notesMasters/notesMaster1.xml', 'ppt/media/image1.png']) assert.ok(names(pptx).includes(n), n);
  assert.ok(!names(pptx).includes('ppt/notesSlides/notesSlide2.xml'));
  const s1 = pptx.find((e) => e.name === 'ppt/slides/slide1.xml').data;
  for (const s of ['<a:buChar char="◆"/>', '<a:tbl>', '<p:grpSp>', 'prst="chevron"', '<a:tailEnd type="triangle"']) assert.ok(s1.includes(s), s);
  assert.ok(pptx.find((e) => e.name === 'ppt/presentation.xml').data.includes('<p:sldSz cx="12192000" cy="6858000"/>'));
  const odp = require('../src/core/odp').buildOdp([scene], { title: 'T' });
  const content = odp.find((e) => e.name === 'content.xml').data;
  for (const s of ['<draw:page ', '<draw:polygon ', '<presentation:notes>', 'text:bullet-char="◆"']) assert.ok(content.includes(s), s);
});

test('テーマのリファレンス: docs が schema.js と一致し、同梱テーマは知っている項目と値だけを使う', () => {
  const fs = require('fs');
  const root = path.join(__dirname, '..');
  // scripts/theme-reference.js を実行し忘れていないか
  for (const [rel, text] of Object.entries(require('../scripts/theme-reference').build())) {
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n'), text, rel + ' が古い（node scripts/theme-reference.js を実行）');
  }
  const defs = Object.fromEntries(schema.TOKENS.map((d) => [d.key, d]));
  for (const id of fs.readdirSync(path.join(root, 'themes'))) {
    const t = JSON.parse(fs.readFileSync(path.join(root, 'themes', id, 'theme.json'), 'utf8'));
    for (const [k, v] of Object.entries(t.tokens || {})) {
      assert.ok(defs[k], id + ': 知らないトークン ' + k);
      if (defs[k].type === 'select') assert.ok(defs[k].options.some((o) => o[0] === v), id + ': ' + k + ' の値 ' + v);
      if (defs[k].type === 'number') assert.equal(typeof v, 'number', id + ': ' + k);
    }
    for (const k of Object.keys(t.animation || {})) assert.ok(schema.ANIMATION[k], id + ': 知らないアニメーション ' + k);
  }
});

test('日本語の折り返し: 既定は文節（data-line-break="phrase"）、文字ごとにも切り替えられる', () => {
  assert.equal(render.resolveDesign({}, {}).tokens.lineBreak, 'phrase');
  const out = renderOne('# A', { tokens: { lineBreak: 'char' } });
  assert.equal(out.deckAttrs['data-line-break'], 'char');
});

test('セキュリティ: 原稿の HTML は許可したタグだけ。スクリプト・イベント属性・危ないリンクは動かない', () => {
  const html = (src) => md.render(src);
  const bad = [
    '<img src=x onerror=alert(1)>', '<IMG SRC=x OnError=y>', '<svg onload=x>', '<script>alert(1)</script>', '<iframe src="https://e.invalid"></iframe>',
    '<style>b{}</style>', '<a href="javascript:x">l</a>', '<object data=x></object>', '<p/onclick=x>t</p>', '<math><mi xlink:href="javascript:x">m</mi></math>',
  ];
  for (const s of bad) {
    const out = html(s);
    assert.ok(!/<(img|svg|script|iframe|style|a|object|math)\b/i.test(out), s + ' → ' + out);
    assert.ok(!/\son[a-z]+=/i.test(out.replace(/&lt;[\s\S]*?&gt;/g, '')), s + ' → ' + out);
  }
  // 許可したタグは使える（属性は class だけ）
  assert.equal(html('<kbd class="k x&quot;y">C</kbd><br><mark onclick="x">m</mark>').trim(), '<p><kbd class="k">C</kbd><br><mark>m</mark></p>');
  assert.equal(html('<details open ontoggle=x>a</details>').trim(), '<details>a</details>');
  // Markdown のリンク・画像の危ないスキームは無効、画像の {…} は大きさと class 名だけ
  assert.ok(!html('[m](javascript:y)').includes('href="javascript'));
  assert.ok(!/src="(javascript|file):/i.test(html('![b](javascript:x) ![c](file:///etc/passwd)')));
  const img = html('![c](assets/a.png){width=1px;background:url(x) height=2em .ok}');
  assert.ok(img.includes('style="height:2em"') && img.includes('class="ok"') && !img.includes('background'), img);
});

test('セキュリティ: 図形ファイルの中の値は、読み込むときに決まった形にそろえる', () => {
  const D = require('../src/core/diagram');
  const evil = {
    version: 1, font: 'x"><script>', items: [
      { id: 'a" onmouseover="x', type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, text: '', style: {} },
      { id: 'b', type: 'shape', shape: 'rect"><x', x: '1" onload="x', y: 0, w: 10, h: 10, text: '<b>', style: { fill: 'red" onload="x', stroke: '#fff' } },
      { id: 'c', type: 'shape', shape: 'image', src: 'javascript:alert(1)', x: 0, y: 0, w: 1, h: 1, text: '', style: {} },
    ],
  };
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const m = D.fromSvg('<svg><metadata id="' + D.META_ID + '">' + escAttr(JSON.stringify(evil)) + '</metadata></svg>');
  assert.deepEqual(m.items.map((i) => i.id), ['b', 'c']); // 不正な ID のものは捨てる
  assert.equal(m.items[0].shape, 'rect');
  assert.equal(m.items[0].x, 0);
  assert.equal(m.items[0].style.fill, undefined);
  assert.equal(m.items[0].style.stroke, '#fff');
  assert.equal(m.items[1].src, '');
  assert.ok(!/[<>"]/.test(m.font));
});

test('図形の回転: 描画・外枠・線のつなぎ先・当たり判定・保存して読み戻し', () => {
  const D = require('../src/core/diagram');
  const arrow = { id: 'a', type: 'shape', shape: 'arrow', x: 0, y: 0, w: 100, h: 40, rot: 90, text: '', style: {} };
  const box = { id: 'b', type: 'shape', shape: 'rect', x: 300, y: 0, w: 100, h: 40, text: '', style: {} };
  const svg = D.itemSvg(arrow, {}, {});
  assert.ok(svg.startsWith('<g transform="rotate(90 50 20)">'), svg.slice(0, 60));
  // 90° 回すと、外枠は縦長（中心 50,20 のまわりに 40×100）
  const m = D.newModel('');
  m.items.push(arrow);
  const b = D.bounds(m);
  assert.deepEqual([Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)], [30, -30, 40, 100]);
  // 当たり判定: 回す前なら外（x=90,y=20）でも、回したあとは中に入る点（50,60）
  assert.ok(D.contains(arrow, { x: 50, y: 60 }));
  assert.ok(!D.contains(arrow, { x: 90, y: 20 }));
  // 上の辺のつなぎ口は、90° 回すと右側に来る
  const top = D.sidePoint(arrow, 'top');
  assert.deepEqual([Math.round(top.x), Math.round(top.y)], [70, 20]);
  // 右の図形へ引いた直線は、回した矢印の輪郭から出る。矢印の軸の太さは高さの 44%（上下 28% ずつ空く）なので、
  // 90° 回すと中心から右へ 40 × 0.22 = 8.8 の所
  const line = { id: 'l', type: 'line', from: { id: 'a' }, to: { id: 'b' }, route: 'straight', text: '', style: {} };
  const pts = D.linePoints(line, D.byId({ items: [arrow, box] }));
  assert.ok(Math.abs(pts[0].x - 58.8) < 0.5, String(pts[0].x));
  // 保存して読み戻しても角度が残る
  m.items.push(box, line);
  assert.equal(D.fromSvg(D.toSvg(m)).items[0].rot, 90);
});

test('カラムの並べ方: ::: rows / ::: grid と、スライド個別・デッキ全体の設定', () => {
  const s = parse.parseDeck('## A\n\n::: rows\nx\n|||\ny\n:::\n\n---\n\n## B\n\n::: grid\na\n|||\nb\n|||\nc\n:::\n\n---\n\n## C\n\nx\n\n|||\n\ny').slides;
  assert.deepEqual(s.map((x) => x.colDir), ['column', 'grid', undefined]);
  const out = renderOne('## A\n\n::: rows\nx\n|||\ny\n:::\n\n---\n\n## C\n\nx\n\n|||\n\ny', { tokens: { colDir: 'grid' }, slides: { c: { colDir: 'row' } } });
  assert.match(out.slides[0].html, /data-col-dir="column"/); // 原稿の囲みはデッキ全体より強い
  assert.match(out.slides[1].html, /data-col-dir="row"/); // スライド個別の設定がいちばん強い
  assert.match(renderOne('## C\n\nx\n\n|||\n\ny', { tokens: { colDir: 'grid' } }).slides[0].html, /data-col-dir="grid"/);
});

test('pptx / odp: 回した図形は角度つきで書き出す', () => {
  const scene = { w: 1280, h: 720, bg: { color: '#ffffff' }, items: [{ kind: 'shape', geom: 'rightArrow', x: 100, y: 100, w: 200, h: 80, rot: 90, fill: '#ff0000' }] };
  const pptx = require('../src/core/pptx').buildPptx([scene], { title: 'T' });
  assert.ok(pptx.find((e) => e.name === 'ppt/slides/slide1.xml').data.includes('<a:xfrm rot="5400000">'));
  const odp = require('../src/core/odp').buildOdp([scene], { title: 'T' });
  assert.match(odp.find((e) => e.name === 'content.xml').data, /draw:transform="rotate\(-1\.570796\) translate\(/);
});

test('セキュリティ: プロジェクトの外を指すパスは inside が null を返す（Windows の書き方も）', () => {
  const P = require('../src/app/pathx');
  for (const rel of ['..\\x', '../x', 'a/../../x', 'a\\..\\..\\x', 'C:\\Windows\\win.ini', 'C:/x', 'D:\\x', '\\\\server\\share\\x', '/etc/passwd']) {
    assert.equal(P.inside('C:\\p\\deck', rel), null, rel);
  }
  assert.equal(P.inside('C:\\p\\deck', 'assets\\a.png'), 'C:\\p\\deck\\assets\\a.png');
});
