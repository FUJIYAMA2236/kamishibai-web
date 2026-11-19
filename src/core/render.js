/*
 * render.js — 解析済みデッキ + デザイン設定 + テーマ → スライドの HTML 断片と CSS 変数。
 *
 * エディタのプレビュー（ブラウザ）と HTML 書き出し（Node）が、まったく同じこの関数を通る。
 * 「プレビューと書き出し結果が違う」を構造的に起こさないための設計なので、
 * 見た目に関わる処理をエディタ側や build.js 側に個別に書かないこと。
 *
 * DOM に依存する処理（アニメーション順の付与、mermaid 描画、はみ出し時の自動縮小）は
 * src/runtime/runtime.js 側にある。
 *
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schema'), require('./parse'));
  else (root.KS = root.KS || {}).render = factory(root.KS.schema, root.KS.parse);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (schema, parse) {
  'use strict';

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kebab = (s) => String(s).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const TOKEN_BY_KEY = {};
  for (const t of schema.TOKENS) TOKEN_BY_KEY[t.key] = t;
  const LAYOUT_IDS = schema.LAYOUTS.map((l) => l[0]);

  // ------------------------------------------------------------------
  // Markdown
  // ------------------------------------------------------------------

  // 画像の大きさとして受け付ける値（CSS をそのまま書き込まれないように、数値と単位だけ）
  const SIZE_RE = /^\d+(?:\.\d+)?(?:px|%|em|rem|vw|vh)$/;
  function parseImageAttrs(text) {
    const out = parse.parseAttrs(text);
    const px = (v) => (v && /^[\d.]+$/.test(v) ? v + 'px' : v);
    out.width = SIZE_RE.test(px(out.width) || '') ? px(out.width) : undefined;
    out.height = SIZE_RE.test(px(out.height) || '') ? px(out.height) : undefined;
    out.classes = (out.classes || []).filter((c) => /^[\w-]+$/.test(c));
    return out;
  }

  /**
   * 画像の参照先。プロジェクトの中の相対パス・data:image・http(s) だけを通す（file: や javascript: などは捨てる）。
   * http(s) の画像は、アプリと書き出した HTML では CSP で読まない（オフラインで動き、開いただけで外部に通信しないように）。
   */
  function resolveSrc(env, src) {
    if (!src) return '';
    if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif);/i.test(src) || /^https?:\/\//i.test(src) || /^blob:/i.test(src)) return src;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(src)) return ''; // ほかのスキーム・ネットワークパス
    return env && typeof env.resolveAsset === 'function' ? env.resolveAsset(src) : src;
  }

  // ------------------------------------------------------------------
  // 原稿に書いた HTML の無害化
  // ------------------------------------------------------------------
  // 原稿（.kami などで他人から受け取ることがある）に書かれた HTML は、次のタグだけを通す。属性は class だけ（英数字・ハイフン・下線）。
  // それ以外のタグ（script・img・iframe・style・a など）と、on〜 などの属性は、文字としてそのまま見せる（実行されない）。
  // コメント（<!-- -->）は消す。markdown-it の html_block / html_inline の両方に効かせる。
  const SAFE_TAGS = new Set([
    'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'kbd', 'code', 'samp', 'var', 'abbr', 'q', 'cite',
    'span', 'div', 'p', 'br', 'hr', 'ruby', 'rt', 'rp', 'details', 'summary', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'center',
  ]);
  const VOID_TAGS = new Set(['br', 'hr']);
  const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*(\/?)>|[<>]/g;
  function sanitizeHtml(html) {
    return String(html).replace(TAG_RE, (m, close, name, attrs) => {
      if (m === '<') return '&lt;';
      if (m === '>') return '&gt;';
      if (m.startsWith('<!--')) return '';
      const tag = name.toLowerCase();
      if (!SAFE_TAGS.has(tag)) return esc(m);
      if (close) return VOID_TAGS.has(tag) ? '' : '</' + tag + '>';
      const cm = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/i.exec(attrs || '');
      const cls = cm ? String(cm[1] || cm[2] || cm[3] || '').split(/\s+/).filter((c) => /^[\w-]+$/.test(c)).join(' ') : '';
      return '<' + tag + (cls ? ' class="' + cls + '"' : '') + '>';
    });
  }

  function imageInfo(token, md, env) {
    const info = (token.meta && token.meta.ks) || { classes: [] };
    // env.ksImg があるときは、スライド内で何番目の画像かを数える（GUI で画像を操作するときの目印）
    const index = env && env.ksImg ? env.ksImg.n++ : null;
    return {
      index,
      rawSrc: token.attrGet('src') || '',
      src: resolveSrc(env, token.attrGet('src')),
      alt: md.renderer.renderInlineAsText(token.children || [], md.options, env),
      title: token.attrGet('title') || '',
      width: info.width,
      height: info.height,
      classes: info.classes || [],
    };
  }

  function imgTag(img, extraClass) {
    const style = [img.width ? 'width:' + img.width : '', img.height ? 'height:' + img.height : ''].filter(Boolean).join(';');
    const cls = [extraClass].concat(img.classes).filter(Boolean).join(' ');
    return (
      '<img src="' + esc(img.src) + '" alt="' + esc(img.alt) + '"' +
      (cls ? ' class="' + esc(cls) + '"' : '') +
      (style ? ' style="' + esc(style) + '"' : '') +
      (img.index != null ? ' data-img="' + img.index + '" data-src="' + esc(img.rawSrc) + '"' : '') +
      ' draggable="false">'
    );
  }

  /**
   * markdown-it のインスタンスを作る。
   * @param {Function} markdownit vendor/markdown-it.min.js の export
   * @param {Object} [hljs] vendor/highlight.min.js の export（無ければハイライトなし）
   */
  function createMarkdown(markdownit, hljs) {
    const md = markdownit({ html: true, linkify: true, breaks: true });
    // 原稿の HTML は許可したタグだけを通す（上の sanitizeHtml）。<script> や onerror などは文字として表示する
    md.renderer.rules.html_block = (tokens, idx) => sanitizeHtml(tokens[idx].content);
    md.renderer.rules.html_inline = (tokens, idx) => sanitizeHtml(tokens[idx].content);
    // リンクは http(s)・mailto・ページ内（#）・相対パスだけ（javascript: などは markdown-it も弾くが、念のため狭める）
    md.validateLink = (url) => {
      const u = String(url).trim();
      return !/^[a-z][a-z0-9+.-]*:/i.test(u) || /^(?:https?|mailto):/i.test(u) || /^data:image\/(?:png|jpe?g|gif|webp|avif);/i.test(u);
    };

    md.renderer.rules.fence = function (tokens, idx) {
      const t = tokens[idx];
      const lang = (t.info || '').trim().split(/\s+/)[0];
      if (lang === 'mermaid') {
        return '<div class="ks-mermaid"><pre class="ks-mermaid-src">' + esc(t.content) + '</pre><div class="ks-mermaid-out"></div></div>\n';
      }
      let body = '';
      if (hljs && lang && hljs.getLanguage(lang)) {
        try { body = hljs.highlight(t.content, { language: lang, ignoreIllegals: true }).value; } catch (e) { body = ''; }
      }
      if (!body) body = esc(t.content);
      return '<pre class="ks-code"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>' + body + '</code></pre>\n';
    };

    md.renderer.rules.image = function (tokens, idx, options, env) {
      return imgTag(imageInfo(tokens[idx], md, env));
    };

    const defaultLinkOpen =
      md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      const href = tokens[idx].attrGet('href') || '';
      if (!href.startsWith('#')) {
        tokens[idx].attrSet('target', '_blank');
        tokens[idx].attrSet('rel', 'noopener');
      }
      return defaultLinkOpen(tokens, idx, options, env, self);
    };

    // ![alt](src){width=50% .class} の {…} を画像トークンに取り込む
    md.core.ruler.push('ks_image_attrs', function (state) {
      for (const tok of state.tokens) {
        if (tok.type !== 'inline' || !tok.children) continue;
        const ch = tok.children;
        for (let i = 0; i < ch.length - 1; i++) {
          if (ch[i].type !== 'image' || ch[i + 1].type !== 'text') continue;
          const m = /^\{([^}]*)\}/.exec(ch[i + 1].content);
          if (!m) continue;
          ch[i].meta = Object.assign({}, ch[i].meta, { ks: parseImageAttrs(m[1]) });
          ch[i + 1].content = ch[i + 1].content.slice(m[0].length);
        }
      }
    });

    return md;
  }

  // ------------------------------------------------------------------
  // ブロック分解: スライド本文をトップレベルのブロック単位に分け、種類を判定する
  // ------------------------------------------------------------------

  function standaloneImages(group) {
    if (group.length !== 3 || group[0].type !== 'paragraph_open') return null;
    const children = group[1].children || [];
    const images = children.filter((c) => c.type === 'image');
    if (!images.length) return null;
    const onlyImages = children.every(
      (c) => c.type === 'image' || c.type === 'softbreak' || c.type === 'hardbreak' || (c.type === 'text' && !c.content.trim())
    );
    return onlyImages ? images : null;
  }

  function figureHtml(images) {
    if (images.length === 1) {
      const img = images[0];
      const sized = img.width || img.height;
      return (
        '<figure class="ks-figure' + (sized ? ' ks-sized' : '') + '">' + imgTag(img) +
        (img.title ? '<figcaption>' + esc(img.title) + '</figcaption>' : '') + '</figure>\n'
      );
    }
    return '<figure class="ks-figure ks-figure-row">' + images.map((i) => imgTag(i)).join('') + '</figure>\n';
  }

  const BLOCK_TYPES = {
    heading_open: 'heading', paragraph_open: 'text', bullet_list_open: 'list', ordered_list_open: 'list',
    blockquote_open: 'quote', table_open: 'table', fence: 'code', code_block: 'code', html_block: 'html', hr: 'hr',
  };

  function toBlocks(md, source, env) {
    if (!source || !source.trim()) return [];
    const tokens = md.parse(source, env);
    const blocks = [];
    for (let i = 0; i < tokens.length; ) {
      let j = i;
      if (tokens[i].nesting === 1) {
        for (let depth = 1; depth > 0 && j + 1 < tokens.length; ) depth += tokens[++j].nesting;
      }
      const group = tokens.slice(i, j + 1);
      const first = group[0];
      const block = { type: BLOCK_TYPES[first.type] || 'text' };
      const images = standaloneImages(group);
      if (images) {
        block.images = images.map((t) => imageInfo(t, md, env));
        block.type = block.images.length === 1 ? 'image' : 'images';
        block.html = figureHtml(block.images);
      } else {
        if (block.type === 'heading') block.level = Number(first.tag.slice(1));
        if (first.type === 'fence' && (first.info || '').trim().split(/\s+/)[0] === 'mermaid') block.type = 'mermaid';
        block.html = md.renderer.render(group, md.options, env);
      }
      blocks.push(block);
      i = j + 1;
    }
    return blocks;
  }

  // ------------------------------------------------------------------
  // レイアウトの自動判定（GUI で「自動」のときに使われる）
  // ------------------------------------------------------------------

  function detectLayout(columns, pre, post) {
    const blocks = [].concat(pre || [], [].concat.apply([], columns), post || []);
    if (columns.length > 1) return 'columns';
    if (!blocks.length) return 'content';
    const first = blocks[0];
    const rest = blocks.filter((b) => b.type !== 'heading');
    const headings = blocks.length - rest.length;
    if (first.type === 'heading' && first.level === 1 && rest.length <= 3 && rest.every((b) => b.type === 'text')) return 'title';
    if (first.type === 'heading' && first.level === 2 && rest.length === 0) return 'section';
    if (rest.length === 1 && rest[0].type === 'quote' && headings <= 1) return 'quote';
    if (blocks.filter((b) => b.type === 'image').length === 1 && rest.length >= 2) return 'image-right';
    if (headings === 0 && rest.length <= 2 && rest.every((b) => b.type === 'text')) return 'center';
    return 'content';
  }

  // ------------------------------------------------------------------
  // デザインの解決と CSS 変数
  // ------------------------------------------------------------------

  function cssValue(key, value) {
    const def = TOKEN_BY_KEY[key];
    let v = value;
    if (def && def.type === 'number' && def.unit && v !== '' && !isNaN(Number(v))) v = v + def.unit;
    // 記号は CSS の文字列にする（list-style-type: var(--ks-bullet-char) で使う。後ろの空白は記号と文字の間隔）
    if (def && def.type === 'char') return '"' + Array.from(String(v).replace(/["\\;{}<>\n]/g, '')).slice(0, 4).join('') + '\u00a0 "';
    return String(v).replace(/[;{}<>]/g, '');
  }

  /** トークン（色・フォント等）→ "--ks-bg:#000;--ks-base-size:28px;…" */
  function tokensToStyle(tokens) {
    const parts = [];
    for (const key of Object.keys(tokens)) {
      const def = TOKEN_BY_KEY[key];
      if (def && (def.out === 'attr' || def.out === 'none')) continue;
      const value = tokens[key];
      if (value === '' || value == null) continue;
      parts.push('--ks-' + kebab(key) + ':' + cssValue(key, value));
    }
    return parts.join(';');
  }

  /** テーマ + deck.json → 実際に使う値（既定値 < テーマ < デッキの上書き） */
  function resolveDesign(design, theme) {
    design = design || {};
    theme = theme || {};
    const aspect = schema.ASPECTS[design.aspect] ? design.aspect : schema.ASPECTS[theme.aspect] ? theme.aspect : schema.DEFAULT_ASPECT;
    return {
      aspect,
      size: schema.ASPECTS[aspect],
      tokens: Object.assign({}, schema.DEFAULT_TOKENS, theme.tokens, design.tokens),
      animation: Object.assign({}, schema.DEFAULT_ANIMATION, theme.animation, design.animation),
      chrome: Object.assign({}, schema.DEFAULT_CHROME, theme.chrome, design.chrome),
      slides: isObj(design.slides) ? design.slides : {},
    };
  }

  function deckAttrs(resolved) {
    const attrs = { 'data-aspect': resolved.aspect };
    for (const def of schema.TOKENS) {
      if (def.out === 'attr') attrs['data-' + kebab(def.key)] = String(resolved.tokens[def.key]);
    }
    return attrs;
  }

  function deckStyle(resolved) {
    return [
      '--ks-w:' + resolved.size.w + 'px',
      '--ks-h:' + resolved.size.h + 'px',
      '--ks-dur:' + Number(resolved.animation.duration) + 'ms',
      '--ks-stagger:' + Number(resolved.animation.stagger) + 'ms',
      tokensToStyle(resolved.tokens),
    ].join(';');
  }

  function attrsToString(attrs) {
    return Object.keys(attrs).map((k) => ' ' + k + '="' + esc(attrs[k]) + '"').join('');
  }

  /** <div class="ks-deck …"> の開始タグ */
  function deckOpenTag(out, extraClass) {
    return '<div class="ks-deck' + (extraClass ? ' ' + extraClass : '') + '"' + attrsToString(out.deckAttrs) + ' style="' + esc(out.deckStyle) + '">';
  }

  // ------------------------------------------------------------------
  // スライド 1 枚の HTML
  // ------------------------------------------------------------------

  const COL_STYLES = ['none', 'outline', 'fill', 'card'];
  const COL_DIRS = ['row', 'column', 'grid'];

  // ---- 色の計算（カラムの塗り色と、その上の文字色を決める） ----
  const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  function hexToRgb(hex) {
    let h = hex.slice(1);
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgbToHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  function mixColor(a, b, t) {
    if (!HEX.test(a) || !HEX.test(b)) return 'color-mix(in srgb, ' + a + ' ' + Math.round(t * 100) + '%, ' + b + ')';
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    return rgbToHex(x.map((v, i) => v * t + y[i] * (1 - t)));
  }
  /** 背景色の上に載せる文字色（明るい色なら黒系、暗い色なら白） */
  function textOn(color) {
    if (!HEX.test(color)) return '#ffffff';
    const [r, g, b] = hexToRgb(color).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 ? '#1b1b1f' : '#ffffff';
  }

  /**
   * --ks-col-1 … と --ks-on-col-1 …（カラムごとの色）。
   * 優先順: スライド個別（deck.json の slides.<ID>.colColors）> デッキ全体・テーマ（トークン colColor1〜4）> アクセント色から自動
   */
  function columnColorStyle(count, tokens, sd) {
    sd = sd || {};
    const custom = Array.isArray(sd.colColors) ? sd.colColors : [];
    const deckColors = [1, 2, 3, 4].map((n) => tokens['colColor' + n] || '');
    const palette = [tokens.accent, tokens.accent2, mixColor(tokens.accent, tokens.accent2, 0.5), mixColor(tokens.accent, tokens.text, 0.6)];
    // 塗りの上の文字色: 'light' 白 / 'dark' 黒 / それ以外は背景の明るさから自動
    const textMode = sd.colText || tokens.colText;
    const forced = textMode === 'light' ? '#ffffff' : textMode === 'dark' ? '#1b1b1f' : null;
    const out = [];
    for (let i = 0; i < Math.max(count, 1); i++) {
      const c = String(custom[i] || deckColors[i % 4] || palette[i % palette.length]).replace(/[;{}<>]/g, '');
      out.push('--ks-col-' + (i + 1) + ':' + c, '--ks-on-col-' + (i + 1) + ':' + (forced || textOn(c)));
    }
    return out.join(';');
  }

  const join = (blocks) => blocks.map((b) => b.html).join('');
  const takeHead = (blocks) => (blocks.length && blocks[0].type === 'heading' ? blocks.shift() : null);
  const pick = (value, allowed, fallback) => (allowed.indexOf(value) >= 0 ? value : fallback);
  const optionIds = (def) => def.options.map((o) => o[0]);

  function footerText(template, meta, index, total) {
    const values = { title: meta.title || '', author: meta.author || '', date: meta.date || '', page: index + 1, total };
    return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
  }

  function renderSlide(slide, ctx) {
    const { md, env, resolved, meta, total } = ctx;
    const sd = resolved.slides[slide.id] || {};
    env.ksImg = { n: 0 }; // 本文の画像に通し番号を振る（ノートの画像は数えない。書かれている順に数える）
    const pre = toBlocks(md, slide.pre, env);
    const columns = (slide.columns || ['']).map((c) => toBlocks(md, c, env));
    const post = toBlocks(md, slide.post, env);
    env.ksImg = null;
    const autoLayout = detectLayout(columns, pre, post);
    let layout = pick(sd.layout, LAYOUT_IDS, autoLayout);

    let flat = [].concat(pre, [].concat.apply([], columns), post);
    const imageIndex = flat.findIndex((b) => b.type === 'image');
    if (layout.indexOf('image-') === 0 && imageIndex < 0) layout = 'content'; // 画像が無ければ標準に落とす

    let head = '';
    let body = '';
    let media = '';
    let bg = '';
    if (layout === 'columns') {
      let cols = columns.map((c) => c.slice());
      const before = pre.slice();
      const h = takeHead(before.length ? before : cols[0]);
      if (h) head = h.html;
      if (cols.length === 1) {
        // ||| が無いのにカラムが指定されたら、ブロックを半分ずつに分ける
        const half = Math.ceil(cols[0].length / 2);
        cols = [cols[0].slice(0, half), cols[0].slice(half)];
      }
      // 「::: columns」の囲みの前後に書いた文章は、カラムの上下に全幅で置く
      body = (before.length ? '<div class="ks-cols-pre">' + join(before) + '</div>' : '') +
        '<div class="ks-cols" data-count="' + cols.length + '">' + cols.map((c) => '<div class="ks-col">' + join(c) + '</div>').join('') + '</div>' +
        (post.length ? '<div class="ks-cols-post">' + join(post) + '</div>' : '');
    } else if (layout.indexOf('image-') === 0) {
      // 横・全面に置く画像は枠いっぱいに敷くので、本文用の大きさ指定（{width=…}）は使わない
      const image = Object.assign({}, flat.splice(imageIndex, 1)[0].images[0], { width: undefined, height: undefined });
      const h = takeHead(flat);
      if (h) head = h.html;
      body = join(flat);
      if (layout === 'image-full') bg = imgTag(image);
      else media = '<div class="ks-media">' + imgTag(image) + '</div>';
    } else if (layout === 'content') {
      const h = takeHead(flat);
      if (h) head = h.html;
      body = join(flat);
    } else {
      body = join(flat); // title / section / center / quote は見出しも本文と一緒に中央へ
    }

    const anim = Object.assign({}, resolved.animation, sd.animation);
    const stacked = layout === 'title' || layout === 'section' || layout === 'center' || layout === 'quote';
    const align = pick(sd.align, ['left', 'center'],
      layout === 'title' || layout === 'section' ? resolved.tokens.titleAlign : layout === 'center' || layout === 'quote' ? 'center' : 'left');
    // カラムの囲み（枠線・塗り・カード）。囲みがあるときは、箱の中を中央揃え・縦中央にするのが既定
    const colStyle = layout === 'columns' ? pick(sd.colStyle, COL_STYLES, pick(resolved.tokens.colStyle, COL_STYLES, 'none')) : 'none';
    const boxed = colStyle !== 'none';
    const valign = pick(sd.valign, ['top', 'center'], stacked || boxed ? 'center' : resolved.tokens.bodyAlign);

    const attrs = {
      'data-id': slide.id,
      'data-layout': layout,
      'data-transition': pick(anim.transition, optionIds(schema.ANIMATION.transition), 'fade'),
      'data-entrance': pick(anim.entrance, optionIds(schema.ANIMATION.entrance), 'rise'),
      'data-build': pick(anim.build, optionIds(schema.ANIMATION.build), 'none'),
      'data-align': align,
      'data-valign': valign,
    };
    if (media || bg) attrs['data-fit'] = pick(sd.fit, ['cover', 'contain'], 'cover');
    if (layout === 'columns') {
      attrs['data-col-style'] = colStyle;
      // カラム内の文字の位置: スライド個別 > デッキ全体（トークン）> 自動（箱なら中央、箱なしはスライドの縦位置に合わせる）
      attrs['data-col-align'] = pick(sd.colAlign, ['left', 'center'], pick(resolved.tokens.colAlign, ['left', 'center'], boxed ? 'center' : 'left'));
      attrs['data-col-valign'] = pick(sd.colValign, ['top', 'center', 'bottom'],
        pick(resolved.tokens.colValign, ['top', 'center', 'bottom'], boxed || valign === 'center' ? 'center' : 'top'));
      // 並べ方: スライド個別（GUI）> 原稿の囲み（::: rows など）> デッキ全体（トークン）> 横
      attrs['data-col-dir'] = pick(sd.colDir, COL_DIRS, pick(slide.colDir, COL_DIRS, pick(resolved.tokens.colDir, COL_DIRS, 'row')));
    }

    const style = [];
    if (isObj(sd.tokens)) {
      style.push(tokensToStyle(sd.tokens));
      if (sd.tokens.bg) {
        // 背景色を個別指定したら、テーマのグラデーション背景より優先させる
        const c = cssValue('bg', sd.tokens.bg);
        style.push('--ks-bg-slide:' + c, '--ks-bg-title:' + c, '--ks-bg-section:' + c);
      }
    }
    if (sd.mediaSize) style.push('--ks-media-size:' + Number(sd.mediaSize) + '%');
    const focus = /^(\d{1,3}(?:\.\d+)?)% (\d{1,3}(?:\.\d+)?)%$/.exec(String(sd.focus || ''));
    if (focus) style.push('--ks-media-pos:' + focus[1] + '% ' + focus[2] + '%');
    if (boxed) style.push(columnColorStyle(columns.length > 1 ? columns.length : 2, resolved.tokens, sd));

    const chrome = resolved.chrome;
    const footer = footerText(chrome.footer, meta, slide.index, total);
    let chromeHtml = '';
    if (footer || chrome.pageNumber) {
      chromeHtml =
        '<div class="ks-chrome"><span class="ks-footer">' + esc(footer) + '</span>' +
        (chrome.pageNumber ? '<span class="ks-page"><b>' + (slide.index + 1) + '</b><i> / ' + total + '</i></span>' : '') +
        '</div>';
    }

    const notesHtml = slide.notes ? md.render(slide.notes, env) : '';
    const cls = 'ks-slide ks-layout-' + layout + (sd.class ? ' ' + String(sd.class).replace(/[^\w\- ]/g, '') : '');
    const html =
      '<section class="' + cls + '"' + attrsToString(attrs) + (style.length ? ' style="' + esc(style.filter(Boolean).join(';')) + '"' : '') + '>' +
      '<div class="ks-bg">' + bg + '</div>' +
      '<div class="ks-inner"><div class="ks-main">' +
      (head ? '<header class="ks-head">' + head + '</header>' : '') +
      '<div class="ks-body">' + body + '</div>' +
      '</div>' + media + '</div>' +
      chromeHtml +
      (notesHtml ? '<aside class="ks-notes">' + notesHtml + '</aside>' : '') +
      '</section>';

    return {
      id: slide.id,
      title: slide.title,
      layout,
      autoLayout,
      hasImage: imageIndex >= 0,
      hasMermaid: html.indexOf('ks-mermaid-src') >= 0,
      notesHtml,
      html,
    };
  }

  /**
   * デッキ全体を描画する。
   * @param {Object} parsed  parse.parseDeck() の結果
   * @param {Object} design  deck.json の内容
   * @param {Object} theme   theme.json の内容
   * @param {Object} opts    { md: createMarkdown() の戻り値, resolveAsset?: (相対パス) => URL }
   */
  function renderDeck(parsed, design, theme, opts) {
    const resolved = resolveDesign(design, theme);
    const env = { resolveAsset: opts.resolveAsset };
    const ctx = { md: opts.md, env, resolved, meta: parsed.meta, total: parsed.slides.length };
    const slides = parsed.slides.map((s) => renderSlide(s, ctx));
    const out = {
      title: parsed.meta.title || '',
      meta: parsed.meta,
      resolved,
      width: resolved.size.w,
      height: resolved.size.h,
      deckAttrs: deckAttrs(resolved),
      deckStyle: deckStyle(resolved),
      slides,
      usesMermaid: slides.some((s) => s.hasMermaid),
    };
    return out;
  }

  // ------------------------------------------------------------------
  // 資料（読み物）形式: スライドの区切りをなくし、1 本の文書として並べる。
  // 書き出し（build.js の buildDocument）が使う。見た目は src/runtime/doc.css。
  // ------------------------------------------------------------------

  /**
   * @param {Object} opts { md, resolveAsset?, notes?: ノートも載せるか }
   * @returns {{html: string, title: string, usesMermaid: boolean, resolved: Object}}
   */
  function renderDocument(parsed, design, theme, opts) {
    const resolved = resolveDesign(design, theme);
    const md = opts.md;
    const env = { resolveAsset: opts.resolveAsset };
    const meta = parsed.meta;
    const sections = [];
    let hasH1 = false;
    parsed.slides.forEach((slide) => {
      const sd = resolved.slides[slide.id] || {};
      const pre = toBlocks(md, slide.pre, env);
      const columns = (slide.columns || ['']).map((c) => toBlocks(md, c, env)).filter((c) => c.length);
      const post = toBlocks(md, slide.post, env);
      const notes = opts.notes && slide.notes ? slide.notes : '';
      if (!columns.length && !pre.length && !post.length && !notes) return;
      let html = '';
      const firstBlock = pre[0] || (columns[0] && columns[0][0]);
      const cover = !!firstBlock && firstBlock.type === 'heading' && firstBlock.level === 1;
      if (cover) hasH1 = true;
      html += join(pre);
      if (slide.columns.length > 1 && columns.length > 1) {
        const head = pre.length ? null : takeHead(columns[0]);
        const colStyle = pick(sd.colStyle, COL_STYLES, pick(resolved.tokens.colStyle, COL_STYLES, 'none'));
        const colAlign = pick(sd.colAlign, ['left', 'center'], pick(resolved.tokens.colAlign, ['left', 'center'], colStyle !== 'none' ? 'center' : 'left'));
        const style = colStyle !== 'none' ? ' style="' + esc(columnColorStyle(columns.length, resolved.tokens, sd)) + '"' : '';
        const colDir = pick(sd.colDir, COL_DIRS, pick(slide.colDir, COL_DIRS, pick(resolved.tokens.colDir, COL_DIRS, 'row')));
        html += (head ? head.html : '') +
          '<div class="ks-doc-cols" data-col-style="' + colStyle + '" data-col-align="' + colAlign + '" data-col-dir="' + colDir + '"' + style + '>' +
          columns.map((c) => '<div class="ks-doc-col">' + join(c) + '</div>').join('') + '</div>';
      } else {
        html += columns.map(join).join('');
      }
      html += join(post);
      if (cover && (meta.author || meta.date)) {
        html += '<p class="ks-doc-meta">' + [meta.author, meta.date].filter(Boolean).map(esc).join('<span>·</span>') + '</p>';
      }
      if (notes) html += '<aside class="ks-doc-note"><div class="ks-doc-note-label">ノート</div>' + md.render(notes, env) + '</aside>';
      sections.push('<section class="ks-doc-section' + (cover ? ' ks-doc-cover' : '') + '" data-id="' + esc(slide.id) + '">' + html + '</section>');
    });
    if (!hasH1 && meta.title) {
      sections.unshift('<section class="ks-doc-section ks-doc-cover"><h1>' + esc(meta.title) + '</h1>' +
        (meta.author || meta.date ? '<p class="ks-doc-meta">' + [meta.author, meta.date].filter(Boolean).map(esc).join('<span>·</span>') + '</p>' : '') + '</section>');
    }
    const html = sections.join('\n');
    return { html, title: meta.title || '', usesMermaid: html.indexOf('ks-mermaid-src') >= 0, resolved };
  }

  // ------------------------------------------------------------------
  // リッチ表示エディタ用: 全文を「編集できるブロック」の並びに分ける
  // ------------------------------------------------------------------

  /**
   * @returns {{items: Array, parsed: Object, lines: string[]}}
   *   items[i].type:
   *     'front'  先頭の front matter        { start, end }（行範囲 [start, end)）
   *     'sep'    スライド区切りの --- 行    { line, slide }
   *     'block'  Markdown のブロック        { start, end, slide, note, col }
   *     'notes'  ??? 行                     { line, slide }
   *     'col'    ||| 行                     { line, slide }
   *     'colsopen' / 'colsclose'  「::: columns」/「:::」行 { line, slide }
   *     'id'     <!-- id: … --> 行          { line, slide }
   *     'end'    スライドの本文の終わり      { line, slide }（ここに足すとそのスライドの末尾に入る）
   */
  function editorBlocks(text, md) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const parsed = parse.parseDeck(src);
    const RE = parse.RE;
    const items = [];
    const first = parsed.slides.length ? parsed.slides[0].startLine : lines.length;
    if (first > 0) items.push({ type: 'front', start: 0, end: first });
    parsed.slides.forEach((slide, si) => {
      if (si > 0) items.push({ type: 'sep', line: slide.startLine - 1, slide: si });
      const inFence = parse.fenceTracker();
      let runStart = -1;
      let note = false;
      let col = 0;
      const flush = (endLine) => {
        if (runStart < 0) return;
        const tokens = md.parse(lines.slice(runStart, endLine).join('\n'), {});
        for (const t of tokens) {
          if (t.level !== 0 || !t.map || t.nesting < 0) continue;
          items.push({ type: 'block', start: runStart + t.map[0], end: runStart + t.map[1], slide: si, note, col });
        }
        runStart = -1;
      };
      const last = Math.min(slide.endLine, lines.length - 1);
      let region = 'body'; // body → （::: columns）cols →（:::）post。parse.parseDeck と同じ判定
      for (let i = slide.startLine; i <= last; i++) {
        const line = lines[i];
        if (!inFence(line) && !note) {
          let type = null;
          if (RE.notes.test(line)) type = 'notes';
          else if (RE.colsOpen.test(line) && region === 'body') { type = 'colsopen'; region = 'cols'; col = 0; }
          else if (RE.colsClose.test(line) && region === 'cols') { type = 'colsclose'; region = 'post'; }
          else if (RE.column.test(line) && region !== 'post') type = 'col';
          else if (RE.id.test(line)) type = 'id';
          if (type) {
            flush(i);
            if (type === 'notes') { items.push({ type: 'end', line: i, slide: si }); note = true; }
            if (type === 'col') col++;
            items.push({ type, line: i, slide: si });
            continue;
          }
        }
        if (runStart < 0) runStart = i;
      }
      flush(last + 1);
      if (!note) items.push({ type: 'end', line: last + 1, slide: si });
    });
    return { items, parsed, lines };
  }

  // ------------------------------------------------------------------
  // deck.json / theme.json の保存形式（git で差分が読みやすいように）
  // ------------------------------------------------------------------

  /** 空の値を落とし、キーを並べ替える（保存のたびに順序が変わって差分が出るのを防ぐ） */
  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (!isObj(value)) return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = normalize(value[key]);
      if (v === undefined || v === null || v === '') continue;
      if (isObj(v) && !Object.keys(v).length) continue;
      out[key] = v;
    }
    return out;
  }

  function serialize(value) {
    return JSON.stringify(normalize(value), null, 2) + '\n';
  }

  return {
    esc,
    kebab,
    createMarkdown,
    toBlocks,
    detectLayout,
    resolveDesign,
    tokensToStyle,
    deckOpenTag,
    renderSlide,
    renderDeck,
    renderDocument,
    editorBlocks,
    columnColorStyle,
    textOn,
    normalize,
    serialize,
  };
});
