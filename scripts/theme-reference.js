#!/usr/bin/env node
/*
 * テーマのリファレンスを、設定項目の定義元（src/core/schema.js）から作り直す。
 *
 *   node scripts/theme-reference.js
 *
 * 出力:
 *   docs/THEME_REFERENCE.md … theme.json の全項目（トークン・アニメーション・表示）と theme.css で使える変数・属性・クラス
 *   docs/theme.schema.json  … theme.json の JSON Schema（VS Code などで "$schema" を指定すると、入力の候補と検査が出る）
 * schema.js の TOKENS などを変えたら実行し直す（テストで、出力が最新かを確かめている）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const schema = require('../src/core/schema');

const ROOT = path.resolve(__dirname, '..');
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const code = (v) => '`' + String(v).replace(/\|/g, '\\|') + '`';
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

const TYPE_LABEL = {
  color: '色（`#rrggbb` など CSS の色）',
  number: '数値',
  font: 'フォント（CSS の font-family）',
  select: '選択',
  css: 'CSS の background の値',
  char: '文字（記号 1〜2 文字）',
};

function defaultText(d) {
  if (d.default === '' || d.default == null) return d.optional ? '（空 = 自動）' : '（空）';
  if (d.type === 'font') return '既定のフォント（下の「フォント」）';
  return code(d.default) + (d.unit ? ' ' + d.unit : '');
}
function valuesText(d) {
  if (d.type === 'select') return d.options.map((o) => code(o[0]) + ' ' + o[1]).join('<br>');
  if (d.type === 'number') return d.min + '〜' + d.max + (d.unit ? ' ' + d.unit : '') + (d.step ? '（' + d.step + ' 刻み）' : '');
  if (d.type === 'color') return d.optional ? '色、または空（自動）' : '色';
  return TYPE_LABEL[d.type] || d.type;
}
function cssText(d) {
  if (d.out === 'attr') return '.ks-deck の ' + code('data-' + kebab(d.key));
  if (d.out === 'none') return '（CSS には出ない）';
  return code('--ks-' + kebab(d.key));
}

function markdown() {
  const L = [];
  const p = (s) => L.push(s == null ? '' : s);
  p('# テーマのリファレンス（theme.json / theme.css）');
  p();
  p('> このファイルは `node scripts/theme-reference.js` で `src/core/schema.js` から作っています（手で書き換えないでください）。');
  p('> 作り方の流れは [THEMES.md](THEMES.md) を見てください。');
  p();
  p('## テーマのフォルダ');
  p();
  p('```');
  p('my-brand/            ← フォルダ名がテーマ ID（半角英小文字・数字・ハイフン・下線）');
  p('  theme.json         ← 必須。色・フォント・余白などの値');
  p('  theme.css          ← 任意。値では表せない飾り');
  p('```');
  p();
  p('使えるようにするには、次のどれかをします。');
  p();
  p('- アプリの「デザイン」→「テーマ」→「自作テーマを読み込む・書き出す」で、フォルダ・theme.json・zip を読み込む（ユーザーのテーマにコピーされる）');
  p('- 「テーマのフォルダを開く」で開いたフォルダ（Windows: `%APPDATA%\\Kamishibai\\themes`）に、フォルダごと置く');
  p('- プロジェクトの `themes/<ID>/` に置く（そのプロジェクトだけで使う。.kami にも入る）');
  p();
  p('同じ ID のテーマがあるときは「プロジェクト → ユーザー → 同梱」の順に先に見つかったものを使います。同梱テーマと同じ ID は読み込めません。');
  p();
  p('## theme.json');
  p();
  p('```json');
  p(JSON.stringify({
    $schema: 'https://raw.githubusercontent.com/FUJIYAMA2236/kamishibai/main/docs/theme.schema.json',
    name: '自社ブランド',
    description: '一覧に出る説明',
    category: 'simple',
    order: 50,
    aspect: '16:9',
    tokens: { bg: '#ffffff', text: '#1f2430', accent: '#d9480f', accent2: '#1971c2', headingStyle: 'bar', lineBreak: 'phrase' },
    animation: { transition: 'fade', entrance: 'rise' },
    chrome: { pageNumber: true, progress: true },
  }, null, 2));
  p('```');
  p();
  p('| キー | 内容 |');
  p('| --- | --- |');
  p('| `$schema` | 任意。上の URL を書くと、VS Code などで入力の候補と間違いの指摘が出る（Kamishibai は読み飛ばす） |');
  p('| `name` | 一覧に出る名前（省略すると ID） |');
  p('| `description` | 一覧・「テーマ」タブに出る説明 |');
  p('| `category` | 一覧での分類: `simple`（シンプル）/ `decorative`（装飾あり） |');
  p('| `order` | 一覧での並び順（小さいほど先。省略すると 100） |');
  p('| `aspect` | スライドの縦横比: ' + Object.entries(schema.ASPECTS).map(([k, v]) => code(k) + '（' + v.w + '×' + v.h + ' px）').join(' / ') + '。デッキで選んだものが優先 |');
  p('| `tokens` | 色・文字・形の値（下の表）。書かなかったものは既定値 |');
  p('| `animation` | 動き（下の表） |');
  p('| `chrome` | ページ番号・進捗バー（下の表） |');
  p();
  p('値の優先順位: 既定値 < テーマ（theme.json）< デッキの調整（deck.json の `tokens`）< スライド個別（deck.json の `slides.<ID>`）');
  p();
  p('## tokens');
  p();
  for (const [gid, glabel] of schema.TOKEN_GROUPS) {
    const defs = schema.TOKENS.filter((d) => d.group === gid);
    if (!defs.length) continue;
    p('### ' + glabel);
    p();
    p('| キー | 内容 | 既定値 | 書ける値 | CSS での名前 |');
    p('| --- | --- | --- | --- | --- |');
    for (const d of defs) {
      const extra = d.showIf ? '（' + Object.entries(d.showIf).map(([k, v]) => code(k) + ' が ' + code(v)).join('、') + ' のとき）' : '';
      p('| ' + code(d.key) + ' | ' + cell(d.label) + extra + ' | ' + defaultText(d) + ' | ' + valuesText(d) + ' | ' + cssText(d) + ' |');
    }
    p();
  }
  p('`bgSlide` `bgTitle` `bgSection` の中では、ほかのトークンを `var(--ks-accent)` のように使えます:');
  p();
  p('```json');
  p('"bgTitle": "radial-gradient(900px 520px at 90% -10%, color-mix(in srgb, var(--ks-accent) 34%, transparent), transparent 62%), var(--ks-bg)"');
  p('```');
  p();
  p('### フォント');
  p();
  p('`fontHeading` `fontBody` `fontMono` は CSS の font-family の形で書きます。テーマのフォントは「見る人の PC に入っているもの」が使われるので、');
  p('最後に `sans-serif` などを付け、日本語のフォントを複数並べておくと安全です。デザインパネルの選択肢は次のとおりです。');
  p();
  p('| 選択肢 | 値 |');
  p('| --- | --- |');
  for (const f of schema.FONT_PRESETS) p('| ' + cell(f.label) + ' | ' + code(f.value) + ' |');
  p();
  p('## animation');
  p();
  p('| キー | 内容 | 既定値 | 書ける値 |');
  p('| --- | --- | --- | --- |');
  for (const [k, d] of Object.entries(schema.ANIMATION)) {
    const vals = d.options ? d.options.map((o) => code(o[0]) + ' ' + o[1]).join('<br>') : d.min + '〜' + d.max;
    p('| ' + code(k) + ' | ' + cell(d.label) + ' | ' + code(d.default) + ' | ' + vals + ' |');
  }
  p();
  p('## chrome');
  p();
  p('| キー | 内容 | 既定値 |');
  p('| --- | --- | --- |');
  for (const [k, d] of Object.entries(schema.CHROME)) {
    if (k === 'footer') continue; // フッターの文はデッキごとに決めるもの
    p('| ' + code(k) + ' | ' + cell(d.label) + '（' + (d.type === 'bool' ? '`true` / `false`' : d.type) + '） | ' + code(d.default) + ' |');
  }
  p();
  p('## theme.css');
  p();
  p('theme.css は、ツールのスタイル（runtime.css）の後ろにそのまま読み込まれます。スライドはすべて `.ks-deck` の中にあるので、');
  p('セレクタは `.ks-deck` から書いてください（エディタの画面そのものに効かないように）。');
  p();
  p('```css');
  p('/* タイトルを大文字に */');
  p('.ks-deck .ks-layout-title h1 { text-transform: uppercase; }');
  p();
  p('/* 通常のスライドの右上に、薄い光の飾り */');
  p('.ks-deck .ks-slide:not(.ks-layout-title) > .ks-bg::before {');
  p("  content: '';");
  p('  position: absolute;');
  p('  inset: 0;');
  p('  background: radial-gradient(600px 300px at 100% 0%, color-mix(in srgb, var(--ks-accent) 12%, transparent), transparent 70%);');
  p('}');
  p();
  p('/* セクションのスライドだけ色を反転 */');
  p('.ks-deck .ks-layout-section { --ks-bg: var(--ks-accent); --ks-text: #fff; --ks-muted: #ffffffcc; }');
  p('```');
  p();
  p('### 1 枚のスライドの構造');
  p();
  p('```html');
  p('<div class="ks-deck" data-aspect="16:9" data-heading-style="bar" …>   ← トークンの CSS 変数と data 属性はここに付く');
  p('  <div class="ks-stage">');
  p('    <section class="ks-slide ks-layout-content" data-layout="content" data-align="left" data-valign="top" …>');
  p('      <div class="ks-bg"></div>                   ← 背景。全面の画像もここ。::before / ::after で飾りを足せる');
  p('      <div class="ks-inner">');
  p('        <div class="ks-main">');
  p('          <header class="ks-head"><h2>見出し</h2></header>');
  p('          <div class="ks-body"> 本文（p, ul, ol, table, pre.ks-code, figure.ks-figure, div.ks-mermaid, blockquote …）</div>');
  p('        </div>');
  p('        <div class="ks-media"><img></div>        ← 画像：右 / 左 のときの画像');
  p('      </div>');
  p('      <div class="ks-chrome"><span class="ks-footer"></span><span class="ks-page"><b>3</b><i> / 12</i></span></div>');
  p('    </section>');
  p('    <div class="ks-progress"></div>              ← 進捗バー');
  p('  </div>');
  p('</div>');
  p('```');
  p();
  p('カラムのスライドでは `.ks-body` の中が `.ks-cols-pre`（カラムの前の全幅の部分）→ `.ks-cols` > `.ks-col` × 列数 → `.ks-cols-post`（後ろの全幅の部分）になります。');
  p();
  p('### クラス');
  p();
  p('| セレクタ | 対象 |');
  p('| --- | --- |');
  p('| `.ks-slide` | スライド 1 枚 |');
  p('| ' + schema.LAYOUTS.map(([id]) => code('.ks-layout-' + id)).join(' ') + ' | レイアウト別（' + schema.LAYOUTS.map(([, l]) => l).join(' / ') + '） |');
  p('| `.ks-bg` / `.ks-inner` / `.ks-main` | 背景 / 中身の外枠 / 見出しと本文 |');
  p('| `.ks-head` / `.ks-body` / `.ks-media` | 見出し / 本文 / 横に置いた画像 |');
  p('| `.ks-cols` / `.ks-col` / `.ks-cols-pre` / `.ks-cols-post` | カラム全体 / 1 列 / カラムの前後の全幅の部分 |');
  p('| `.ks-code` / `.ks-figure` / `.ks-mermaid` | コード / 画像だけの段落（図） / mermaid の図 |');
  p('| `.ks-chrome` / `.ks-footer` / `.ks-page` / `.ks-progress` | フッターの帯 / フッターの文 / ページ番号 / 進捗バー |');
  p();
  p('### data 属性');
  p();
  p('| 付く場所 | 属性 | 値 |');
  p('| --- | --- | --- |');
  p('| `.ks-deck` | `data-aspect` | ' + Object.keys(schema.ASPECTS).map(code).join(' ') + ' |');
  for (const d of schema.TOKENS.filter((x) => x.out === 'attr')) p('| `.ks-deck` | ' + code('data-' + kebab(d.key)) + ' | ' + d.options.map((o) => code(o[0])).join(' ') + '（トークン ' + code(d.key) + '） |');
  p('| `.ks-slide` | `data-layout` | ' + schema.LAYOUTS.map(([id]) => code(id)).join(' ') + ' |');
  p('| `.ks-slide` | `data-align` / `data-valign` | `left` `center` / `top` `center` |');
  p('| `.ks-slide` | `data-col-style` / `data-col-align` / `data-col-valign` | カラムのスライドだけ。`none` `outline` `fill` `card` / `left` `center` / `top` `center` `bottom` |');
  p('| `.ks-slide` | `data-col-dir` | カラムのスライドだけ。並べ方: `row`（横）`column`（縦）`grid`（2 列の格子） |');
  p('| `.ks-slide` | `data-transition` / `data-entrance` / `data-build` | アニメーション（上の表の値） |');
  p('| `.ks-cols` | `data-count` | 列の数 |');
  p();
  p('### CSS 変数');
  p();
  p('トークンの値（上の表の「CSS での名前」）のほかに、次の変数を使えます。');
  p();
  p('| 変数 | 内容 |');
  p('| --- | --- |');
  p('| `--ks-w` / `--ks-h` | スライドの幅・高さ（px。縦横比で変わる） |');
  p('| `--ks-border` | 文字色を薄くした線の色 |');
  p('| `--ks-soft` | 文字色をごく薄くした面の色 |');
  p('| `--ks-accent-soft` | アクセント色を薄くした面の色 |');
  p('| `--ks-grad` | アクセント → アクセント2 のグラデーション |');
  p('| `--ks-px` | 左右の余白（`padding` × 1.15） |');
  p('| `--ks-bg-slide` / `--ks-bg-title` / `--ks-bg-section` | 背景（トークン `bgSlide` などを書いたときだけ） |');
  p('| `--ks-col-c` / `--ks-on-c` | `.ks-col` の中で: その列の色 / その色の上の文字色 |');
  p('| `--ks-progress` | 進捗（0〜1） |');
  p();
  p('### 気をつけること');
  p();
  p('- theme.css から外のファイル（画像・フォント）は読めません。画像は `data:` URI で埋め込むか、トークンの背景（グラデーションなど）で表してください。');
  p('- .pptx / .odp に書き出すとき、再現されるのは「計算された見た目」のうち、背景色・直線のグラデーション・枠線・角丸・上の帯（`box-shadow: inset 0 N 0 色`）・文字の色や太さです。');
  p('  `::before` / `::after` の飾りや、円形のグラデーションは書き出されません（HTML・PDF には出ます）。');
  p('- シンプルなテーマ（`category: simple`）は、背景にグラデーションを使わず、`headingStyle` に `gradient` を使わない決まりです（同梱テーマはテストで確認しています）。');
  p('- `accent2` を `accent` と同じ色にすると、見出しの下線や進捗バーも単色になります。');
  p();
  return L.join('\n');
}

function jsonSchema() {
  const tokenProps = {};
  for (const d of schema.TOKENS) {
    const s = { description: d.label + (d.unit ? '（' + d.unit + '）' : '') };
    if (d.type === 'number') Object.assign(s, { type: 'number', minimum: d.min, maximum: d.max, default: d.default });
    else if (d.type === 'select') Object.assign(s, { type: 'string', enum: d.options.map((o) => o[0]), default: d.default, markdownEnumDescriptions: d.options.map((o) => o[1]) });
    else Object.assign(s, { type: 'string', default: d.default });
    tokenProps[d.key] = s;
  }
  const animProps = {};
  for (const [k, d] of Object.entries(schema.ANIMATION)) {
    animProps[k] = d.options
      ? { description: d.label, type: 'string', enum: d.options.map((o) => o[0]), default: d.default }
      : { description: d.label, type: 'number', minimum: d.min, maximum: d.max, default: d.default };
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://raw.githubusercontent.com/FUJIYAMA2236/kamishibai/main/docs/theme.schema.json',
    title: 'Kamishibai theme.json',
    description: 'Kamishibai のテーマ（themes/<ID>/theme.json）。docs/THEME_REFERENCE.md も参照。scripts/theme-reference.js で生成。',
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      name: { type: 'string', description: '一覧に出る名前' },
      description: { type: 'string', description: '説明' },
      category: { type: 'string', enum: ['simple', 'decorative'], description: '一覧での分類' },
      order: { type: 'number', description: '並び順（小さいほど先）' },
      aspect: { type: 'string', enum: Object.keys(schema.ASPECTS), description: 'スライドの縦横比' },
      tokens: { type: 'object', properties: tokenProps, additionalProperties: false },
      animation: { type: 'object', properties: animProps, additionalProperties: false },
      chrome: {
        type: 'object',
        properties: { pageNumber: { type: 'boolean', description: 'ページ番号' }, progress: { type: 'boolean', description: '進捗バー' } },
      },
    },
    additionalProperties: false,
  };
}

function build() {
  return {
    'docs/THEME_REFERENCE.md': markdown() + '\n',
    'docs/theme.schema.json': JSON.stringify(jsonSchema(), null, 2) + '\n',
  };
}

if (require.main === module) {
  for (const [rel, text] of Object.entries(build())) {
    fs.writeFileSync(path.join(ROOT, rel), text);
    console.log('書き出しました: ' + rel);
  }
}
module.exports = { build };
