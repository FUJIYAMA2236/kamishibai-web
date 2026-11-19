/*
 * diagram.js — 図形（工程図・ブロック図など）のデータと SVG への変換。
 *
 * 図形は「assets/<名前>.diagram.svg」という 1 つの SVG ファイルとして保存する。
 *   ・見た目はふつうの SVG なので、スライドでは画像と同じ扱い（大きさ・配置も画像と同じ操作）
 *   ・編集用のデータ（このファイルのモデル）は <metadata id="kamishibai-diagram"> に JSON で入れる
 *     → エディタでダブルクリックすると、図形エディタ（src/editor/diagram-editor.js）で開き直せる
 *   ・PowerPoint に書き出すときは、このモデルから PowerPoint の図形を作る（編集できる図形のまま）
 *
 * モデル:
 *   { version: 1, font, items: [ 図形 | 線 ] }
 *   図形 { id, type: 'shape', shape, x, y, w, h, text, style: { fill, stroke, strokeWidth, dash, textColor, fontSize, bold, align, valign } }
 *        shape: rect | round | ellipse | diamond | parallelogram | hexagon | chevron | pentagon | triangle | cylinder | document | arrow | callout | polygon | text | image
 *        callout（フキダシ）の tail: しっぽの先の位置 [x, y]（枠の左上 0・右下 1 の割合。枠の外に出してよい）
 *        polygon（正多角形）の sides: 角の数（3〜12）
 *        image のときは src（data: URI）と ratio（元の横 / 縦）、style.fit: contain | cover を持つ。
 *        SVG を <img> で表示すると外のファイルは読めないので、画像は SVG の中に埋め込む。
 *        保存時、metadata の JSON には src を入れず（'#ks-img-<id>'）、本体の <image id="ks-img-<id>"> から読み戻す（同じデータを 2 回持たない）
 *   線   { id, type: 'line', from: { id } | { x, y }, to: 同じ, route: straight | elbow, text,
 *          style: { stroke, strokeWidth, dash, start: none|arrow|dot, end: none|arrow|dot, textColor, fontSize } }
 *
 * 文字の折り返しは表示する場所によって変わらないよう、保存時に行へ分けて SVG に書く（measure 関数で幅を測る）。
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.KS = root.KS || {}).diagram = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const META_ID = 'kamishibai-diagram';
  const EXT = '.diagram.svg';
  const PAD = 12;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const unesc = (s) => String(s).replace(/&(lt|gt|quot|apos|#39|amp);/g, (m, k) => ({ lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", amp: '&' }[k]));
  const num = (v) => Math.round(Number(v) * 100) / 100;
  const isDiagramPath = (p) => String(p || '').split(/[?#]/)[0].toLowerCase().endsWith(EXT);

  // 図形の種類（エディタのパレットの順）。label はボタンの名前
  const SHAPES = [
    ['rect', '四角'],
    ['round', '角丸'],
    ['ellipse', '円・楕円'],
    ['diamond', 'ひし形（判断）'],
    ['parallelogram', '平行四辺形（入出力）'],
    ['hexagon', '六角形（準備）'],
    ['chevron', 'シェブロン（工程）'],
    ['pentagon', 'ホームベース（工程）'],
    ['arrow', '矢印'],
    ['triangle', '三角'],
    ['cylinder', '円柱（データ）'],
    ['document', '書類'],
    ['callout', 'フキダシ'],
    ['polygon', '多角形'],
    ['text', 'テキスト'],
  ];

  const DEFAULT_SHAPE_STYLE = { fill: '#e8eefc', stroke: '#4a6fd8', strokeWidth: 2, dash: 'solid', textColor: '#1b2340', fontSize: 18, bold: false, align: 'center', valign: 'middle' };
  /** 図形の見た目（既定値と合わせたもの）。テキスト・画像は既定で塗りも枠も無し */
  const BARE = { fill: 'none', stroke: 'none' };
  const shapeStyle = (it) => Object.assign({}, DEFAULT_SHAPE_STYLE, it.shape === 'text' || it.shape === 'image' ? BARE : null, it.style);
  const DEFAULT_LINE_STYLE = { stroke: '#4a5470', strokeWidth: 2, dash: 'solid', start: 'none', end: 'arrow', textColor: '#1b2340', fontSize: 15 };

  function newModel(font) {
    return { version: 1, font: font || '', items: [] };
  }

  // ------------------------------------------------------------------
  // 図形の輪郭
  // ------------------------------------------------------------------
  /** 図形の輪郭の点（多角形のもの）。無ければ null */
  function polygon(it) {
    const { x, y, w, h } = it;
    switch (it.shape) {
      case 'callout': return calloutPoints(it);
      case 'polygon': {
        const n = sidesOf(it);
        const out = [];
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          out.push([x + w / 2 + (w / 2) * Math.cos(a), y + h / 2 + (h / 2) * Math.sin(a)]);
        }
        return out;
      }
      case 'diamond': return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
      case 'parallelogram': { const s = Math.min(w * 0.22, h * 0.6); return [[x + s, y], [x + w, y], [x + w - s, y + h], [x, y + h]]; }
      case 'hexagon': { const s = Math.min(w * 0.22, h * 0.5); return [[x + s, y], [x + w - s, y], [x + w, y + h / 2], [x + w - s, y + h], [x + s, y + h], [x, y + h / 2]]; }
      case 'chevron': { const d = Math.min(h * 0.5, w * 0.4); return [[x, y], [x + w - d, y], [x + w, y + h / 2], [x + w - d, y + h], [x, y + h], [x + d, y + h / 2]]; }
      case 'pentagon': { const d = Math.min(h * 0.5, w * 0.4); return [[x, y], [x + w - d, y], [x + w, y + h / 2], [x + w - d, y + h], [x, y + h]]; }
      case 'triangle': return [[x + w / 2, y], [x + w, y + h], [x, y + h]];
      case 'arrow': {
        const head = Math.min(w * 0.45, h * 0.9);
        const t = h * 0.28;
        return [[x, y + t], [x + w - head, y + t], [x + w - head, y], [x + w, y + h / 2], [x + w - head, y + h], [x + w - head, y + h - t], [x, y + h - t]];
      }
      default: return null;
    }
  }

  // ---- フキダシ・多角形 ----
  const DEFAULT_TAIL = [0.22, 1.45];
  const DEFAULT_SIDES = 5;
  const sidesOf = (it) => { const n = Math.round(Number(it.sides)); return n >= 3 && n <= 12 ? n : DEFAULT_SIDES; };
  const tailOf = (it) => {
    const t = Array.isArray(it.tail) ? it.tail.map(Number) : null;
    return t && t.length === 2 && t.every(Number.isFinite) ? [Math.max(-3, Math.min(4, t[0])), Math.max(-3, Math.min(4, t[1]))] : DEFAULT_TAIL.slice();
  };
  /** しっぽの先（図の座標。回す前） */
  const tailPoint = (it) => { const t = tailOf(it); return { x: it.x + it.w * t[0], y: it.y + it.h * t[1] }; };
  /**
   * フキダシの輪郭: 四角の、しっぽの先に近い辺に付け根を開けて、先へ向かう三角を足す。
   * 先が枠の中にあるときは、しっぽの無い四角
   */
  function calloutPoints(it) {
    const { x, y, w, h } = it;
    const [tx, ty] = tailOf(it);
    const P = (a, b) => [x + w * a, y + h * b];
    if (tx >= 0 && tx <= 1 && ty >= 0 && ty <= 1) return [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
    // どの辺から出すか: 中心から先への向き（枠を正方形とみなした向き）で決める
    const dx = tx - 0.5;
    const dy = ty - 0.5;
    const tip = P(tx, ty);
    const bw = 0.16; // 付け根の幅（辺の長さに対する割合）
    const lo = bw / 2 + 0.04;
    const hi = 1 - lo;
    const mid = (v) => Math.max(lo, Math.min(hi, 0.5 + v * 0.35));
    if (Math.abs(dy) >= Math.abs(dx)) {
      const c = mid(dx / Math.abs(dy));
      const a = c - bw / 2;
      const b = c + bw / 2;
      if (dy > 0) return [P(0, 0), P(1, 0), P(1, 1), P(b, 1), tip, P(a, 1), P(0, 1)];
      return [P(0, 0), P(a, 0), tip, P(b, 0), P(1, 0), P(1, 1), P(0, 1)];
    }
    const c = mid(dy / Math.abs(dx));
    const a = c - bw / 2;
    const b = c + bw / 2;
    if (dx > 0) return [P(0, 0), P(1, 0), P(1, a), tip, P(1, b), P(1, 1), P(0, 1)];
    return [P(0, 0), P(1, 0), P(1, 1), P(0, 1), P(0, b), tip, P(0, a)];
  }

  /** 図形の輪郭の SVG 要素（属性 attrs を付ける） */
  function shapeOutline(it, attrs) {
    const { x, y, w, h } = it;
    const pts = polygon(it);
    if (pts) return '<polygon points="' + pts.map((p) => num(p[0]) + ',' + num(p[1])).join(' ') + '"' + attrs + '/>';
    switch (it.shape) {
      case 'ellipse': return '<ellipse cx="' + num(x + w / 2) + '" cy="' + num(y + h / 2) + '" rx="' + num(w / 2) + '" ry="' + num(h / 2) + '"' + attrs + '/>';
      case 'round': return '<rect x="' + num(x) + '" y="' + num(y) + '" width="' + num(w) + '" height="' + num(h) + '" rx="' + num(Math.min(w, h) * 0.2) + '"' + attrs + '/>';
      case 'cylinder': {
        const ry = Math.min(h * 0.14, w * 0.25);
        const body = 'M' + num(x) + ',' + num(y + ry) + ' A' + num(w / 2) + ',' + num(ry) + ' 0 0 1 ' + num(x + w) + ',' + num(y + ry) +
          ' V' + num(y + h - ry) + ' A' + num(w / 2) + ',' + num(ry) + ' 0 0 1 ' + num(x) + ',' + num(y + h - ry) + ' Z';
        const lid = 'M' + num(x) + ',' + num(y + ry) + ' A' + num(w / 2) + ',' + num(ry) + ' 0 0 0 ' + num(x + w) + ',' + num(y + ry);
        return '<path d="' + body + '"' + attrs + '/><path d="' + lid + '"' + attrs.replace(/ fill="[^"]*"/, ' fill="none"') + '/>';
      }
      case 'document': {
        const a = h * 0.1;
        const d = 'M' + num(x) + ',' + num(y) + ' H' + num(x + w) + ' V' + num(y + h - a) +
          ' C' + num(x + w * 0.75) + ',' + num(y + h - a * 2.6) + ' ' + num(x + w * 0.5) + ',' + num(y + h + a * 0.6) + ' ' + num(x + w * 0.25) + ',' + num(y + h - a * 0.4) +
          ' S' + num(x + w * 0.05) + ',' + num(y + h - a * 0.6) + ' ' + num(x) + ',' + num(y + h - a * 0.2) + ' Z';
        return '<path d="' + d + '"' + attrs + '/>';
      }
      case 'text': return '';
      case 'image':
        // 画像は枠線だけ（塗りは描かない）
        return / stroke="none"/.test(attrs) ? '' : '<rect x="' + num(x) + '" y="' + num(y) + '" width="' + num(w) + '" height="' + num(h) + '"' + attrs.replace(/ fill="[^"]*"/, ' fill="none"') + '/>';
      default: return '<rect x="' + num(x) + '" y="' + num(y) + '" width="' + num(w) + '" height="' + num(h) + '"' + attrs + '/>';
    }
  }

  /** 文字を置ける内側の範囲（図形によって狭める） */
  function textBox(it) {
    const { x, y, w, h } = it;
    const inset = { diamond: [0.22, 0.2], parallelogram: [0.2, 0.08], hexagon: [0.2, 0.08], chevron: [0.25, 0.08], pentagon: [0.06, 0.08], triangle: [0.24, 0.38], ellipse: [0.14, 0.12], cylinder: [0.06, 0.24], document: [0.06, 0.06], arrow: [0.06, 0.28], polygon: [0.2, 0.16], callout: [0.05, 0.08] }[it.shape] || [0.05, 0.06];
    const ix = Math.max(6, w * inset[0]);
    let top = Math.max(4, h * inset[1]);
    let bottom = top;
    if (it.shape === 'triangle') { bottom = Math.max(4, h * 0.06); }
    if (it.shape === 'document') bottom = h * 0.16;
    if (it.shape === 'chevron') return { x: x + Math.min(h * 0.5, w * 0.4) * 0.9, y: y + top, w: Math.max(10, w - Math.min(h * 0.5, w * 0.4) * 1.9), h: h - top - bottom };
    if (it.shape === 'pentagon') return { x: x + ix, y: y + top, w: Math.max(10, w - ix - Math.min(h * 0.5, w * 0.4) * 0.8), h: h - top - bottom };
    return { x: x + ix, y: y + top, w: Math.max(10, w - ix * 2), h: Math.max(10, h - top - bottom) };
  }

  // ------------------------------------------------------------------
  // 線（コネクタ）
  // ------------------------------------------------------------------
  const center = (it) => ({ x: it.x + it.w / 2, y: it.y + it.h / 2 });

  // ---- 回転（it.rot: 中心を軸に時計回りの角度。度） ----
  const rotOf = (it) => { const r = Number(it && it.rot) || 0; return ((r % 360) + 360) % 360; };
  /** 点 p を c を中心に deg 度（時計回り）回す */
  function rotate(p, c, deg) {
    if (!deg) return { x: p.x, y: p.y };
    const a = (deg * Math.PI) / 180;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
  }
  /** 図の座標 → 回す前の図形の座標（当たり判定・大きさの変更に使う） */
  const toLocal = (it, p) => rotate(p, center(it), -rotOf(it));
  const toWorld = (it, p) => rotate(p, center(it), rotOf(it));
  /** 回したあとの 4 隅 */
  const corners = (it) => [[0, 0], [1, 0], [1, 1], [0, 1]].map(([a, b]) => toWorld(it, { x: it.x + it.w * a, y: it.y + it.h * b }));
  /** 点が図形の中にあるか（回転も考える。輪郭ではなく外枠の四角で判定） */
  function contains(it, p) {
    const q = toLocal(it, p);
    return q.x >= it.x && q.x <= it.x + it.w && q.y >= it.y && q.y <= it.y + it.h;
  }

  /** 図形の中心から (tx, ty) へ向かう線が、図形の輪郭と交わる点（回した図形は、回す前の向きで求めてから戻す） */
  function boundaryPoint(it, tx, ty) {
    if (rotOf(it)) {
      const t = toLocal(it, { x: tx, y: ty });
      return toWorld(it, boundaryPointFlat(it, t.x, t.y));
    }
    return boundaryPointFlat(it, tx, ty);
  }
  function boundaryPointFlat(it, tx, ty) {
    const c = center(it);
    let dx = tx - c.x;
    let dy = ty - c.y;
    if (!dx && !dy) return c;
    if (it.shape === 'ellipse') {
      const t = 1 / Math.sqrt((dx * dx) / ((it.w / 2) ** 2) + (dy * dy) / ((it.h / 2) ** 2));
      return { x: c.x + dx * t, y: c.y + dy * t };
    }
    const pts = polygon(it);
    if (pts) {
      // 中心からの半直線と各辺の交点のうち、いちばん近いもの
      let best = null;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((a[0] - c.x) * ey - (a[1] - c.y) * ex) / den;
        const u = ((a[0] - c.x) * dy - (a[1] - c.y) * dx) / den;
        if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6 && (!best || t < best)) best = t;
      }
      if (best) return { x: c.x + dx * best, y: c.y + dy * best };
    }
    const t = Math.min((it.w / 2) / Math.abs(dx || 1e-9), (it.h / 2) / Math.abs(dy || 1e-9));
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  /** 上下左右の辺の中点（直角の線をつなぐ口） */
  function sidePoint(it, side) {
    const c = center(it);
    let p;
    if (side === 'top') p = { x: c.x, y: it.y };
    else if (side === 'bottom') p = { x: c.x, y: it.y + it.h };
    else if (side === 'left') p = { x: it.x, y: c.y };
    else p = { x: it.x + it.w, y: c.y };
    return toWorld(it, p);
  }

  const byId = (model) => { const m = {}; for (const it of model.items) m[it.id] = it; return m; };

  /**
   * 線の通る点の列を求める。
   * @returns {Array<{x, y}>} 2 点以上
   */
  function linePoints(line, index) {
    const a = line.from && line.from.id ? index[line.from.id] : null;
    const b = line.to && line.to.id ? index[line.to.id] : null;
    const pa = a ? center(a) : { x: Number(line.from.x) || 0, y: Number(line.from.y) || 0 };
    const pb = b ? center(b) : { x: Number(line.to.x) || 0, y: Number(line.to.y) || 0 };
    if (line.route !== 'elbow') {
      const s = a ? boundaryPoint(a, pb.x, pb.y) : pa;
      const e = b ? boundaryPoint(b, pa.x, pa.y) : pb;
      return [s, e];
    }
    // 直角に折れる線: 横に離れていれば左右の辺、縦に離れていれば上下の辺から出す
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const horiz = Math.abs(dx) >= Math.abs(dy);
    const s = a ? sidePoint(a, horiz ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top')) : pa;
    const e = b ? sidePoint(b, horiz ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom')) : pb;
    if (horiz) {
      if (Math.abs(s.y - e.y) < 0.5) return [s, e];
      const mx = (s.x + e.x) / 2;
      return [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
    }
    if (Math.abs(s.x - e.x) < 0.5) return [s, e];
    const my = (s.y + e.y) / 2;
    return [s, { x: s.x, y: my }, { x: e.x, y: my }, e];
  }

  function arrowHead(tip, from, size, color) {
    const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
    const l = size;
    const wHalf = size * 0.55;
    const bx = tip.x - Math.cos(ang) * l;
    const by = tip.y - Math.sin(ang) * l;
    const px = -Math.sin(ang) * wHalf;
    const py = Math.cos(ang) * wHalf;
    return '<polygon points="' + [[tip.x, tip.y], [bx + px, by + py], [bx - px, by - py]].map((p) => num(p[0]) + ',' + num(p[1])).join(' ') + '" fill="' + esc(color) + '"/>';
  }

  /** 矢印の分だけ線の端を手前に縮める（線の太さで先端がつぶれないように） */
  function shorten(pts, atStart, atEnd, size) {
    const out = pts.map((p) => ({ x: p.x, y: p.y }));
    const pull = (i, j) => {
      const dx = out[i].x - out[j].x;
      const dy = out[i].y - out[j].y;
      const len = Math.hypot(dx, dy) || 1;
      const d = Math.min(size * 0.8, len * 0.5);
      out[i].x -= (dx / len) * d;
      out[i].y -= (dy / len) * d;
    };
    if (atStart) pull(0, 1);
    if (atEnd) pull(out.length - 1, out.length - 2);
    return out;
  }

  const DASH = { solid: '', dashed: '8 6', dotted: '2 5' };
  function dashAttr(style) {
    const d = DASH[style.dash] || '';
    if (!d) return '';
    const sw = Number(style.strokeWidth) || 1;
    return ' stroke-dasharray="' + d.split(' ').map((v) => num(v * Math.max(1, sw / 2))).join(' ') + '"' + (style.dash === 'dotted' ? ' stroke-linecap="round"' : '');
  }

  // ------------------------------------------------------------------
  // 文字の折り返し
  // ------------------------------------------------------------------
  /** 文字幅のおおよその見積もり（measure が無いとき。全角 1em・半角 0.55em） */
  function roughMeasure(text, size) {
    let w = 0;
    for (const ch of text) w += /[\u0000-ÿ｡-ﾟ]/.test(ch) ? 0.55 : 1;
    return w * size;
  }

  /** text を maxWidth に収まるよう行に分ける（英単語は途中で切らない。日本語は文字ごと） */
  function wrapText(text, maxWidth, size, bold, measure) {
    const m = measure || ((t) => roughMeasure(t, size));
    const out = [];
    for (const para of String(text || '').split('\n')) {
      if (!para) { out.push(''); continue; }
      const tokens = para.match(/[A-Za-z0-9_\-.,:;!?'"()/%+#@&]+\s*|\s+|./gu) || [];
      let line = '';
      for (const tok of tokens) {
        const next = line + tok;
        if (line && m(next.replace(/\s+$/, ''), size, bold) > maxWidth) {
          out.push(line.replace(/\s+$/, ''));
          line = tok.replace(/^\s+/, '');
          // 1 語だけで幅を超えるときは文字単位で切る
          while (line && m(line, size, bold) > maxWidth && line.length > 1) {
            let k = line.length - 1;
            while (k > 1 && m(line.slice(0, k), size, bold) > maxWidth) k--;
            out.push(line.slice(0, k));
            line = line.slice(k);
          }
        } else {
          line = next;
        }
      }
      out.push(line.replace(/\s+$/, ''));
    }
    return out;
  }

  function textBlock(lines, box, style, font) {
    const size = Number(style.fontSize) || 16;
    const lh = size * 1.3;
    const total = lines.length * lh;
    let y0;
    if (style.valign === 'top') y0 = box.y + size * 0.95;
    else if (style.valign === 'bottom') y0 = box.y + box.h - total + size * 0.95;
    else y0 = box.y + (box.h - total) / 2 + size * 0.95;
    const anchor = style.align === 'left' ? 'start' : style.align === 'right' ? 'end' : 'middle';
    const x = style.align === 'left' ? box.x : style.align === 'right' ? box.x + box.w : box.x + box.w / 2;
    return '<text x="' + num(x) + '" y="' + num(y0) + '" font-size="' + num(size) + '"' + (style.bold ? ' font-weight="700"' : '') +
      ' text-anchor="' + anchor + '" fill="' + esc(style.textColor || '#000') + '"' + (font ? ' font-family="' + esc(font) + '"' : '') + '>' +
      lines.map((l, i) => '<tspan x="' + num(x) + '"' + (i ? ' dy="' + num(lh) + '"' : '') + '>' + (esc(l) || ' ') + '</tspan>').join('') + '</text>';
  }

  // ------------------------------------------------------------------
  // SVG への変換
  // ------------------------------------------------------------------
  /** 図形・線がすべて入る範囲 */
  function bounds(model) {
    const index = byId(model);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const add = (x, y) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
    for (const it of model.items) {
      if (it.type === 'shape') {
        for (const p of corners(it)) add(p.x, p.y);
        if (it.shape === 'callout') { const p = toWorld(it, tailPoint(it)); add(p.x, p.y); } // しっぽの先も
      }
      else if (it.type === 'line') for (const p of linePoints(it, index)) add(p.x, p.y);
    }
    if (x1 === Infinity) return { x: 0, y: 0, w: 400, h: 240 };
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  /**
   * 図形・線それぞれの SVG（エディタは 1 つずつ使う。保存時は toSvg がまとめる）
   * @param {Object} opts { measure(text, size, bold) → px, font }
   */
  function itemSvg(it, index, opts) {
    opts = opts || {};
    const font = opts.font || '';
    if (it.type === 'shape') {
      const st = shapeStyle(it);
      const attrs = ' fill="' + esc(st.fill || 'none') + '" stroke="' + esc(st.stroke || 'none') + '" stroke-width="' + num(st.stroke && st.stroke !== 'none' ? st.strokeWidth : 0) + '"' + dashAttr(st) + ' stroke-linejoin="round"';
      let out = '';
      if (it.shape === 'image' && it.src) {
        // 属性の順（id → href）は fromSvg が読み戻すときに頼っている
        out += '<image id="ks-img-' + esc(it.id) + '" href="' + esc(it.src) + '" x="' + num(it.x) + '" y="' + num(it.y) + '" width="' + num(it.w) + '" height="' + num(it.h) + '"' +
          ' preserveAspectRatio="xMidYMid ' + (st.fit === 'cover' ? 'slice' : 'meet') + '"/>';
      }
      out += shapeOutline(it, attrs);
      if (it.text) {
        const box = textBox(it);
        const lines = wrapText(it.text, box.w, Number(st.fontSize) || 16, st.bold, opts.measure ? (t, s, b) => opts.measure(t, s, b, font) : null);
        out += textBlock(lines, box, st, font);
      }
      const r = rotOf(it);
      if (r) { const c = center(it); out = '<g transform="rotate(' + num(r) + ' ' + num(c.x) + ' ' + num(c.y) + ')">' + out + '</g>'; }
      return out;
    }
    if (it.type === 'line') {
      const st = Object.assign({}, DEFAULT_LINE_STYLE, it.style);
      const sw = Number(st.strokeWidth) || 2;
      const size = 6 + sw * 2.6;
      const raw = linePoints(it, index);
      const pts = shorten(raw, st.start === 'arrow', st.end === 'arrow', size);
      let out = '<polyline points="' + pts.map((p) => num(p.x) + ',' + num(p.y)).join(' ') + '" fill="none" stroke="' + esc(st.stroke) + '" stroke-width="' + num(sw) + '" stroke-linejoin="round"' + dashAttr(st) + '/>';
      const cap = (kind, tip, from) => {
        if (kind === 'arrow') return arrowHead(tip, from, size, st.stroke);
        if (kind === 'dot') return '<circle cx="' + num(tip.x) + '" cy="' + num(tip.y) + '" r="' + num(sw * 1.8 + 1.5) + '" fill="' + esc(st.stroke) + '"/>';
        return '';
      };
      out += cap(st.start, raw[0], raw[1]) + cap(st.end, raw[raw.length - 1], raw[raw.length - 2]);
      if (it.text) {
        const mid = midPoint(raw);
        const size2 = Number(st.fontSize) || 14;
        const lines = String(it.text).split('\n');
        const halo = opts.halo && opts.halo !== 'none' ? ' stroke="' + esc(opts.halo) + '" stroke-width="' + num(size2 * 0.35) + '" paint-order="stroke" stroke-linejoin="round"' : '';
        out += textBlock(lines, { x: mid.x - 200, y: mid.y - (lines.length * size2 * 1.3) / 2 - size2 * 0.7, w: 400, h: lines.length * size2 * 1.3 }, Object.assign({}, st, { align: 'center', valign: 'top' }), font)
          .replace('<text ', '<text' + halo + ' ');
      }
      return out;
    }
    return '';
  }

  /** 折れ線の長さの真ん中の点 */
  function midPoint(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    let half = total / 2;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (half <= seg && seg) {
        const t = half / seg;
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
      }
      half -= seg;
    }
    return pts[0];
  }

  /**
   * 保存用の SVG ファイルの中身（編集用データを metadata に入れる）
   * @param {Object} opts { measure, halo }
   */
  function toSvg(model, opts) {
    opts = Object.assign({ font: model.font }, opts);
    const index = byId(model);
    const b = bounds(model);
    const vx = Math.floor(b.x - PAD);
    const vy = Math.floor(b.y - PAD);
    const vw = Math.ceil(b.w + PAD * 2);
    const vh = Math.ceil(b.h + PAD * 2);
    const body = model.items.map((it) => itemSvg(it, index, Object.assign({ halo: model.halo }, opts))).join('\n');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + [vx, vy, vw, vh].join(' ') + '" width="' + vw + '" height="' + vh + '">\n' +
      '<metadata id="' + META_ID + '">' + esc(JSON.stringify(stripImages(model))) + '</metadata>\n' +
      body + '\n</svg>\n';
  }

  /** metadata に入れるモデル（画像のデータは本体の <image> にあるので、参照だけにする） */
  function stripImages(model) {
    if (!model.items.some((it) => it.src)) return model;
    return Object.assign({}, model, { items: model.items.map((it) => (it.src ? Object.assign({}, it, { src: '#ks-img-' + it.id }) : it)) });
  }

  /**
   * 読み込んだモデルの値を、決まった形にそろえる（他人から受け取った図形ファイルに、文字列を混ぜた座標や
   * 引用符を含む ID などがあっても、画面に描くときに HTML / SVG として解釈されないように）。
   */
  const SHAPE_IDS = new Set(SHAPES.map((s) => s[0]).concat(['image']));
  const STYLE_KEYS = new Set(Object.keys(DEFAULT_SHAPE_STYLE).concat(Object.keys(DEFAULT_LINE_STYLE), ['fit']));
  function normalizeModel(model) {
    const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
    const okId = (v) => typeof v === 'string' && /^[\w-]{1,40}$/.test(v);
    const style = (s) => {
      const out = {};
      for (const [k, v] of Object.entries(s && typeof s === 'object' ? s : {})) {
        if (!STYLE_KEYS.has(k)) continue;
        if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
        else if (typeof v === 'string' && /^[#\w.\s(),%-]{0,60}$/.test(v)) out[k] = v; // 色・none・solid などだけ
      }
      return out;
    };
    const end = (e) => (e && okId(e.id) ? { id: e.id } : { x: n(e && e.x), y: n(e && e.y) });
    const items = [];
    const seen = new Set();
    for (const it of Array.isArray(model.items) ? model.items : []) {
      if (!it || !okId(it.id) || seen.has(it.id)) continue;
      seen.add(it.id);
      const text = typeof it.text === 'string' ? it.text : '';
      if (it.type === 'shape') {
        const o = { id: it.id, type: 'shape', shape: SHAPE_IDS.has(it.shape) ? it.shape : 'rect', x: n(it.x), y: n(it.y), w: Math.max(1, n(it.w)), h: Math.max(1, n(it.h)), text, style: style(it.style) };
        const r = rotOf({ rot: n(it.rot) });
        if (r) o.rot = Math.round(r * 100) / 100;
        if (o.shape === 'callout' && Array.isArray(it.tail)) { const t = tailOf(it); o.tail = [Math.round(t[0] * 1000) / 1000, Math.round(t[1] * 1000) / 1000]; }
        if (o.shape === 'polygon' && it.sides != null) o.sides = sidesOf(it);
        if (o.shape === 'image') {
          o.src = typeof it.src === 'string' && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif);base64,[A-Za-z0-9+/=]+$/.test(it.src) ? it.src : '';
          if (Number.isFinite(Number(it.ratio))) o.ratio = Number(it.ratio);
        }
        items.push(o);
      } else if (it.type === 'line') {
        items.push({ id: it.id, type: 'line', route: it.route === 'elbow' ? 'elbow' : 'straight', from: end(it.from), to: end(it.to), text, style: style(it.style) });
      }
    }
    const out = { version: 1, font: typeof model.font === 'string' ? model.font.replace(/[<>"]/g, '') : '', items };
    if (typeof model.halo === 'string' && /^[#\w]{0,20}$/.test(model.halo)) out.halo = model.halo;
    if (model.defaults && typeof model.defaults === 'object') out.defaults = { shape: style(model.defaults.shape), line: style(model.defaults.line) };
    return out;
  }

  /** 保存された SVG から編集用データを取り出す（図形のファイルでなければ null） */
  function fromSvg(text) {
    const m = new RegExp('<metadata id="' + META_ID + '">([\\s\\S]*?)</metadata>').exec(String(text || ''));
    if (!m) return null;
    try {
      const model = JSON.parse(unesc(m[1]));
      if (!model || !Array.isArray(model.items)) return null;
      for (const it of model.items) {
        if (typeof it.src !== 'string' || it.src.charAt(0) !== '#') continue;
        const id = it.src.slice(1).replace(/[^\w-]/g, '');
        const im = new RegExp('<image id="' + id + '" href="([^"]*)"').exec(text);
        it.src = im ? unesc(im[1]) : '';
      }
      return normalizeModel(model);
    } catch (e) {
      return null;
    }
  }

  return {
    EXT, SHAPES, DEFAULT_TAIL, DEFAULT_SIDES, sidesOf, tailOf, tailPoint, DEFAULT_SHAPE_STYLE, DEFAULT_LINE_STYLE, META_ID, shapeStyle, normalizeModel,
    rotate, rotOf, toLocal, toWorld, corners, contains, center,
    newModel, polygon, shapeOutline, textBox, linePoints, boundaryPoint, sidePoint, midPoint, byId, bounds,
    wrapText, itemSvg, toSvg, fromSvg, isDiagramPath,
  };
});
