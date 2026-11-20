/*
 * export-scene.js — 描画済みのスライド（プレビューと同じ DOM）から、PowerPoint / ODP に書き出すための
 * 「シーン」（文字の箱・図形・画像・表・線の並び）を取り出す。位置・色・文字の大きさは実際の表示から測るので、
 * 書き出した結果はプレビューとほぼ同じ見た目になり、しかも PowerPoint 側で文字や図形を編集できる。
 *
 * シーン（単位はスライドの px。1280×720 など）:
 *   { w, h, bg: { color, gradient: [色…] }, items: [...], notes }
 *   { kind: 'text',  x, y, w, h, paras, anchor: t|ctr|b, inset: [l,t,r,b], fill?, line?, lineWidth?, radius? }
 *   { kind: 'shape', geom, x, y, w, h, fill, line, lineWidth, dash, radius, paras?, anchor?, inset? }
 *   { kind: 'image', x, y, w, h, data, mime, alt, radius? }
 *   { kind: 'line',  points: [{x,y}], color, width, dash, head, tail }
 *   { kind: 'table', x, y, w, h, cols: [w…], rows: [{ h, cells: [{ paras, fill, border }] }] }
 *   { kind: 'group', x, y, w, h, items }
 *   paras: [{ align, level, bullet: { char, color } | { num, start } | null, marL, indent, lineSpacing, spaceBefore, runs }]
 *   runs:  [{ text, size(px), color, bold, italic, underline, strike, font, ea, highlight, link } | { br: true }]
 *
 * 使うのは export-office.js。
 */
(function () {
  'use strict';
  const app = window.KSE;
  const KS = window.KS;
  const D = KS.diagram;

  // ---- 色: どんな CSS の色でも { hex: '#rrggbb', a } にする（color-mix の結果なども canvas に塗って読む） ----
  const cctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  function color(css) {
    if (!css || css === 'transparent' || css === 'none') return null;
    if (colorCache.has(css)) return colorCache.get(css);
    cctx.clearRect(0, 0, 1, 1);
    cctx.fillStyle = '#000';
    cctx.fillStyle = css;
    cctx.fillRect(0, 0, 1, 1);
    const d = cctx.getImageData(0, 0, 1, 1).data;
    const out = d[3] ? { hex: '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''), a: d[3] / 255 } : null;
    colorCache.set(css, out);
    return out;
  }
  const solid = (css) => { const c = color(css); return c && c.a > 0.02 ? c : null; };
  /** 'linear-gradient(…)' などから色を取り出す */
  function gradientColors(bgImage) {
    const list = String(bgImage || '').match(/(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b)/gi) || [];
    return list.map(solid).filter(Boolean).map((c) => c.hex);
  }

  // ---- フォント: CSS の並びのうち、この PC に入っていて実際に使われたものを選ぶ ----
  const fontOk = new Map();
  function installed(name) {
    if (fontOk.has(name)) return fontOk.get(name);
    const sample = 'mmmmmmmmmmlliWW@# あいう漢字';
    let ok = false;
    for (const base of ['monospace', 'serif']) {
      cctx.font = '72px ' + base;
      const a = cctx.measureText(sample).width;
      cctx.font = '72px "' + name + '", ' + base;
      if (cctx.measureText(sample).width !== a) { ok = true; break; }
    }
    fontOk.set(name, ok);
    return ok;
  }
  const JA = /gothic|mincho|meiryo|yu |hiragino|noto (sans|serif) (jp|cjk)|biz ud|ゴシック|明朝|maru|osaka/i;
  const fontCache = new Map();
  function fontsFor(family) {
    if (fontCache.has(family)) return fontCache.get(family);
    const names = String(family || '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => s && !/^(sans-serif|serif|monospace|system-ui|-apple-system|cursive|fantasy)$/i.test(s));
    const fallback = KS.docmodel.pickFonts(family);
    const ea = names.find((n) => JA.test(n) && installed(n)) || fallback.ja;
    const latin = names.find((n) => installed(n)) || ea;
    const out = { latin, ea };
    fontCache.set(family, out);
    return out;
  }
  let slideBg = '#ffffff'; // 半透明の色を、スライドの背景色と混ぜて不透明にするため
  function blend(c) {
    if (!c) return null;
    if (c.a >= 0.98) return c.hex;
    return KS.office.mix(c.hex, slideBg, c.a);
  }

  const BLOCK = /^(block|flex|grid|list-item|table|flow-root)$/;
  const isBlock = (el) => BLOCK.test(getComputedStyle(el).display);
  const px = (v) => parseFloat(v) || 0;

  // ==================================================================
  // 文字
  // ==================================================================
  function runStyle(el) {
    const st = getComputedStyle(el);
    let col = solid(st.color);
    // グラデーション文字（見出しの飾り）は、グラデーションの最初の色にする
    if ((st.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || st.webkitTextFillColor === 'transparent') && /gradient/.test(st.backgroundImage)) {
      const g = gradientColors(st.backgroundImage);
      if (g.length) col = { hex: g[0], a: 1 };
    }
    const fonts = fontsFor(st.fontFamily);
    const deco = st.textDecorationLine || '';
    const a = el.closest('a[href]');
    // マーカー・インラインコードの背景は「蛍光ペン」として持つ（半透明なら背景と混ぜた色に）
    let highlight = null;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.display !== 'inline') break;
      const bg = solid(ps.backgroundColor);
      if (bg) { highlight = blend(bg); break; }
    }
    return {
      size: px(st.fontSize),
      color: col ? blend(col) : '#000000',
      bold: Number(st.fontWeight) >= 600 || undefined,
      italic: st.fontStyle === 'italic' || undefined,
      underline: /underline/.test(deco) || undefined,
      strike: /line-through/.test(deco) || undefined,
      font: fonts.latin,
      ea: fonts.ea,
      highlight: highlight || undefined,
      link: a && /^(https?:|mailto:)/.test(a.getAttribute('href')) ? a.getAttribute('href') : undefined,
    };
  }

  /**
   * 要素の中の文字を runs にする（中の段落要素・リストは skip で飛ばす）。
   * 画面で折り返している位置には { br: true } を入れる（runs.lines = true）。PowerPoint などは自分で折り返すと
   * 文節の区切り（word-break: auto-phrase）や行の長さのそろえ（text-wrap: balance）を再現できないので、
   * 画面と同じ位置で改行し、書き出し先では折り返さない設定にする（textItem の single）。
   */
  const lineRange = document.createRange();
  function runsOf(el, opts) {
    opts = opts || {};
    const runs = [];
    const pre = opts.pre;
    let prevBox = null; // 直前の文字の位置（行が変わったかを見る）
    /** テキストノードを、画面の行の変わり目で分ける。空白は 1 つにまとめる */
    function splitByLines(n, s) {
      const src = n.textContent;
      let cur = '';
      for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (/[\t\n\r ]/.test(ch)) { if (!cur.endsWith(' ')) cur += ' '; continue; }
        // サロゲートペア（絵文字など）は 2 つで 1 文字
        const len = /[\uD800-\uDBFF]/.test(ch) && i + 1 < src.length ? 2 : 1;
        lineRange.setStart(n, i);
        lineRange.setEnd(n, i + len);
        const box = lineRange.getClientRects()[0];
        if (box && box.height > 0) {
          if (prevBox && box.top > prevBox.top + Math.min(box.height, prevBox.height) * 0.6) {
            if (cur) runs.push(Object.assign({ text: cur }, s));
            runs.push({ br: true, soft: true });
            cur = '';
          }
          prevBox = box;
        }
        cur += src.slice(i, i + len);
        i += len - 1;
      }
      if (cur) runs.push(Object.assign({ text: cur }, s));
    }
    function walk(node) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          let text = n.textContent;
          if (!pre) text = text.replace(/[\t\n\r ]+/g, ' ');
          if (!text) continue;
          const s = runStyle(n.parentElement);
          if (pre) {
            text.split('\n').forEach((line, i) => {
              if (i) runs.push({ br: true });
              if (line) runs.push(Object.assign({ text: line }, s));
            });
          } else {
            splitByLines(n, s);
          }
        } else if (n.nodeType === 1) {
          if (n.tagName === 'BR') { runs.push({ br: true }); prevBox = null; continue; }
          if (opts.skip && opts.skip(n)) continue;
          const st = getComputedStyle(n);
          if (st.display === 'none') continue;
          if (n.tagName === 'IMG' || n.tagName === 'svg') continue;
          walk(n);
        }
      }
    }
    walk(el);
    if (!pre) {
      // 段落の頭と末尾の空白、改行の前後の空白を落とす
      while (runs.length && runs[0].text != null && !runs[0].text.trim()) runs.shift();
      if (runs.length && runs[0].text) runs[0].text = runs[0].text.replace(/^ +/, '');
      for (let i = runs.length - 1; i >= 0 && runs[i].text != null; i--) {
        runs[i].text = runs[i].text.replace(/ +$/, '');
        if (runs[i].text) break;
        runs.pop();
      }
      for (let i = 0; i < runs.length; i++) {
        if (runs[i].br) {
          if (runs[i - 1] && runs[i - 1].text) runs[i - 1].text = runs[i - 1].text.replace(/ +$/, '');
          if (runs[i + 1] && runs[i + 1].text) runs[i + 1].text = runs[i + 1].text.replace(/^ +/, '');
        }
      }
    }
    const out = runs.filter((r) => r.br || r.text);
    // 画面の改行が文字の前後の端に残ったもの（空白だけで行が変わった場合）は落とす
    while (out.length && out[out.length - 1].soft) out.pop();
    while (out.length && out[0].soft) out.shift();
    out.forEach((r) => { delete r.soft; });
    if (!pre) out.lines = true; // 画面の行の位置を写した（折り返さない設定にしてよい）
    return out;
  }

  function paraOf(el, runs, extra) {
    const st = getComputedStyle(el);
    const fs = px(st.fontSize) || 16;
    const lh = st.lineHeight === 'normal' ? fs * 1.2 : px(st.lineHeight);
    const align = { center: 'ctr', right: 'r', end: 'r', justify: 'just' }[st.textAlign] || 'l';
    return Object.assign({ align, level: 0, bullet: null, lineSpacing: lh / fs, spaceBefore: 0, runs }, extra);
  }

  // ==================================================================
  // スライド 1 枚
  // ==================================================================
  /**
   * @param {Element} slide 描画済みの .ks-slide（拡大縮小されていてもよい）
   * @param {number} W スライドの論理幅（px）
   */
  function sceneOf(slide, W, H) {
    const sr = slide.getBoundingClientRect();
    const k = sr.width / W || 1;
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k };
    };
    const items = [];
    const sst = getComputedStyle(slide);
    // 背景: 直線のグラデーションだけを再現する（円形の飾りのぼかしは背景色だけにする）
    const linear = /^linear-gradient/.test(sst.backgroundImage) && !/radial-gradient/.test(sst.backgroundImage);
    const bg = { color: (solid(sst.backgroundColor) || { hex: '#ffffff' }).hex, gradient: linear ? gradientColors(sst.backgroundImage) : [] };
    if (!solid(sst.backgroundColor) && !linear) {
      const g = gradientColors(sst.backgroundImage);
      if (g.length) bg.color = g[g.length - 1];
    }
    slideBg = bg.color;

    /** 背景色・枠線・影のバー（カードの上の線）を図形として置く */
    function decoration(el, st) {
      const fill = solid(st.backgroundColor);
      const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) => (st['border' + s + 'Style'] !== 'none' ? px(st['border' + s + 'Width']) : 0));
      const bc = ['Top', 'Right', 'Bottom', 'Left'].map((s) => solid(st['border' + s + 'Color']));
      const r = rect(el);
      if (r.w < 1 || r.h < 1) return;
      const radius = px(st.borderTopLeftRadius);
      const all = bw.every((w) => w > 0 && Math.abs(w - bw[0]) < 0.5) && bc.every((c) => c && bc[0] && c.hex === bc[0].hex);
      if (fill || all) {
        items.push({
          kind: 'shape', geom: radius > 0.5 ? 'roundRect' : 'rect', x: r.x, y: r.y, w: r.w, h: r.h, radius,
          fill: fill ? fill.hex : null, fillAlpha: fill ? fill.a : 1,
          line: all ? bc[0].hex : null, lineAlpha: all ? bc[0].a : 1, lineWidth: all ? bw[0] : 0,
        });
      }
      if (!all) {
        // 片側だけの線（引用の左の線・下線など）は細い四角で
        const sides = [
          [0, (w) => ({ x: r.x, y: r.y, w: r.w, h: w })],
          [1, (w) => ({ x: r.x + r.w - w, y: r.y, w, h: r.h })],
          [2, (w) => ({ x: r.x, y: r.y + r.h - w, w: r.w, h: w })],
          [3, (w) => ({ x: r.x, y: r.y, w, h: r.h })],
        ];
        for (const [i, f] of sides) if (bw[i] > 0 && bc[i]) items.push(Object.assign({ kind: 'shape', geom: 'rect', fill: bc[i].hex, fillAlpha: bc[i].a, line: null }, f(bw[i])));
      }
      // カードの上の色の帯（box-shadow: inset 0 N 0 色）
      // getComputedStyle は「色 x y ぼかし 広がり inset」の順で返す（広がりの 0px が付く）ので、広がりは省略可として読む
      const m = /(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})\s+0(?:px)?\s+([\d.]+)px\s+0(?:px)?(?:\s+0(?:px)?)?\s+inset|inset\s+0(?:px)?\s+([\d.]+)px\s+0(?:px)?(?:\s+0(?:px)?)?\s+(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i.exec(st.boxShadow || '');
      if (m) {
        const c = solid(m[1] || m[4]);
        const hgt = px(m[2] || m[3]);
        if (c && hgt > 0) items.push({ kind: 'shape', geom: 'rect', x: r.x, y: r.y, w: r.w, h: hgt, fill: c.hex, fillAlpha: c.a, line: null, clipRadius: radius });
      }
    }

    function textItem(el, paras, extra) {
      if (!paras.some((p) => p.runs.length)) return;
      const r = rect(el);
      const st = getComputedStyle(el);
      // 1 行に収まっている文字は、PowerPoint 側でも折り返さない（フォントの幅の違いで折り返されるのを防ぐ）
      const fs = px(st.fontSize) || 16;
      const lh = st.lineHeight === 'normal' ? fs * 1.2 : px(st.lineHeight);
      const content = r.h - px(st.paddingTop) - px(st.paddingBottom);
      // 画面の改行の位置を写した文字（runsOf の lines）も、書き出し先では折り返さない（文節の区切りを保つ）
      const single = (paras.length === 1 && !paras[0].bullet && !paras[0].runs.some((x) => x.br) && content < lh * 1.5) || paras.every((p) => p.runs.lines);
      items.push(Object.assign({
        kind: 'text', x: r.x, y: r.y, w: r.w, h: r.h, paras, anchor: 't', single,
        inset: [px(st.paddingLeft) + px(st.borderLeftWidth), px(st.paddingTop) + px(st.borderTopWidth), px(st.paddingRight) + px(st.borderRightWidth), px(st.paddingBottom) + px(st.borderBottomWidth)],
      }, extra));
    }

    function listOf(list) {
      const paras = [];
      const box = rect(list);
      function walk(ul, level) {
        let n = Number(ul.getAttribute('start') || 1);
        for (const li of ul.children) {
          if (li.tagName !== 'LI') continue;
          const ls = getComputedStyle(ul).listStyleType;
          let bullet;
          if (ul.tagName === 'OL') bullet = { num: true, start: n++ };
          else {
            let ch = '•';
            const q = /^["'](.*)["']$/.exec(ls);
            if (q) ch = q[1].trim() || '•';
            else if (ls === 'square') ch = '■';
            else if (ls === 'circle') ch = '○';
            else if (ls === 'none') ch = null;
            const mc = solid(getComputedStyle(li, '::marker').color);
            bullet = ch ? { char: ch, color: mc ? mc.hex : null } : null;
          }
          const lr = rect(li);
          const runs = runsOf(li, { skip: (c) => c.tagName === 'UL' || c.tagName === 'OL' || (isBlock(c) && c.tagName !== 'P') });
          const fs = px(getComputedStyle(li).fontSize);
          paras.push(paraOf(li, runs, {
            level, bullet,
            marL: lr.x - box.x,
            indent: -Math.max(fs * 1.1, 14),
            spaceBefore: paras.length ? px(getComputedStyle(li).marginTop) : 0,
            size: fs,
          }));
          for (const c of li.children) if (c.tagName === 'UL' || c.tagName === 'OL') walk(c, level + 1);
        }
      }
      walk(list, 0);
      textItem(list, paras, { inset: [0, 0, 0, 0] });
    }

    function tableOf(table) {
      const r = rect(table);
      const rows = Array.from(table.rows);
      if (!rows.length) return;
      const cols = Array.from(rows[0].cells).map((c) => rect(c).w);
      items.push({
        kind: 'table', x: r.x, y: r.y, w: r.w, h: r.h, cols,
        rows: rows.map((tr) => ({
          h: rect(tr).h,
          cells: Array.from(tr.cells).map((td) => {
            const st = getComputedStyle(td);
            const trSt = getComputedStyle(tr);
            const fill = solid(st.backgroundColor) || solid(trSt.backgroundColor);
            const bb = st.borderBottomStyle !== 'none' ? solid(st.borderBottomColor) : null;
            return {
              paras: [paraOf(td, runsOf(td))],
              fill: fill ? fill.hex : null,
              fillAlpha: fill ? fill.a : 1,
              border: bb ? { color: bb.hex, width: px(st.borderBottomWidth) } : null,
              inset: [px(st.paddingLeft), px(st.paddingTop), px(st.paddingRight), px(st.paddingBottom)],
            };
          }),
        })),
      });
    }

    function visit(el) {
      if (!el || el.nodeType !== 1) return;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return;
      const cls = el.classList;
      if (cls.contains('ks-notes') || cls.contains('ks-progress') || cls.contains('ks-mermaid-src')) return;
      const tag = el.tagName;
      if (tag === 'IMG') {
        const r = rect(el);
        if (r.w > 1 && r.h > 1) items.push({ kind: 'image', el, x: r.x, y: r.y, w: r.w, h: r.h, fit: st.objectFit, pos: st.objectPosition, radius: px(st.borderTopLeftRadius), alt: el.alt || '' });
        return;
      }
      if (tag === 'svg') {
        const r = rect(el);
        if (r.w > 1 && r.h > 1) items.push({ kind: 'svg', el, x: r.x, y: r.y, w: r.w, h: r.h });
        return;
      }
      if (tag === 'TABLE') { tableOf(el); return; }
      if (tag !== 'PRE' && el !== slide) decoration(el, st);
      if (tag === 'UL' || tag === 'OL') { listOf(el); return; }
      if (tag === 'PRE') {
        const fill = solid(st.backgroundColor);
        const r = rect(el);
        items.push({ kind: 'shape', geom: px(st.borderTopLeftRadius) > 0.5 ? 'roundRect' : 'rect', x: r.x, y: r.y, w: r.w, h: r.h, radius: px(st.borderTopLeftRadius), fill: fill ? fill.hex : null, fillAlpha: fill ? fill.a : 1, line: null });
        const code = el.querySelector('code') || el;
        textItem(el, [paraOf(code, runsOf(code, { pre: true }))]);
        return;
      }
      // 中にブロック要素が無く、文字があるもの → 文字の箱
      const kids = Array.from(el.children);
      const hasBlockChild = kids.some((c) => isBlock(c) || c.tagName === 'IMG' || c.tagName === 'svg' || c.tagName === 'TABLE');
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasBlockChild && (hasText || kids.length) && el.textContent.trim()) {
        textItem(el, [paraOf(el, runsOf(el))]);
        return;
      }
      for (const c of kids) visit(c);
    }

    visit(slide.querySelector('.ks-bg'));
    visit(slide.querySelector('.ks-inner'));
    visit(slide.querySelector('.ks-chrome'));
    const notes = slide.querySelector('.ks-notes');
    return { w: W, h: H, bg, items, notes: notes ? notes.innerText.trim() : '' };
  }

  // ==================================================================
  // 画像を読み込む（SVG は PNG に。図形エディタの図形は PowerPoint の図形に）
  // ==================================================================
  async function fetchBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status + ' ' + url);
    const buf = new Uint8Array(await res.arrayBuffer());
    const type = (res.headers.get('content-type') || '').split(';')[0];
    return { data: buf, mime: type };
  }
  const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

  /** 画像（URL）を canvas に描いて PNG / JPEG にする。crop: 表示されている部分だけ切り出す */
  async function rasterize(url, outW, outH, crop, jpeg) {
    // 別のオリジンの画像（アプリの asset プロトコルなど）は canvas を「汚染」して書き出せなくなるので、いったん blob にしてから描く
    let blobUrl = null;
    if (!/^(data:|blob:)/.test(url) && new URL(url, location.href).origin !== location.origin) {
      blobUrl = URL.createObjectURL(await (await fetch(url)).blob());
      url = blobUrl;
    }
    try {
      return await draw(url, outW, outH, crop, jpeg);
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
  }
  async function draw(url, outW, outH, crop, jpeg) {
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    await img.decode();
    const nw = img.naturalWidth || outW;
    const nh = img.naturalHeight || outH;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(outW));
    c.height = Math.max(1, Math.round(outH));
    const ctx = c.getContext('2d');
    const s = crop || { x: 0, y: 0, w: nw, h: nh };
    // 切り抜きは「画像全体をずらして大きく描く」ことで行う（SVG に元画像の範囲指定をすると正しく描けないことがあるため）
    const kx = c.width / s.w;
    const ky = c.height / s.h;
    ctx.drawImage(img, -s.x * kx, -s.y * ky, nw * kx, nh * ky);
    const blob = await new Promise((r) => c.toBlob(r, jpeg ? 'image/jpeg' : 'image/png', 0.9));
    return { data: await blobBytes(blob), mime: jpeg ? 'image/jpeg' : 'image/png', width: c.width, height: c.height };
  }

  /** SVG の文字列 → PNG（scale 倍の解像度） */
  async function svgToPng(svgText, w, h, scale) {
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
    try { return await rasterize(url, w * (scale || 2), h * (scale || 2)); } finally { URL.revokeObjectURL(url); }
  }

  /** 画面上の <svg>（mermaid の図）→ PNG */
  async function svgElementToPng(el, w, h) {
    const clone = el.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    clone.style.maxWidth = 'none';
    // 文字の色・フォントは CSS で付いていることがあるので、計算済みの値を書き込む
    const src = el.querySelectorAll('*');
    const dst = clone.querySelectorAll('*');
    src.forEach((n, i) => {
      const st = getComputedStyle(n);
      const d = dst[i];
      if (!d || !d.style) return;
      for (const p of ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size', 'font-weight', 'color', 'opacity', 'stroke-dasharray']) {
        const v = st.getPropertyValue(p);
        if (v) d.style.setProperty(p, v);
      }
    });
    const text = new XMLSerializer().serializeToString(clone);
    return svgToPng(text, w, h, 2);
  }

  /** 文字も SVG の図（mermaid の書き出し用）を、表示されている枠（it）の大きさで PNG に */
  async function plainSvgToPng(svgText, it) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const vw = vb[2] || it.w;
    const vh = vb[3] || it.h;
    // 枠の中に縦横比を保って収める
    const s = Math.min(it.w / vw, it.h / vh);
    const w = vw * s;
    const h = vh * s;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.removeAttribute('style');
    const png = await svgToPng(new XMLSerializer().serializeToString(svg), w, h, 2);
    it.x += (it.w - w) / 2;
    it.y += (it.h - h) / 2;
    it.w = w;
    it.h = h;
    return png;
  }

  // 図形（.diagram.svg）→ PowerPoint の図形のグループ
  const GEOM = { rect: 'rect', round: 'roundRect', ellipse: 'ellipse', diamond: 'diamond', parallelogram: 'parallelogram', hexagon: 'hexagon', chevron: 'chevron', pentagon: 'homePlate', arrow: 'rightArrow', triangle: 'triangle', cylinder: 'can', document: 'flowChartDocument', callout: 'wedgeRectCallout', polygon: 'custom', text: 'rect' };
  /** "上,右,下,左"（%）→ 元の画像のうち見せる範囲（px）。切り抜いていなければ null */
  function userCrop(v, nw, nh) {
    const a = Array.isArray(v) ? v.map(Number) : String(v || '').split(',').map(Number);
    if (a.length !== 4 || !a.every(Number.isFinite) || !a.some((n) => n > 0)) return null;
    return { x: (nw * a[3]) / 100, y: (nh * a[0]) / 100, w: nw * (1 - (a[1] + a[3]) / 100), h: nh * (1 - (a[0] + a[2]) / 100) };
  }
  /** 図形の中の画像 → 表示されている部分だけの画像（収め方: 全体を表示 / 枠いっぱい） */
  async function diagramImage(it, st, X, Y, s) {
    const img = new Image();
    img.src = it.src;
    await img.decode();
    const uc = userCrop(it.crop, img.naturalWidth || it.w, img.naturalHeight || it.h);
    const nw = uc ? uc.w : img.naturalWidth || it.w;
    const nh = uc ? uc.h : img.naturalHeight || it.h;
    let box = { x: it.x, y: it.y, w: it.w, h: it.h };
    let crop = null;
    if (st.fit === 'cover') {
      const k = Math.max(it.w / nw, it.h / nh);
      crop = { x: (nw - it.w / k) / 2, y: (nh - it.h / k) / 2, w: it.w / k, h: it.h / k };
    } else {
      const k = Math.min(it.w / nw, it.h / nh);
      box = { x: it.x + (it.w - nw * k) / 2, y: it.y + (it.h - nh * k) / 2, w: nw * k, h: nh * k };
    }
    if (uc) crop = crop ? { x: crop.x + uc.x, y: crop.y + uc.y, w: crop.w, h: crop.h } : uc;
    const src = crop || { w: nw, h: nh };
    const jpeg = /^data:image\/jpe?g/.test(it.src);
    const k = Math.min(1, 2000 / Math.max(src.w, src.h));
    const png = await rasterize(it.src, src.w * k, src.h * k, crop, jpeg);
    // 収めた画像の中心は図形の中心と同じなので、図形と同じ角度で回せばよい
    return { kind: 'image', x: X(box.x), y: Y(box.y), w: box.w * s, h: box.h * s, rot: D.rotOf(it), data: png.data, mime: png.mime, alt: it.text || '画像' };
  }

  async function diagramGroup(model, viewBox, r) {
    const [vx, vy, vw, vh] = viewBox;
    const s = Math.min(r.w / vw, r.h / vh);
    const ox = r.x + (r.w - vw * s) / 2;
    const oy = r.y + (r.h - vh * s) / 2;
    const X = (v) => ox + (v - vx) * s;
    const Y = (v) => oy + (v - vy) * s;
    const index = D.byId(model);
    const children = [];
    const font = KS.docmodel.pickFonts(model.font || '');
    const textParas = (text, st) => String(text).split('\n').map((line) => ({
      align: st.align === 'left' ? 'l' : st.align === 'right' ? 'r' : 'ctr', level: 0, bullet: null, lineSpacing: 1.3, spaceBefore: 0,
      runs: line ? [{ text: line, size: (Number(st.fontSize) || 16) * s, color: st.textColor || '#000000', bold: st.bold || undefined, font: font.latin, ea: font.ja }] : [],
    }));
    // 輪郭の点の範囲の枠（回した図形は、図形の中心で回したときと同じ位置になるよう、枠の中心をずらす）
    function polyBox(it, X, Y, s) {
      const pts = D.polygon(it);
      if (!pts) return null;
      const x1 = Math.min(...pts.map((p) => p[0]));
      const y1 = Math.min(...pts.map((p) => p[1]));
      const x2 = Math.max(...pts.map((p) => p[0]));
      const y2 = Math.max(...pts.map((p) => p[1]));
      let cx = (x1 + x2) / 2;
      let cy = (y1 + y2) / 2;
      if (D.rotOf(it)) { const q = D.rotate({ x: cx, y: cy }, D.center(it), D.rotOf(it)); cx = q.x; cy = q.y; }
      return { x: X(cx - (x2 - x1) / 2), y: Y(cy - (y2 - y1) / 2), w: (x2 - x1) * s, h: (y2 - y1) * s };
    }
    for (const it of model.items) {
      if (it.type === 'shape') {
        const st = D.shapeStyle(it);
        const tb = D.textBox(it);
        // 画像: 画像を置き、その上に枠線と文字だけの四角を重ねる
        if (it.shape === 'image' && it.src) {
          try { children.push(await diagramImage(it, st, X, Y, s)); } catch (e) { /* 読めない画像は飛ばす */ }
          if (!it.text && !(st.stroke && st.stroke !== 'none')) continue;
        }
        children.push({
          kind: 'shape', geom: GEOM[it.shape] || 'rect', poly: D.polygon(it), shape: it.shape,
          x: X(it.x), y: Y(it.y), w: it.w * s, h: it.h * s, rot: D.rotOf(it),
          // 輪郭の点が枠からはみ出す・届かない図形（フキダシのしっぽ・正多角形）の、点の範囲の枠（ODP 用）
          polyBox: polyBox(it, X, Y, s),
          polyX: it.x, polyY: it.y, polyW: it.w, polyH: it.h, // poly の座標系での枠（PowerPoint の多角形用）
          // PowerPoint の図形の調整値（フキダシ: しっぽの先の、枠の中心からの位置。1/100000）
          adj: it.shape === 'callout' ? D.tailOf(it).map((v) => Math.round((v - 0.5) * 100000)) : null,
          fill: st.fill && st.fill !== 'none' && it.shape !== 'image' ? st.fill : null,
          line: st.stroke && st.stroke !== 'none' ? st.stroke : null,
          lineWidth: (Number(st.strokeWidth) || 0) * s, dash: st.dash,
          radius: it.shape === 'round' ? Math.min(it.w, it.h) * 0.2 * s : 0,
          paras: it.text ? textParas(it.text, st) : null,
          anchor: st.valign === 'top' ? 't' : st.valign === 'bottom' ? 'b' : 'ctr',
          inset: [(tb.x - it.x) * s, (tb.y - it.y) * s, (it.x + it.w - tb.x - tb.w) * s, (it.y + it.h - tb.y - tb.h) * s],
          // PowerPoint の図形（ひし形など）は、図形ごとに文字の範囲を内側に取るので、余白は小さくてよい
          pptInset: /^(rect|round|text)$/.test(it.shape) ? null : [3 * s, 2 * s, 3 * s, 2 * s],
        });
      } else if (it.type === 'line') {
        const st = Object.assign({}, D.DEFAULT_LINE_STYLE, it.style);
        const pts = D.linePoints(it, index);
        children.push({ kind: 'line', points: pts.map((p) => ({ x: X(p.x), y: Y(p.y) })), color: st.stroke, width: (Number(st.strokeWidth) || 2) * s, dash: st.dash, head: st.start, tail: st.end });
        if (it.text) {
          const m = D.midPoint(pts);
          const lines = String(it.text).split('\n');
          const fs = (Number(st.fontSize) || 14) * s;
          const w = Math.max(...lines.map((l) => l.length)) * fs * 1.1 + 8;
          const hgt = lines.length * fs * 1.35 + 4;
          children.push({ kind: 'text', x: X(m.x) - w / 2, y: Y(m.y) - hgt / 2, w, h: hgt, anchor: 'ctr', inset: [0, 0, 0, 0], paras: textParas(it.text, Object.assign({}, st, { align: 'center' })), fill: model.halo && model.halo !== 'none' ? model.halo : null });
        }
      }
    }
    return { kind: 'group', x: r.x, y: r.y, w: r.w, h: r.h, items: children };
  }

  /** シーンの画像（img / svg）を、書き出せる形（バイト列・図形のグループ）に置き換える */
  async function resolveMedia(scene, warn) {
    const out = [];
    for (const it of scene.items) {
      try {
        if (it.kind === 'svg') {
          // mermaid の図は、文字も SVG で描き直してから画像にする（画面の図は文字が HTML なので画像にできない）
          const box = it.el.closest('.ks-mermaid');
          const code = box && box.querySelector('.ks-mermaid-src') ? box.querySelector('.ks-mermaid-src').textContent : null;
          const plain = code && window.Kamishibai.mermaidPlainSvg ? await window.Kamishibai.mermaidPlainSvg(code, it.el.closest('.ks-slide') || box) : null;
          const png = plain ? await plainSvgToPng(plain, it) : await svgElementToPng(it.el, it.w, it.h);
          out.push({ kind: 'image', x: it.x, y: it.y, w: it.w, h: it.h, data: png.data, mime: png.mime, alt: '図' });
          continue;
        }
        if (it.kind !== 'image') { out.push(it); continue; }
        const raw = it.el.dataset.src || '';
        const url = it.el.currentSrc || it.el.src;
        // 図形エディタの図形は、PowerPoint で編集できる図形にする
        if (D.isDiagramPath(raw)) {
          const text = await (await fetch(url)).text();
          const model = D.fromSvg(text);
          const vb = /viewBox="([-\d.\s]+)"/.exec(text);
          if (model && vb) { out.push(await diagramGroup(model, vb[1].trim().split(/\s+/).map(Number), it)); continue; }
        }
        // トリミング（{crop=上,右,下,左}）: 画像のうち、この範囲を「元の画像」として扱う
        const uc = userCrop(it.el.dataset.crop, it.el.naturalWidth || it.w, it.el.naturalHeight || it.h);
        const nw = uc ? uc.w : it.el.naturalWidth || it.w;
        const nh = uc ? uc.h : it.el.naturalHeight || it.h;
        const isSvg = /\.svg(\?|#|$)/i.test(raw) || /^data:image\/svg/.test(url);
        // 表示されている範囲（object-fit: cover は切り抜き、contain は内側に縮める）
        let crop = null;
        let box = { x: it.x, y: it.y, w: it.w, h: it.h };
        if (it.fit === 'cover' && nw && nh) {
          const sc = Math.max(it.w / nw, it.h / nh);
          const vw = it.w / sc;
          const vh = it.h / sc;
          const pos = String(it.pos || '50% 50%').split(/\s+/).map((v) => (/%$/.test(v) ? parseFloat(v) / 100 : v === 'left' || v === 'top' ? 0 : v === 'right' || v === 'bottom' ? 1 : 0.5));
          crop = { x: (nw - vw) * (pos[0] == null ? 0.5 : pos[0]), y: (nh - vh) * (pos[1] == null ? 0.5 : pos[1]), w: vw, h: vh };
          if (Math.abs(vw - nw) < 1 && Math.abs(vh - nh) < 1) crop = null;
        } else if (it.fit === 'contain' && nw && nh) {
          const sc = Math.min(it.w / nw, it.h / nh);
          box = { x: it.x + (it.w - nw * sc) / 2, y: it.y + (it.h - nh * sc) / 2, w: nw * sc, h: nh * sc };
        }
        if (uc) crop = crop ? { x: crop.x + uc.x, y: crop.y + uc.y, w: crop.w, h: crop.h } : uc;
        let media;
        if (isSvg) media = await rasterize(url, box.w * 2, box.h * 2, crop);
        else if (crop) media = await rasterize(url, Math.min(crop.w, 2400), Math.min(crop.w, 2400) * (crop.h / crop.w), crop, true);
        else {
          media = await fetchBytes(url);
          if (!/^image\/(png|jpeg|gif)$/.test(media.mime)) media = await rasterize(url, nw, nh); // WebP など → PNG
        }
        out.push({ kind: 'image', x: box.x, y: box.y, w: box.w, h: box.h, data: media.data, mime: media.mime, alt: it.alt, radius: it.radius });
      } catch (e) {
        if (warn) warn('画像を書き出せませんでした: ' + (it.el && (it.el.dataset.src || it.el.src)) + '（' + e.message + '）');
      }
    }
    scene.items = out;
    return scene;
  }

  app.exportScene = { sceneOf, resolveMedia, svgToPng, rasterize, fetchBytes, color };
})();
