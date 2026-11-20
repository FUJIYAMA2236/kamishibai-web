/*
 * schema.js — デザイン設定の「唯一の定義元」。
 *
 * ここに書いたトークン定義から、
 *   - CSS 変数（--ks-*）と data 属性の生成（render.js）
 *   - エディタのデザインパネルの UI（editor.js）
 *   - テーマ / deck.json の既定値
 * がすべて導出される。新しい調整項目を足すときは、まずここに 1 行足す。
 *
 * Node（require）とブラウザ（window.KS.schema）の両方で動く UMD 形式。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.KS = root.KS || {}).schema = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // スライドの論理サイズ（px）。画面には CSS transform で拡大縮小して表示する。
  const ASPECTS = {
    '16:9': { w: 1280, h: 720 },
    '16:10': { w: 1152, h: 720 },
    '4:3': { w: 960, h: 720 },
  };

  const FONT_PRESETS = [
    {
      id: 'gothic',
      label: 'ゴシック（標準）',
      value: '"Inter", "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "BIZ UDPGothic", "Yu Gothic UI", "Meiryo", "Noto Sans JP", sans-serif',
    },
    {
      id: 'ud',
      label: 'UDゴシック（太め）',
      value: '"BIZ UDPGothic", "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans JP", sans-serif',
    },
    {
      id: 'mincho',
      label: '明朝',
      value: '"Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "BIZ UDPMincho", "Noto Serif JP", "Times New Roman", serif',
    },
    {
      id: 'rounded',
      label: '丸ゴシック',
      value: '"Hiragino Maru Gothic ProN", "Zen Maru Gothic", "Kosugi Maru", "BIZ UDPGothic", "Meiryo UI", "Meiryo", sans-serif',
    },
    {
      id: 'grotesk',
      label: '欧文グロテスク + ゴシック',
      value: '"Helvetica Neue", "Arial", "Hiragino Sans", "BIZ UDPGothic", "Yu Gothic UI", "Meiryo", sans-serif',
    },
    {
      id: 'mono',
      label: '等幅',
      value: '"Cascadia Code", "SF Mono", "Consolas", "BIZ UDGothic", "MS Gothic", "Osaka-Mono", monospace',
    },
  ];
  const font = (id) => FONT_PRESETS.find((f) => f.id === id).value;

  /*
   * トークン定義。
   *   key     : theme.json / deck.json の tokens 内のキー
   *   type    : color | number | font | select | css | char（記号 1 文字など。CSS では "文字列" として出す）
 *   optional: 空欄を許す（color のとき。空欄 = 自動）
 *   showIf  : { 別のキー: 値 } のときだけ GUI に出す
   *   out     : 'var'  → CSS 変数 --ks-<kebab(key)> として出力
   *             'attr' → .ks-deck の data-<kebab(key)> 属性として出力（CSS で見た目を切り替える）
   *             'none' → どちらも出さない（render.js が計算に使う）
   *   unit    : number のとき付ける単位
   *   perSlide: スライド単位の上書きを GUI に出すか
   */
  const TOKENS = [
    // ---- 色 ----
    { key: 'bg', group: 'color', label: '背景', type: 'color', default: '#0b1020', perSlide: true },
    { key: 'surface', group: 'color', label: 'パネル（コード等）', type: 'color', default: '#141b33' },
    { key: 'text', group: 'color', label: '文字', type: 'color', default: '#e8ecf8', perSlide: true },
    { key: 'muted', group: 'color', label: '補助文字', type: 'color', default: '#8f9bbd' },
    { key: 'accent', group: 'color', label: 'アクセント', type: 'color', default: '#7c9cff', perSlide: true },
    { key: 'accent2', group: 'color', label: 'アクセント2', type: 'color', default: '#5eead4' },

    // ---- 文字 ----
    { key: 'fontHeading', group: 'type', label: '見出しフォント', type: 'font', default: font('gothic') },
    { key: 'fontBody', group: 'type', label: '本文フォント', type: 'font', default: font('gothic') },
    { key: 'fontMono', group: 'type', label: 'コードフォント', type: 'font', default: font('mono') },
    { key: 'baseSize', group: 'type', label: '本文サイズ', type: 'number', unit: 'px', min: 18, max: 40, step: 1, default: 28 },
    { key: 'headingScale', group: 'type', label: '見出しの大きさ', type: 'number', min: 1.1, max: 2.4, step: 0.05, default: 1.6 },
    { key: 'titleScale', group: 'type', label: 'タイトルの大きさ', type: 'number', min: 1.6, max: 4.5, step: 0.1, default: 2.8 },
    { key: 'headingWeight', group: 'type', label: '見出しの太さ', type: 'number', min: 300, max: 900, step: 100, default: 700 },
    { key: 'lineHeight', group: 'type', label: '行間', type: 'number', min: 1.2, max: 2.2, step: 0.05, default: 1.6 },
    { key: 'letterSpacing', group: 'type', label: '見出しの字間', type: 'number', unit: 'em', min: -0.05, max: 0.2, step: 0.01, default: 0.01 },
    // 日本語の折り返し。phrase = 文節の切れ目で折り返し、短い文は行の長さをそろえる（Chrome / Edge / WebView2 の word-break: auto-phrase）
    {
      key: 'lineBreak', group: 'type', label: '日本語の折り返し', type: 'select', out: 'attr', default: 'phrase',
      options: [['phrase', '文節で（読みやすく）'], ['char', '文字ごと（詰めて）']],
    },

    // ---- 形・余白 ----
    { key: 'padding', group: 'shape', label: '余白', type: 'number', unit: 'px', min: 32, max: 120, step: 2, default: 72 },
    { key: 'radius', group: 'shape', label: '角丸', type: 'number', unit: 'px', min: 0, max: 40, step: 1, default: 14 },
    {
      key: 'headingStyle', group: 'shape', label: '見出しの飾り', type: 'select', out: 'attr', default: 'plain',
      options: [['plain', 'なし'], ['bar', '左バー'], ['underline', '下線'], ['gradient', 'グラデ文字'], ['tag', '帯']],
    },
    {
      key: 'bulletStyle', group: 'shape', label: '箇条書きの記号', type: 'select', out: 'attr', default: 'dot',
      options: [['dot', '●'], ['dash', '–'], ['arrow', '→'], ['check', '✓'], ['square', '■'], ['custom', '好きな記号…']],
    },
    // bulletStyle が custom のときの記号（1 段目 / 2 段目以降）。CSS では文字列として使う（type: char）
    { key: 'bulletChar', group: 'shape', label: '記号（1 段目）', type: 'char', default: '◆', showIf: { bulletStyle: 'custom' } },
    { key: 'bulletChar2', group: 'shape', label: '記号（2 段目〜）', type: 'char', default: '–', showIf: { bulletStyle: 'custom' } },
    {
      key: 'titleAlign', group: 'shape', label: 'タイトルの位置', type: 'select', out: 'attr', default: 'left',
      options: [['left', '左寄せ'], ['center', '中央']],
    },
    {
      key: 'bodyAlign', group: 'shape', label: '本文の縦位置', type: 'select', out: 'attr', default: 'top',
      options: [['top', '上'], ['center', '中央']],
    },

    // ---- カラムの囲み（スライドごとの指定は「このスライド」タブ。そちらが優先） ----
    {
      key: 'colStyle', group: 'columns', label: '囲み', type: 'select', out: 'attr', default: 'none',
      options: [['none', 'なし'], ['outline', '枠線'], ['fill', '塗り'], ['card', 'カード']],
    },
    // カラムの並べ方（row = 横に並べる / column = 縦に並べる / grid = 2 列の格子）。
    // スライドごとの指定（このスライド）と、原稿の「::: rows」「::: grid」の囲みが優先。render.js が data-col-dir にする
    {
      key: 'colDir', group: 'columns', label: '並べ方', type: 'select', out: 'none', default: 'row',
      options: [['row', '横に並べる'], ['column', '縦に並べる'], ['grid', '格子（2 列）']],
    },
    // カラム内の文字の位置（auto = 箱のときは中央・左右は中央、箱なしは上・左）
    {
      key: 'colAlign', group: 'columns', label: '文字の横位置', type: 'select', out: 'none', default: 'auto',
      options: [['auto', '自動'], ['left', '左'], ['center', '中央']],
    },
    {
      key: 'colValign', group: 'columns', label: '文字の縦位置', type: 'select', out: 'none', default: 'auto',
      options: [['auto', '自動'], ['top', '上詰め'], ['center', '中央'], ['bottom', '下詰め']],
    },
    { key: 'boxRadius', group: 'columns', label: '箱の角丸', type: 'number', unit: 'px', min: 0, max: 48, step: 1, default: 20 },
    // 空欄 = アクセント色から自動。CSS 変数としては出さず、render.columnColorStyle が使う（out: none）
    { key: 'colColor1', group: 'columns', label: 'カラム1の色', type: 'color', optional: true, out: 'none', default: '' },
    { key: 'colColor2', group: 'columns', label: 'カラム2の色', type: 'color', optional: true, out: 'none', default: '' },
    { key: 'colColor3', group: 'columns', label: 'カラム3の色', type: 'color', optional: true, out: 'none', default: '' },
    { key: 'colColor4', group: 'columns', label: 'カラム4の色', type: 'color', optional: true, out: 'none', default: '' },
    {
      key: 'colText', group: 'columns', label: '塗りの上の文字', type: 'select', out: 'none', default: 'auto',
      options: [['auto', '自動（色の明るさで）'], ['light', '白'], ['dark', '黒']],
    },

    // ---- 背景（上級者向け：CSS の background 値をそのまま書ける） ----
    { key: 'bgSlide', group: 'advanced', label: '通常スライド背景', type: 'css', default: '', placeholder: '例: linear-gradient(#fff, #eee)' },
    { key: 'bgTitle', group: 'advanced', label: 'タイトル背景', type: 'css', default: '', placeholder: '空欄 = 通常と同じ' },
    { key: 'bgSection', group: 'advanced', label: 'セクション背景', type: 'css', default: '', placeholder: '空欄 = 通常と同じ' },
  ];

  const TOKEN_GROUPS = [
    ['color', '色'],
    ['type', '文字'],
    ['shape', '形・レイアウト'],
    ['columns', 'カラムの囲み'],
    ['advanced', '背景（CSS）'],
  ];

  const LAYOUTS = [
    ['title', 'タイトル'],
    ['section', 'セクション'],
    ['content', '標準'],
    ['center', '中央寄せ'],
    ['columns', 'カラム'],
    ['image-right', '画像：右'],
    ['image-left', '画像：左'],
    ['image-full', '画像：全面'],
    ['quote', '引用'],
    ['grid', '升目（手動配置）'],
  ];

  const ANIMATION = {
    transition: {
      label: 'スライド切り替え', default: 'fade',
      options: [['none', 'なし'], ['fade', 'フェード'], ['slide', 'スライド'], ['zoom', 'ズーム'], ['blur', 'ぼかし']],
    },
    entrance: {
      label: '要素の登場', default: 'rise',
      options: [['none', 'なし'], ['fade', 'フェード'], ['rise', '下からふわっと'], ['slide', '横からすっと'], ['zoom', 'ズーム'], ['blur', 'ぼかし']],
    },
    build: {
      label: '段階表示', default: 'none',
      options: [['none', 'しない（一度に表示）'], ['items', 'クリックごとに1項目']],
    },
    duration: { label: '速さ (ms)', type: 'number', min: 200, max: 1400, step: 50, default: 650 },
    stagger: { label: 'ずらし (ms)', type: 'number', min: 0, max: 240, step: 10, default: 70 },
  };

  const CHROME = {
    pageNumber: { label: 'ページ番号', type: 'bool', default: true },
    progress: { label: '進捗バー', type: 'bool', default: true },
    footer: { label: 'フッター', type: 'text', default: '', placeholder: '{title} / {author} / {date} が使えます' },
  };

  function defaults(def) {
    const out = {};
    for (const [k, v] of Object.entries(def)) out[k] = v.default;
    return out;
  }

  const DEFAULT_TOKENS = {};
  for (const t of TOKENS) DEFAULT_TOKENS[t.key] = t.default;

  return {
    ASPECTS,
    DEFAULT_ASPECT: '16:9',
    FONT_PRESETS,
    TOKENS,
    TOKEN_GROUPS,
    LAYOUTS,
    ANIMATION,
    CHROME,
    DEFAULT_TOKENS,
    DEFAULT_ANIMATION: defaults(ANIMATION),
    DEFAULT_CHROME: defaults(CHROME),
    DEFAULT_THEME: 'midnight',
  };
});
