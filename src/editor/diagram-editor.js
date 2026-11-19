/*
 * diagram-editor.js — 図形エディタ（工程図・ブロック図などを描く画面）。
 *
 * 図形は assets/<名前>.diagram.svg に保存する（中身の形式は core/diagram.js）。
 * スライドでは画像と同じに扱うので、大きさや置き場所はプレビュー・エディタの画像操作で変えられる。
 *
 * 開き方:
 *   ・ツールバーの「図形」… 新しい図形を作り、保存するとカーソル位置に挿入
 *   ・エディタ / プレビューで図形をダブルクリック … その図形を開いて編集（保存すると上書き）
 *
 * 操作:
 *   左のパレットから図形をクリック（またはドラッグ）で追加 / 図形の周りの ● をドラッグして別の図形へ → 線でつなぐ
 *   ダブルクリックで文字を入力 / 角のハンドルで大きさ / ドラッグで移動（10px 単位でそろう。Alt で自由に）
 *   画像は「画像…」ボタン・ファイルのドロップ・Ctrl+V で入れる（SVG の中に埋め込む）
 *   Delete 削除 / Ctrl+Z 元に戻す / Ctrl+C・V・D 複製 / Ctrl+A すべて選択 / 矢印キーで少し動かす / Ctrl+ホイールで拡大縮小
 */
(function () {
  'use strict';
  const app = window.KSE;
  const { h, toast } = app;
  const D = window.KS.diagram;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const GRID = 10;

  // 文字幅を測る（保存する SVG の折り返しと、エディタの表示を一致させる）
  const mctx = document.createElement('canvas').getContext('2d');
  function measure(text, size, bold, font) {
    mctx.font = (bold ? '700 ' : '400 ') + size + 'px ' + (font || 'sans-serif');
    return mctx.measureText(text).width;
  }

  const ICON = (p) => '<svg viewBox="0 0 24 24">' + p + '</svg>';
  const SHAPE_ICONS = {
    rect: '<rect x="3.5" y="6.5" width="17" height="11"/>',
    round: '<rect x="3.5" y="6.5" width="17" height="11" rx="3.5"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6"/>',
    diamond: '<path d="M12 4l8.5 8-8.5 8-8.5-8z"/>',
    parallelogram: '<path d="M7 6.5h13.5l-3.5 11H3.5z"/>',
    hexagon: '<path d="M7.5 6.5h9l4 5.5-4 5.5h-9l-4-5.5z"/>',
    chevron: '<path d="M3.5 6.5h12l5 5.5-5 5.5h-12l5-5.5z"/>',
    pentagon: '<path d="M3.5 6.5h12l5 5.5-5 5.5h-12z"/>',
    arrow: '<path d="M3.5 9.5h10v-4l7 6.5-7 6.5v-4h-10z"/>',
    triangle: '<path d="M12 5l8.5 14h-17z"/>',
    cylinder: '<path d="M5.5 7c0-1.4 2.9-2.5 6.5-2.5s6.5 1.1 6.5 2.5v10c0 1.4-2.9 2.5-6.5 2.5S5.5 18.4 5.5 17z"/><path d="M5.5 7c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5"/>',
    document: '<path d="M4.5 5h15v11.5c-2.5-1.5-4.5 2.5-7.5 1s-5-1.5-7.5 0z"/>',
    callout: '<path d="M3.5 5h17v10.5H10l-4.5 4v-4h-2z"/>',
    polygon: '<path d="M12 3.8l8.2 6-3.1 9.6H6.9L3.8 9.8z"/>',
    text: '<path d="M6 6.5h12M12 6.5V18"/>',
  };
  const SIZES = { ellipse: [140, 90], diamond: [150, 100], chevron: [170, 70], pentagon: [170, 70], arrow: [150, 64], triangle: [120, 100], cylinder: [110, 120], text: [180, 44], hexagon: [160, 76], callout: [170, 80], polygon: [110, 105] };

  // ---- 色（テーマに合わせた既定値と、パレット） ----
  function hexToRgb(hex) {
    let s = String(hex || '').trim().replace('#', '');
    if (s.length === 3) s = s.replace(/./g, '$&$&');
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  }
  function mix(a, b, t) {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    if (!x || !y) return a;
    return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
  }
  function themeColors() {
    const t = (app.state.out && app.state.out.resolved.tokens) || {};
    const hex = (c, f) => (hexToRgb(c) ? c : f);
    const bg = hex(t.bg, '#ffffff');
    const text = hex(t.text, '#1b2340');
    const accent = hex(t.accent, '#4a6fd8');
    const accent2 = hex(t.accent2, accent);
    return { bg, text, accent, accent2, muted: hex(t.muted, mix(text, bg, 0.6)), surface: hex(t.surface, mix(text, bg, 0.08)), font: t.fontBody || '' };
  }
  function themeDefaults() {
    const c = themeColors();
    return {
      shape: { fill: mix(c.accent, c.bg, 0.2), stroke: c.accent, textColor: c.text },
      line: { stroke: mix(c.text, c.bg, 0.65), textColor: c.text },
      halo: c.bg,
      font: c.font,
    };
  }
  function swatches() {
    const c = themeColors();
    return [
      c.bg, c.surface, c.text, c.muted, c.accent, c.accent2, mix(c.accent, c.bg, 0.2), mix(c.accent2, c.bg, 0.2),
      '#ffffff', '#f2f2f2', '#9aa0aa', '#333333', '#000000', '#e5484d', '#f2994a', '#f2c94c', '#3dbb6e', '#2f80ed', '#9b51e0', '#eb5ea8',
    ];
  }

  const uid = () => 'n' + Math.random().toString(36).slice(2, 9);
  const snap = (v, on) => (on ? Math.round(v / GRID) * GRID : Math.round(v));
  const clone = (v) => JSON.parse(JSON.stringify(v));

  let ed = null; // 開いている間のエディタの状態
  let clipboard = null;

  // ==================================================================
  // 開く・閉じる・保存
  // ==================================================================
  /**
   * @param {Object} opts { path: 既存の図形（assets/….diagram.svg）}。無ければ新規
   */
  async function open(opts) {
    opts = opts || {};
    if (ed) return;
    let model = null;
    if (opts.path) {
      try {
        const res = await fetch(app.assetUrl(opts.path, true));
        if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
        model = D.fromSvg(await res.text());
      } catch (e) {
        toast('図形を読み込めませんでした: ' + e.message, true);
        return;
      }
      if (!model) { toast('この SVG は図形エディタで作ったものではないため、編集できません', true); return; }
    }
    const defaults = themeDefaults();
    if (!model) model = Object.assign(D.newModel(defaults.font), { halo: defaults.halo, defaults: { shape: defaults.shape, line: defaults.line } });
    model.defaults = model.defaults || { shape: defaults.shape, line: defaults.line };
    ed = {
      path: opts.path || null,
      model,
      sel: new Set(),
      history: [],
      future: [],
      zoom: 1,
      pan: { x: 0, y: 0 },
      tool: 'select',
      dirty: false,
      hover: null,
      drag: null,
    };
    build();
    render();
    requestAnimationFrame(() => fit());
  }

  async function save(close) {
    if (!ed) return;
    commitText();
    const text = D.toSvg(ed.model, { measure, halo: ed.model.halo });
    const bytes = new Blob([text], { type: 'image/svg+xml' });
    try {
      let path = ed.path;
      if (path) {
        await app.writeProjectFile(path, bytes);
      } else {
        const name = 'diagram-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + D.EXT;
        path = await app.saveAsset(name, bytes);
        ed.path = path;
        app.insertBlock('![図](' + encodeURI(path) + ')');
      }
      app.bumpAsset(path);
      ed.dirty = false;
      ed.els.title.textContent = path;
      toast('図形を保存しました（' + path + '）');
      if (close) shut();
    } catch (e) {
      toast('図形を保存できませんでした: ' + e.message, true);
    }
  }

  function shut(force) {
    if (!ed) return;
    if (!force && ed.dirty && !confirm('保存していない変更があります。閉じてよいですか？')) return;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('paste', onPaste, true);
    ed.els.overlay.remove();
    ed = null;
    app.editor && app.editor.focus();
  }

  // ==================================================================
  // 変更と履歴
  // ==================================================================
  function snapshot() {
    ed.history.push(JSON.stringify(ed.model));
    if (ed.history.length > 200) ed.history.shift();
    ed.future = [];
  }
  /** モデルを変える操作。fn の前に履歴を積む */
  function change(fn) {
    snapshot();
    fn(ed.model);
    ed.dirty = true;
    render();
  }
  function undo(redo) {
    const from = redo ? ed.future : ed.history;
    const to = redo ? ed.history : ed.future;
    if (!from.length) return;
    to.push(JSON.stringify(ed.model));
    ed.model = JSON.parse(from.pop());
    for (const id of Array.from(ed.sel)) if (!find(id)) ed.sel.delete(id);
    ed.dirty = true;
    render();
  }

  const find = (id) => ed.model.items.find((it) => it.id === id);
  const selected = () => ed.model.items.filter((it) => ed.sel.has(it.id));
  const index = () => D.byId(ed.model);

  // ==================================================================
  // 画面の組み立て
  // ==================================================================
  function build() {
    const btn = (icon, label, fn, cls) => h('button', { type: 'button', class: 'dg-btn' + (cls ? ' ' + cls : ''), title: label, html: ICON(icon) + '<span>' + label + '</span>', onclick: fn });
    const title = h('span', { class: 'dg-title' }, ed.path || '新しい図形（保存すると assets/ に入ります）');
    const header = h('div', { class: 'dg-header' },
      h('b', null, '図形エディタ'), title, h('span', { class: 'spacer' }),
      btn('<path d="M9 14L4.5 9.5 9 5"/><path d="M4.5 9.5h10a5 5 0 0 1 0 10H11"/>', '元に戻す', () => undo(false), 'icon-only'),
      btn('<path d="M15 14l4.5-4.5L15 5"/><path d="M19.5 9.5h-10a5 5 0 0 0 0 10H13"/>', 'やり直し', () => undo(true), 'icon-only'),
      btn('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8 11h6"/>', '縮小', () => zoomBy(1 / 1.2), 'icon-only'),
      h('button', { type: 'button', class: 'dg-zoom', title: '全体を表示', onclick: () => fit() }, '100%'),
      btn('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8 11h6M11 8v6"/>', '拡大', () => zoomBy(1.2), 'icon-only'),
      h('span', { class: 'sep' }),
      h('button', { type: 'button', class: 'btn', onclick: () => shut() }, '閉じる'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => save(true) }, '保存して閉じる'));

    const palette = h('div', { class: 'dg-palette' });
    palette.append(h('div', { class: 'dg-label' }, '図形'));
    for (const [id, label] of D.SHAPES) {
      const b = h('button', { type: 'button', class: 'dg-shape', title: label + '（クリックで追加 / キャンバスへドラッグ）', draggable: true, html: ICON(SHAPE_ICONS[id]) + '<span>' + label.replace(/（.*/, '') + '</span>' });
      b.addEventListener('click', () => addShape(id));
      b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-ks-shape', id); e.dataTransfer.effectAllowed = 'copy'; });
      palette.append(b);
    }
    palette.append(h('div', { class: 'dg-label' }, '画像'));
    palette.append(h('button', { type: 'button', class: 'dg-shape', title: '画像を挿入（キャンバスへのドラッグ＆ドロップ・Ctrl+V の貼り付けでも入れられます）', html: ICON('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17.5l5-4.5 3.5 3 3-2.5 4.5 4"/>') + '<span>画像…</span>', onclick: () => pickImage() }));
    palette.append(h('div', { class: 'dg-label' }, '線'));
    const lineBtn = (route, label, icon) => {
      const b = h('button', { type: 'button', class: 'dg-shape', 'data-tool': 'line-' + route, title: label + '（ドラッグで線を引く。図形から図形へ引くとつながる）', html: ICON(icon) + '<span>' + label + '</span>' });
      b.addEventListener('click', () => setTool(ed.tool === 'line-' + route ? 'select' : 'line-' + route));
      return b;
    };
    palette.append(
      lineBtn('straight', '矢印線', '<path d="M4 19L18 5"/><path d="M11 5h7v7"/>'),
      lineBtn('elbow', 'カギ線', '<path d="M4 18h8V6h6"/><path d="M15 3l3 3-3 3"/>'));
    palette.append(h('p', { class: 'dg-hint' }, '図形にマウスを乗せると出る ● から、別の図形へドラッグしてもつなげます。ダブルクリックで文字を入力。'));

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'dg-canvas');
    const world = document.createElementNS(SVGNS, 'g');
    const items = document.createElementNS(SVGNS, 'g');
    const over = document.createElementNS(SVGNS, 'g');
    world.append(items, over);
    svg.append(world);
    const stage = h('div', { class: 'dg-stage' }, svg);
    const props = h('div', { class: 'dg-props' });
    const overlay = h('div', { class: 'dg-overlay' }, header, h('div', { class: 'dg-body' }, palette, stage, props));
    document.body.append(overlay);
    ed.els = { overlay, svg, world, items, over, stage, props, title, zoomLabel: header.querySelector('.dg-zoom'), palette };

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dragover', (e) => {
      const types = Array.from(e.dataTransfer.types);
      if (types.includes('text/x-ks-shape') || types.includes('Files')) { e.preventDefault(); e.stopPropagation(); }
    });
    stage.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData('text/x-ks-shape');
      const files = Array.from(e.dataTransfer.files || []).filter((f) => /^image\//.test(f.type));
      if (!id && !files.length) return;
      e.preventDefault();
      e.stopPropagation(); // エディタ本体の「画像をスライドへ」のドロップにしない
      const p = toWorld(e);
      if (id) addShape(id, p);
      else files.forEach((f, i) => addImage(f, { x: p.x + i * 30, y: p.y + i * 30 }));
    });
    window.addEventListener('paste', onPaste, true);
    new ResizeObserver(() => applyView()).observe(stage);
    window.addEventListener('keydown', onKey, true);
  }

  function setTool(tool) {
    ed.tool = tool;
    ed.els.palette.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('is-active', b.dataset.tool === tool));
    ed.els.svg.classList.toggle('is-drawing', tool !== 'select');
  }

  // ---- 表示位置（拡大縮小・スクロール） ----
  function applyView() {
    if (!ed) return;
    ed.els.world.setAttribute('transform', 'translate(' + ed.pan.x + ' ' + ed.pan.y + ') scale(' + ed.zoom + ')');
    const g = GRID * ed.zoom;
    ed.els.stage.style.backgroundSize = g * 5 + 'px ' + g * 5 + 'px, ' + g * 5 + 'px ' + g * 5 + 'px, ' + g + 'px ' + g + 'px, ' + g + 'px ' + g + 'px';
    ed.els.stage.style.backgroundPosition = Array(4).fill(ed.pan.x + 'px ' + ed.pan.y + 'px').join(', ');
    ed.els.zoomLabel.textContent = Math.round(ed.zoom * 100) + '%';
    renderOverlay();
  }
  function zoomAt(factor, sx, sy) {
    const z = Math.max(0.2, Math.min(4, ed.zoom * factor));
    ed.pan.x = sx - ((sx - ed.pan.x) * z) / ed.zoom;
    ed.pan.y = sy - ((sy - ed.pan.y) * z) / ed.zoom;
    ed.zoom = z;
    applyView();
  }
  function zoomBy(f) {
    const r = ed.els.stage.getBoundingClientRect();
    zoomAt(f, r.width / 2, r.height / 2);
  }
  /** 図形全体が見えるように */
  function fit() {
    if (!ed) return;
    const r = ed.els.stage.getBoundingClientRect();
    if (!ed.model.items.length) { ed.zoom = 1; ed.pan = { x: Math.round(r.width / 2 - 300), y: Math.round(r.height / 2 - 180) }; applyView(); return; }
    const b = D.bounds(ed.model);
    const z = Math.max(0.2, Math.min(1.5, Math.min((r.width - 80) / (b.w || 1), (r.height - 80) / (b.h || 1))));
    ed.zoom = z;
    ed.pan = { x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z };
    applyView();
  }
  function toWorld(e) {
    const r = ed.els.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - ed.pan.x) / ed.zoom, y: (e.clientY - r.top - ed.pan.y) / ed.zoom };
  }
  function viewCenter() {
    const r = ed.els.stage.getBoundingClientRect();
    return { x: (r.width / 2 - ed.pan.x) / ed.zoom, y: (r.height / 2 - ed.pan.y) / ed.zoom };
  }

  // ==================================================================
  // 描画
  // ==================================================================
  function render() {
    if (!ed) return;
    const idx = index();
    const parts = [];
    for (const it of ed.model.items) {
      let hit = '';
      if (it.type === 'shape') hit = '<rect class="dg-hit" x="' + it.x + '" y="' + it.y + '" width="' + it.w + '" height="' + it.h + '"' + rotAttr(it) + '/>';
      else {
        const pts = D.linePoints(it, idx);
        hit = '<polyline class="dg-hit-line" points="' + pts.map((p) => p.x + ',' + p.y).join(' ') + '"/>';
      }
      parts.push('<g data-id="' + it.id + '">' + hit + D.itemSvg(it, idx, { measure, font: ed.model.font, halo: ed.model.halo }) + '</g>');
    }
    ed.els.items.innerHTML = parts.join('');
    renderOverlay();
    renderProps();
  }

  function el(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  /** 回した図形に合わせる transform 属性（回していなければ空） */
  function rotAttr(it) {
    const r = D.rotOf(it);
    if (!r) return '';
    const c = D.center(it);
    return ' transform="rotate(' + r + ' ' + c.x + ' ' + c.y + ')"';
  }
  /** 選択の枠・ハンドルを入れる g（回した図形のときは一緒に回す） */
  function rotGroup(it, parent) {
    const g = el('g', {});
    const r = D.rotOf(it);
    if (r) { const c = D.center(it); g.setAttribute('transform', 'rotate(' + r + ' ' + c.x + ' ' + c.y + ')'); }
    parent.append(g);
    return g;
  }

  function renderOverlay() {
    if (!ed) return;
    const over = ed.els.over;
    over.innerHTML = '';
    const z = ed.zoom;
    const hs = 8 / z; // ハンドルの大きさ（画面上で一定）
    const idx = index();
    const sel = selected();
    for (const it of sel) {
      if (it.type === 'shape') {
        rotGroup(it, over).append(el('rect', { class: 'dg-sel', x: it.x, y: it.y, width: it.w, height: it.h, 'stroke-width': 1.5 / z }));
      } else {
        const pts = D.linePoints(it, idx);
        over.append(el('polyline', { class: 'dg-sel-line', points: pts.map((p) => p.x + ',' + p.y).join(' '), 'stroke-width': 6 / z }));
      }
    }
    if (sel.length === 1 && sel[0].type === 'shape') {
      const it = sel[0];
      const g = rotGroup(it, over);
      const pos = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
      for (const k in pos) {
        g.append(el('rect', {
          class: 'dg-handle', 'data-handle': k, x: it.x + it.w * pos[k][0] - hs / 2, y: it.y + it.h * pos[k][1] - hs / 2,
          width: hs, height: hs, 'stroke-width': 1.2 / z, style: D.rotOf(it) ? 'cursor:move' : 'cursor:' + k + '-resize',
        }));
      }
      // 回転のつまみ（上の辺の中央から少し離した丸）。ドラッグで回す（15° ごと。Alt で自由に）
      const rx = it.x + it.w / 2;
      const ry = it.y - 26 / z;
      g.append(el('line', { class: 'dg-rot-line', x1: rx, y1: it.y, x2: rx, y2: ry, 'stroke-width': 1.2 / z }));
      g.append(el('circle', { class: 'dg-handle is-rot', 'data-handle': 'rot', cx: rx, cy: ry, r: hs * 0.75, 'stroke-width': 1.2 / z }));
      // フキダシのしっぽの先（ひし形のつまみ）。ドラッグで向き・長さを変える
      if (it.shape === 'callout') {
        const t = D.tailPoint(it);
        const r = hs * 0.85;
        g.append(el('path', { class: 'dg-handle is-tail', 'data-handle': 'tail', d: 'M' + t.x + ' ' + (t.y - r) + 'L' + (t.x + r) + ' ' + t.y + 'L' + t.x + ' ' + (t.y + r) + 'L' + (t.x - r) + ' ' + t.y + 'Z', 'stroke-width': 1.2 / z }));
      }
    }
    if (sel.length === 1 && sel[0].type === 'line') {
      const pts = D.linePoints(sel[0], idx);
      [['from', pts[0]], ['to', pts[pts.length - 1]]].forEach(([k, p]) => {
        over.append(el('circle', { class: 'dg-handle is-end', 'data-handle': k, cx: p.x, cy: p.y, r: hs * 0.7, 'stroke-width': 1.2 / z }));
      });
    }
    // 線をつなぐ口（マウスを乗せている図形・線を引いている途中のつなぎ先）
    const target = ed.hover && find(ed.hover);
    if (target && target.type === 'shape' && (ed.tool === 'select' || ed.tool.indexOf('line') === 0 || (ed.drag && ed.drag.kind === 'end'))) {
      if (ed.drag && ed.drag.kind === 'end') rotGroup(target, over).append(el('rect', { class: 'dg-target', x: target.x, y: target.y, width: target.w, height: target.h, 'stroke-width': 2 / z }));
      else {
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const p = D.sidePoint(target, side);
          over.append(el('circle', { class: 'dg-port', 'data-port': side, 'data-of': target.id, cx: p.x, cy: p.y, r: 5.5 / z, 'stroke-width': 1.5 / z }));
        }
      }
    }
    if (ed.drag && ed.drag.kind === 'band') {
      const b = ed.drag.box;
      over.append(el('rect', { class: 'dg-band', x: b.x, y: b.y, width: b.w, height: b.h, 'stroke-width': 1 / z }));
    }
  }

  // ==================================================================
  // 追加
  // ==================================================================
  function addShape(kind, at) {
    const size = SIZES[kind] || [160, 80];
    const c = at || viewCenter();
    const d = ed.model.defaults.shape;
    const it = {
      id: uid(), type: 'shape', shape: kind,
      x: snap(c.x - size[0] / 2, true), y: snap(c.y - size[1] / 2, true), w: size[0], h: size[1],
      text: kind === 'text' ? 'テキスト' : '',
      style: kind === 'text' ? { textColor: d.textColor, fontSize: 20 } : { fill: d.fill, stroke: d.stroke, textColor: d.textColor },
    };
    // 置いた場所に既に図形があれば、少しずらす
    while (!at && ed.model.items.some((o) => o.type === 'shape' && o.x === it.x && o.y === it.y)) { it.x += 20; it.y += 20; }
    change((m) => m.items.push(it));
    ed.sel = new Set([it.id]);
    render();
  }

  // ---- 画像 ----
  const MAX_IMAGE = 1600; // 長い辺がこれより大きい画像は縮めて埋め込む（図形のファイルが重くなりすぎないように）
  const readDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('読み込めませんでした'));
    r.readAsDataURL(blob);
  });
  /** ファイル → 埋め込む data: URI と元の大きさ（大きな画像は縮める。SVG・GIF はそのまま） */
  async function imageData(file) {
    let url = await readDataUrl(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || 300;
    let hh = img.naturalHeight || 200;
    const big = Math.max(w, hh) > MAX_IMAGE || file.size > 1500000;
    if (big && !/svg|gif/.test(file.type)) {
      const k = Math.min(1, MAX_IMAGE / Math.max(w, hh));
      const c = document.createElement('canvas');
      c.width = Math.round(w * k);
      c.height = Math.round(hh * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const png = /png|webp/.test(file.type); // 透明があるかもしれない形式は PNG のまま
      url = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88);
      w = c.width;
      hh = c.height;
    }
    return { url, w, h: hh };
  }
  function pickImage(replace) {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', () => { if (input.files[0]) addImage(input.files[0], null, replace); });
    input.click();
  }
  /** 画像を図形として置く（replace: 差し替える図形） */
  async function addImage(file, at, replace) {
    if (!ed) return;
    let d;
    try { d = await imageData(file); } catch (e) { toast('画像を読み込めませんでした: ' + (e.message || e), true); return; }
    if (!ed) return;
    const ratio = d.w / d.h;
    if (replace) {
      change(() => {
        replace.src = d.url;
        replace.ratio = ratio;
        // 枠の面積はそのままで、新しい画像の縦横比に合わせる
        const area = replace.w * replace.h;
        replace.w = Math.round(Math.sqrt(area * ratio));
        replace.h = Math.round(Math.sqrt(area / ratio));
      });
      return;
    }
    // はじめは 320×240 に収まる大きさ（小さい画像は元の大きさ）
    const k = Math.min(1, 320 / d.w, 240 / d.h);
    const w = Math.max(20, Math.round(d.w * k));
    const hh = Math.max(20, Math.round(d.h * k));
    const c = at || viewCenter();
    const it = { id: uid(), type: 'shape', shape: 'image', src: d.url, ratio, x: snap(c.x - w / 2, true), y: snap(c.y - hh / 2, true), w, h: hh, text: '', style: { fit: 'contain', textColor: ed.model.defaults.shape.textColor } };
    while (!at && ed.model.items.some((o) => o.type === 'shape' && o.x === it.x && o.y === it.y)) { it.x += 20; it.y += 20; }
    change((m) => m.items.push(it));
    ed.sel = new Set([it.id]);
    render();
  }
  /** Ctrl+V: 画像がクリップボードにあれば画像を、無ければコピーした図形を貼り付ける */
  function onPaste(e) {
    if (!ed) return;
    const tag = (document.activeElement || {}).tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => /^image\//.test(f.type));
    if (files.length) { files.forEach((f) => addImage(f)); return; }
    if (clipboard) paste(clone(clipboard));
  }

  function newLine(route, from, to) {
    const d = ed.model.defaults.line;
    return { id: uid(), type: 'line', route, from, to, text: '', style: { stroke: d.stroke, textColor: d.textColor } };
  }

  // ==================================================================
  // マウス操作
  // ==================================================================
  /** その位置にある図形（線は除く。exceptId は除外） */
  function shapeAt(p, exceptId) {
    for (let i = ed.model.items.length - 1; i >= 0; i--) {
      const it = ed.model.items[i];
      if (it.type !== 'shape' || it.id === exceptId) continue;
      if (D.contains(it, p)) return it;
    }
    return null;
  }
  const itemIdOf = (target) => { const g = target.closest && target.closest('[data-id]'); return g ? g.dataset.id : null; };

  function onDown(e) {
    if (!ed) return;
    // ダブルクリックは自分で見分ける。1 回目の押下で図形を描き直す（render）ので、
    // ブラウザの dblclick は「押した要素が消えた」扱いになって届かない。
    const now = Date.now();
    const last = ed.lastDown;
    ed.lastDown = { t: now, x: e.clientX, y: e.clientY };
    if (e.button === 0 && last && now - last.t < 450 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6) {
      ed.lastDown = null;
      e.preventDefault(); // 入力欄に移したフォーカスを、この押下で奪われないように
      onDbl(e);
      return;
    }
    commitText();
    const p = toWorld(e);
    ed.els.svg.setPointerCapture(e.pointerId);
    // 中ボタン・スペース押しながら → 画面を動かす
    if (e.button === 1 || ed.space) {
      ed.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, pan: Object.assign({}, ed.pan) };
      return;
    }
    if (e.button !== 0) return;
    const handle = e.target.dataset && e.target.dataset.handle;
    const port = e.target.dataset && e.target.dataset.port;
    // 線を引く道具 / 図形の ● から → 新しい線
    if (port || ed.tool.indexOf('line-') === 0) {
      const route = ed.tool === 'line-elbow' ? 'elbow' : port ? 'elbow' : 'straight';
      const fromShape = port ? find(e.target.dataset.of) : shapeAt(p);
      const start = { x: snap(p.x, !e.altKey), y: snap(p.y, !e.altKey) };
      const line = newLine(route, fromShape ? { id: fromShape.id } : start, Object.assign({}, start));
      snapshot();
      ed.model.items.push(line);
      ed.sel = new Set([line.id]);
      ed.drag = { kind: 'end', id: line.id, end: 'to', created: true, moved: false };
      setTool('select');
      render();
      return;
    }
    if (handle) {
      const it = selected()[0];
      snapshot();
      if (handle === 'from' || handle === 'to') ed.drag = { kind: 'end', id: it.id, end: handle, moved: false };
      else if (handle === 'rot') ed.drag = { kind: 'rotate', id: it.id, center: D.center(it), moved: false };
      else if (handle === 'tail') ed.drag = { kind: 'tail', id: it.id, moved: false };
      else ed.drag = { kind: 'resize', id: it.id, handle, orig: { x: it.x, y: it.y, w: it.w, h: it.h, rot: D.rotOf(it) }, start: p, moved: false };
      return;
    }
    const id = itemIdOf(e.target);
    if (id) {
      if (e.shiftKey || e.ctrlKey) {
        if (ed.sel.has(id)) ed.sel.delete(id); else ed.sel.add(id);
      } else if (!ed.sel.has(id)) {
        ed.sel = new Set([id]);
      }
      // 選んでいるものをまとめて動かす（両端がつながっていない線も一緒に）
      const orig = {};
      for (const it of selected()) {
        if (it.type === 'shape') orig[it.id] = { x: it.x, y: it.y };
        else orig[it.id] = { from: clone(it.from), to: clone(it.to) };
      }
      const lead = find(id);
      ed.drag = { kind: 'move', start: p, orig, lead: lead.type === 'shape' ? { x: lead.x, y: lead.y } : null, moved: false, snapshot: JSON.stringify(ed.model) };
      render();
      return;
    }
    if (!e.shiftKey) ed.sel = new Set();
    ed.drag = { kind: 'band', start: p, box: { x: p.x, y: p.y, w: 0, h: 0 }, base: new Set(ed.sel) };
    render();
  }

  function onMove(e) {
    if (!ed) return;
    const p = toWorld(e);
    const d = ed.drag;
    if (!d) {
      // マウスの下の図形（つなぐ口を出す）
      const portOf = e.target.dataset && e.target.dataset.of;
      const s = portOf ? find(portOf) : shapeAt(p);
      const hv = s ? s.id : null;
      if (hv !== ed.hover) { ed.hover = hv; renderOverlay(); }
      return;
    }
    const on = !e.altKey;
    if (d.kind === 'pan') {
      ed.pan = { x: d.pan.x + e.clientX - d.sx, y: d.pan.y + e.clientY - d.sy };
      applyView();
      return;
    }
    if (d.kind === 'move') {
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * ed.zoom < 3) return;
      if (!d.moved) { ed.history.push(d.snapshot); ed.future = []; d.moved = true; }
      if (d.lead) { dx = snap(d.lead.x + dx, on) - d.lead.x; dy = snap(d.lead.y + dy, on) - d.lead.y; }
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      for (const id in d.orig) {
        const it = find(id);
        const o = d.orig[id];
        if (it.type === 'shape') { it.x = o.x + dx; it.y = o.y + dy; }
        else {
          if (!o.from.id) it.from = { x: o.from.x + dx, y: o.from.y + dy };
          if (!o.to.id) it.to = { x: o.to.x + dx, y: o.to.y + dy };
        }
      }
      ed.dirty = true;
      render();
      return;
    }
    if (d.kind === 'tail') {
      // 回す前の向きで、枠に対する割合として持つ
      const it = find(d.id);
      const q = D.toLocal(it, p);
      it.tail = [Math.round(((q.x - it.x) / it.w) * 1000) / 1000, Math.round(((q.y - it.y) / it.h) * 1000) / 1000];
      it.tail = D.tailOf(it);
      d.moved = true;
      ed.dirty = true;
      render();
      return;
    }
    if (d.kind === 'rotate') {
      // つまみは図形の上にあるので、真上 = 0°。15° ごとにそろえる（Alt で自由に）
      const it = find(d.id);
      let deg = (Math.atan2(p.y - d.center.y, p.x - d.center.x) * 180) / Math.PI + 90;
      deg = on ? Math.round(deg / 15) * 15 : Math.round(deg);
      deg = ((deg % 360) + 360) % 360;
      if (deg) it.rot = deg; else delete it.rot;
      d.moved = true;
      ed.dirty = true;
      render();
      return;
    }
    if (d.kind === 'resize') {
      const it = find(d.id);
      const o = d.orig;
      // 回した図形は、回す前の向き（図形の座標）で大きさを変え、反対側の辺・角が動かないように位置を戻す
      const oc = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
      const q = o.rot ? D.rotate(p, oc, -o.rot) : p;
      const sn = (v) => (o.rot ? Math.round(v) : snap(v, on));
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      const hd = d.handle;
      if (hd.includes('w')) x1 = sn(q.x);
      if (hd.includes('e')) x2 = sn(q.x);
      if (hd.includes('n')) y1 = sn(q.y);
      if (hd.includes('s')) y2 = sn(q.y);
      if (e.shiftKey && hd.length === 2) {
        // 縦横比を保つ
        const ratio = o.w / o.h;
        const w = Math.abs(x2 - x1);
        const hh = w / ratio;
        if (hd.includes('n')) y1 = y2 - hh; else y2 = y1 + hh;
      }
      const nw = Math.max(12, Math.abs(x2 - x1));
      const nh = Math.max(12, Math.abs(y2 - y1));
      const lc = { x: Math.min(x1, x2) + nw / 2, y: Math.min(y1, y2) + nh / 2 }; // 新しい中心（回す前の座標）
      const c = o.rot ? D.rotate(lc, oc, o.rot) : lc; // 図の座標での新しい中心
      it.x = c.x - nw / 2; it.y = c.y - nh / 2;
      it.w = nw; it.h = nh;
      d.moved = true;
      ed.dirty = true;
      render();
      return;
    }
    if (d.kind === 'end') {
      const it = find(d.id);
      const other = it[d.end === 'to' ? 'from' : 'to'];
      const target = shapeAt(p, null);
      const ok = target && !(other.id && other.id === target.id);
      it[d.end] = ok ? { id: target.id } : { x: snap(p.x, on), y: snap(p.y, on) };
      ed.hover = ok ? target.id : null;
      d.moved = true;
      ed.dirty = true;
      render();
      return;
    }
    if (d.kind === 'band') {
      const b = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
      d.box = b;
      const idx = index();
      const inside = (q) => q.x >= b.x && q.x <= b.x + b.w && q.y >= b.y && q.y <= b.y + b.h;
      ed.sel = new Set(d.base);
      for (const it of ed.model.items) {
        const pts = it.type === 'shape' ? D.corners(it) : D.linePoints(it, idx);
        if (pts.every(inside)) ed.sel.add(it.id);
      }
      renderOverlay();
    }
  }

  function onUp(e) {
    if (!ed || !ed.drag) return;
    const d = ed.drag;
    ed.drag = null;
    try { ed.els.svg.releasePointerCapture(e.pointerId); } catch (err) { /* 既に外れている */ }
    if (d.kind === 'end') {
      const it = find(d.id);
      const pts = D.linePoints(it, index());
      const tooShort = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 8;
      if (d.created && (!d.moved || tooShort)) {
        ed.model.items = ed.model.items.filter((x) => x.id !== it.id);
        ed.history.pop();
        ed.sel = new Set();
      } else if (!d.moved) ed.history.pop();
      ed.hover = null;
    }
    if ((d.kind === 'resize' || d.kind === 'rotate' || d.kind === 'tail') && !d.moved) ed.history.pop();
    render();
  }

  function onWheel(e) {
    e.preventDefault();
    const r = ed.els.svg.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    else { ed.pan.x -= e.shiftKey ? e.deltaY : e.deltaX; ed.pan.y -= e.shiftKey ? 0 : e.deltaY; applyView(); }
  }

  function onDbl(e) {
    const p = toWorld(e);
    const id = itemIdOf(e.target);
    if (id) { editText(find(id)); return; }
    // 何もないところ → テキストを置いて入力
    const d = ed.model.defaults.shape;
    const it = { id: uid(), type: 'shape', shape: 'text', x: snap(p.x - 90, true), y: snap(p.y - 22, true), w: 180, h: 44, text: '', style: { textColor: d.textColor, fontSize: 20 } };
    change((m) => m.items.push(it));
    ed.sel = new Set([it.id]);
    render();
    editText(it, '', true);
  }

  // ==================================================================
  // 文字の入力（図形の上に入力欄を重ねる）
  // ==================================================================
  function editText(it, initial, isNew) {
    if (!it) return;
    commitText();
    const idx = index();
    const r = ed.els.svg.getBoundingClientRect();
    const sr = ed.els.stage.getBoundingClientRect();
    let box;
    let style;
    if (it.type === 'shape') {
      box = D.textBox(it);
      style = Object.assign({}, D.DEFAULT_SHAPE_STYLE, it.style);
    } else {
      const m = D.midPoint(D.linePoints(it, idx));
      box = { x: m.x - 110, y: m.y - 20, w: 220, h: 40 };
      style = Object.assign({}, D.DEFAULT_LINE_STYLE, it.style, { align: 'center' });
    }
    const z = ed.zoom;
    // 入力欄の地の色: 図形の塗り（無ければ図の背景）。文字の色と見分けにくければ白か黒に寄せる
    const lum = (c) => { const v = hexToRgb(c); return v ? (0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2]) / 255 : null; };
    const textLum = lum(style.textColor);
    let bg = it.type === 'shape' && it.shape !== 'image' && hexToRgb(style.fill) ? style.fill : hexToRgb(ed.model.halo) ? ed.model.halo : null;
    if (!bg || (textLum != null && Math.abs(lum(bg) - textLum) < 0.4)) bg = textLum != null && textLum > 0.5 ? '#1b2030' : '#ffffff';
    const ta = h('textarea', { class: 'dg-text', spellcheck: false });
    ta.value = initial != null ? initial : it.text || '';
    Object.assign(ta.style, {
      left: r.left - sr.left + ed.pan.x + box.x * z + 'px',
      top: r.top - sr.top + ed.pan.y + box.y * z + 'px',
      width: Math.max(60, box.w * z) + 'px',
      height: Math.max(28, box.h * z) + 'px',
      fontSize: (Number(style.fontSize) || 16) * z + 'px',
      fontWeight: style.bold ? 700 : 400,
      fontFamily: ed.model.font || 'inherit',
      textAlign: style.align === 'left' ? 'left' : style.align === 'right' ? 'right' : 'center',
      color: style.textColor,
      background: bg,
    });
    // 回した図形では、入力欄も図形の中心を軸に同じだけ回す
    const rot = it.type === 'shape' ? D.rotOf(it) : 0;
    if (rot) {
      const c = D.center(it);
      ta.style.transformOrigin = (c.x - box.x) * z + 'px ' + (c.y - box.y) * z + 'px';
      ta.style.transform = 'rotate(' + rot + 'deg)';
    }
    ed.els.stage.append(ta);
    ed.editing = { id: it.id, ta, isNew, before: it.text || '' };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitText(); }
      if (e.key === 'Tab') { e.preventDefault(); commitText(); }
    });
    ta.addEventListener('blur', () => setTimeout(commitText, 0));
    ta.focus();
    if (initial == null) ta.select();
    else ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function commitText() {
    if (!ed || !ed.editing) return;
    const { id, ta, isNew, before } = ed.editing;
    ed.editing = null;
    ta.remove();
    const it = find(id);
    if (!it) return;
    const text = ta.value.replace(/\s+$/, '');
    if (it.shape === 'text' && !text) {
      // 空のテキストは消す
      if (isNew) { ed.model.items = ed.model.items.filter((x) => x.id !== id); ed.history.pop(); }
      else change((m) => { m.items = m.items.filter((x) => x.id !== id); });
      ed.sel.delete(id);
      render();
      return;
    }
    if (text === before) { render(); return; }
    if (isNew) { it.text = text; ed.dirty = true; render(); }
    else change(() => { it.text = text; });
  }
  function cancelText() {
    if (!ed.editing) return;
    const { ta, isNew, id } = ed.editing;
    ed.editing = null;
    ta.remove();
    if (isNew) { ed.model.items = ed.model.items.filter((x) => x.id !== id); ed.history.pop(); ed.sel.delete(id); }
    render();
  }

  // ==================================================================
  // キーボード
  // ==================================================================
  function onKey(e) {
    if (!ed) return;
    const tag = (document.activeElement || {}).tagName || '';
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === ' ' && !inField) { ed.space = e.type === 'keydown'; }
    if (mod && k === 's') { e.preventDefault(); e.stopPropagation(); save(false); return; }
    if (inField) { if (e.key === 'Escape') document.activeElement.blur(); e.stopPropagation(); return; }
    e.stopPropagation(); // エディタ本体のショートカット（Ctrl+Z など）を働かせない
    const sel = selected();
    if (mod && k === 'z') { e.preventDefault(); undo(e.shiftKey); return; }
    if (mod && k === 'y') { e.preventDefault(); undo(true); return; }
    if (mod && k === 'a') { e.preventDefault(); ed.sel = new Set(ed.model.items.map((it) => it.id)); render(); return; }
    if (mod && (k === 'c' || k === 'x')) {
      e.preventDefault();
      if (!sel.length) return;
      clipboard = clone(sel);
      // OS のクリップボードに前の画像が残っていると、Ctrl+V でそちらが貼られてしまうので空にしておく
      try { navigator.clipboard.writeText('').catch(() => {}); } catch (err) { /* 使えない環境 */ }
      if (k === 'x') removeSelected();
      return;
    }
    // Ctrl+V は paste イベント（onPaste）で受ける（クリップボードの画像を読むため、ここでは止めない）
    if (mod && k === 'v') return;
    if (mod && k === 'd') {
      e.preventDefault();
      if (sel.length) paste(clone(sel));
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); return; }
    if (e.key === 'Escape') { e.preventDefault(); if (ed.tool !== 'select') setTool('select'); else if (sel.length) { ed.sel = new Set(); render(); } return; }
    if (e.key.indexOf('Arrow') === 0 && sel.length) {
      e.preventDefault();
      const step = e.shiftKey ? GRID : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      change(() => {
        for (const it of sel) {
          if (it.type === 'shape') { it.x += dx; it.y += dy; }
          else {
            if (!it.from.id) it.from = { x: it.from.x + dx, y: it.from.y + dy };
            if (!it.to.id) it.to = { x: it.to.x + dx, y: it.to.y + dy };
          }
        }
      });
      return;
    }
    if ((e.key === 'Enter' || e.key === 'F2') && sel.length === 1) { e.preventDefault(); editText(sel[0]); return; }
    // 図形を選んだまま文字を打つと、そのまま入力が始まる
    if (sel.length === 1 && e.key.length === 1 && !mod && !e.altKey && e.key !== ' ') { e.preventDefault(); editText(sel[0], e.key); }
  }
  window.addEventListener('keyup', (e) => { if (ed && e.key === ' ') ed.space = false; }, true);

  function removeSelected() {
    const ids = ed.sel;
    if (!ids.size) return;
    change((m) => {
      // 消した図形につながっていた線も消す
      m.items = m.items.filter((it) => !ids.has(it.id) && !(it.type === 'line' && ((it.from.id && ids.has(it.from.id)) || (it.to.id && ids.has(it.to.id)))));
    });
    ed.sel = new Set();
    render();
  }

  function paste(items) {
    const map = {};
    for (const it of items) map[it.id] = uid();
    const out = items.map((it) => {
      const c = clone(it);
      c.id = map[it.id];
      if (c.type === 'shape') { c.x += 20; c.y += 20; }
      else {
        // 一緒に複製した図形につながっていた線は、複製した図形につなぎ直す。それ以外は位置だけ残す
        const re = (end) => (end.id ? (map[end.id] ? { id: map[end.id] } : null) : { x: end.x + 20, y: end.y + 20 });
        const idx = index();
        const pts = D.linePoints(it, idx);
        c.from = re(it.from) || { x: pts[0].x + 20, y: pts[0].y + 20 };
        c.to = re(it.to) || { x: pts[pts.length - 1].x + 20, y: pts[pts.length - 1].y + 20 };
      }
      return c;
    });
    change((m) => { m.items.push(...out); });
    ed.sel = new Set(out.map((it) => it.id));
    clipboard = clone(out);
    render();
  }

  // ==================================================================
  // 右のパネル（色・線・文字・並び）
  // ==================================================================
  function renderProps() {
    const p = ed.els.props;
    p.innerHTML = '';
    const sel = selected();
    const shapes = sel.filter((it) => it.type === 'shape');
    const lines = sel.filter((it) => it.type === 'line');
    const section = (title, ...children) => h('div', { class: 'dg-section' }, h('div', { class: 'dg-label' }, title), ...children);
    const row = (label, control) => h('div', { class: 'dg-row' }, h('span', null, label), control);
    /** 選んでいるもの（kind の種類だけ）の style.key を変える */
    const setStyle = (list, key, value) => change(() => {
      for (const it of list) it.style = Object.assign({}, it.style, { [key]: value });
      // 次に作る図形・線も同じ見た目にする
      const def = list[0] && list[0].type === 'line' ? ed.model.defaults.line : ed.model.defaults.shape;
      if (['fill', 'stroke', 'textColor'].includes(key) && !(list[0] && /^(text|image)$/.test(list[0].shape))) def[key] = value;
    });
    const styleOf = (it) => (it.type === 'line' ? Object.assign({}, D.DEFAULT_LINE_STYLE, it.style) : D.shapeStyle(it));
    const colorRow = (label, list, key, allowNone) => {
      const cur = styleOf(list[0])[key];
      const grid = h('div', { class: 'dg-swatches' });
      if (allowNone) grid.append(h('button', { type: 'button', class: 'dg-sw is-none' + (cur === 'none' ? ' is-active' : ''), title: 'なし', onclick: () => setStyle(list, key, 'none') }));
      for (const c of swatches()) grid.append(h('button', { type: 'button', class: 'dg-sw' + (String(cur).toLowerCase() === c.toLowerCase() ? ' is-active' : ''), title: c, style: 'background:' + c, onclick: () => setStyle(list, key, c) }));
      const pick = h('input', { type: 'color', value: hexToRgb(cur) ? cur : '#888888', title: 'ほかの色' });
      pick.addEventListener('change', () => setStyle(list, key, pick.value));
      grid.append(h('label', { class: 'dg-sw is-pick', title: 'ほかの色' }, pick));
      return h('div', { class: 'dg-row is-col' }, h('span', null, label), grid);
    };
    const seg = (options, value, onChange) => {
      const s = h('div', { class: 'seg' });
      for (const o of options) s.append(h('button', { type: 'button', class: String(o[0]) === String(value) ? 'is-active' : '', title: o[2] || '', onclick: () => onChange(o[0]) }, o[1]));
      return s;
    };
    const range = (min, max, step, value, onChange) => {
      const out = h('output', null, String(value));
      const input = h('input', { type: 'range', min, max, step, value });
      input.addEventListener('input', () => { out.textContent = input.value; });
      input.addEventListener('change', () => onChange(Number(input.value)));
      return h('div', { class: 'range' }, input, out);
    };

    if (!sel.length) {
      p.append(section('図形エディタ',
        h('p', { class: 'dg-hint' }, '左のパレットから図形を追加します。図形を選ぶと、ここで色や文字を変えられます。'),
        h('ul', { class: 'dg-keys' },
          h('li', null, 'ダブルクリック … 文字を入力'),
          h('li', null, '図形の ● をドラッグ … 線でつなぐ'),
          h('li', null, 'Shift + クリック / 囲む … 複数選択'),
          h('li', null, 'Ctrl + D … 複製 / Delete … 削除'),
          h('li', null, 'Alt を押しながら … 10px 単位にそろえない'),
          h('li', null, 'Ctrl + ホイール … 拡大縮小 / スペース + ドラッグ … 移動'))));
      return;
    }

    const images = shapes.filter((it) => it.shape === 'image');
    if (images.length) {
      const st = styleOf(images[0]);
      const one = images.length === 1 ? images[0] : null;
      p.append(section('画像' + (images.length > 1 ? '（' + images.length + ' 個）' : ''),
        row('収め方', seg([['contain', '全体を表示'], ['cover', '枠いっぱい', 'はみ出した部分は切り取る']], st.fit || 'contain', (v) => setStyle(images, 'fit', v))),
        colorRow('枠線', images, 'stroke', true),
        st.stroke && st.stroke !== 'none' ? row('線の太さ', range(0, 10, 0.5, st.strokeWidth, (v) => setStyle(images, 'strokeWidth', v))) : null,
        h('div', { class: 'dg-arrange' },
          one ? h('button', { type: 'button', class: 'btn small', onclick: () => pickImage(one) }, '画像を差し替える…') : null,
          h('button', { type: 'button', class: 'btn small', title: '枠の幅はそのままで、高さを画像の縦横比に合わせます', onclick: () => change(() => { for (const it of images) if (it.ratio) it.h = Math.max(12, Math.round(it.w / it.ratio)); }) }, '元の縦横比に戻す')),
        h('p', { class: 'dg-hint' }, 'ダブルクリックで、画像の上に文字を重ねられます。図形と同じように線でつなげます。')));
    }

    if (shapes.length) {
      const st = styleOf(shapes[0]);
      const plain = shapes.every((it) => it.shape !== 'image');
      const kinds = D.SHAPES.map((s) => [s[0], s[1]]);
      const kindSel = h('select');
      for (const [id, label] of kinds) kindSel.append(h('option', { value: id, selected: id === shapes[0].shape }, label));
      kindSel.addEventListener('change', () => change(() => { for (const it of shapes) it.shape = kindSel.value; }));
      const deco = plain && shapes[0].shape !== 'text';
      if (plain) {
        p.append(section('図形' + (shapes.length > 1 ? '（' + shapes.length + ' 個）' : ''),
          row('形', kindSel),
          deco ? colorRow('塗り', shapes, 'fill', true) : null,
          deco ? colorRow('枠線', shapes, 'stroke', true) : null,
          deco ? row('線の太さ', range(0, 10, 0.5, st.strokeWidth, (v) => setStyle(shapes, 'strokeWidth', v))) : null,
          deco ? row('線の種類', seg([['solid', '実線'], ['dashed', '破線'], ['dotted', '点線']], st.dash, (v) => setStyle(shapes, 'dash', v))) : null));
      }
      p.append(section('文字',
        colorRow('文字の色', shapes, 'textColor'),
        row('大きさ', range(8, 72, 1, st.fontSize, (v) => setStyle(shapes, 'fontSize', v))),
        row('太字', seg([[false, '標準'], [true, '太字']], !!st.bold, (v) => setStyle(shapes, 'bold', v))),
        row('横', seg([['left', '左'], ['center', '中央'], ['right', '右']], st.align, (v) => setStyle(shapes, 'align', v))),
        row('縦', seg([['top', '上'], ['middle', '中央'], ['bottom', '下']], st.valign, (v) => setStyle(shapes, 'valign', v)))));
      if (shapes.length === 1) {
        const it = shapes[0];
        const numIn = (key) => {
          const input = h('input', { type: 'number', value: Math.round(it[key]), step: 1 });
          input.addEventListener('change', () => change(() => { it[key] = Math.max(key === 'w' || key === 'h' ? 12 : -99999, Number(input.value) || 0); }));
          return h('label', { class: 'dg-num' }, h('span', null, { x: 'X', y: 'Y', w: '幅', h: '高さ' }[key]), input);
        };
        p.append(section('位置と大きさ', h('div', { class: 'dg-nums' }, numIn('x'), numIn('y'), numIn('w'), numIn('h'))));
      }
      // 回転（選んでいる図形それぞれを、自分の中心で回す）
      const setRot = (fn) => change(() => {
        for (const it of shapes) {
          const r = ((Math.round(fn(D.rotOf(it))) % 360) + 360) % 360;
          if (r) it.rot = r; else delete it.rot;
        }
      });
      const rotInput = h('input', { type: 'number', value: Math.round(D.rotOf(shapes[0])), step: 15, min: 0, max: 359 });
      rotInput.addEventListener('change', () => setRot(() => Number(rotInput.value) || 0));
      p.append(section('回転',
        h('div', { class: 'dg-nums' }, h('label', { class: 'dg-num' }, h('span', null, '角度'), rotInput)),
        h('div', { class: 'dg-arrange' },
          h('button', { type: 'button', class: 'btn small', title: '左へ 90° 回す', onclick: () => setRot((r) => r - 90) }, '↺ 90°'),
          h('button', { type: 'button', class: 'btn small', title: '右へ 90° 回す', onclick: () => setRot((r) => r + 90) }, '↻ 90°'),
          h('button', { type: 'button', class: 'btn small', title: '向きを反対にする', onclick: () => setRot((r) => r + 180) }, '180°'),
          h('button', { type: 'button', class: 'btn small', onclick: () => setRot(() => 0) }, '元に戻す')),
        h('p', { class: 'dg-hint' }, '図形の上の ○ をドラッグしても回せます（15° ごと。Alt を押しながらで自由に）。')));
      const polys = shapes.filter((it) => it.shape === 'polygon');
      if (polys.length) {
        const sidesIn = h('input', { type: 'number', value: D.sidesOf(polys[0]), step: 1, min: 3, max: 12 });
        const setSides = (n) => change(() => { for (const it of polys) it.sides = Math.max(3, Math.min(12, Math.round(n) || D.DEFAULT_SIDES)); });
        sidesIn.addEventListener('change', () => setSides(Number(sidesIn.value)));
        p.append(section('多角形',
          h('div', { class: 'dg-nums' }, h('label', { class: 'dg-num' }, h('span', null, '角の数'), sidesIn)),
          h('div', { class: 'dg-arrange' }, ...[3, 4, 5, 6, 8].map((n) => h('button', { type: 'button', class: 'btn small', onclick: () => setSides(n) }, n + ' 角')))));
      }
      const callouts = shapes.filter((it) => it.shape === 'callout');
      if (callouts.length) {
        const setTail = (t) => change(() => { for (const it of callouts) it.tail = t.slice(); });
        p.append(section('フキダシのしっぽ',
          h('div', { class: 'dg-arrange' },
            h('button', { type: 'button', class: 'btn small', onclick: () => setTail([0.22, 1.45]) }, '左下'),
            h('button', { type: 'button', class: 'btn small', onclick: () => setTail([0.78, 1.45]) }, '右下'),
            h('button', { type: 'button', class: 'btn small', onclick: () => setTail([0.22, -0.45]) }, '左上'),
            h('button', { type: 'button', class: 'btn small', onclick: () => setTail([0.78, -0.45]) }, '右上'),
            h('button', { type: 'button', class: 'btn small', onclick: () => setTail([-0.3, 0.7]) }, '左'),
            h('button', { type: 'button', class: 'btn small', onclick: () => setTail([1.3, 0.7]) }, '右')),
          h('p', { class: 'dg-hint' }, 'しっぽの先の ◆ をドラッグすると、向きと長さを自由に変えられます。')));
      }
    }

    if (lines.length) {
      const st = styleOf(lines[0]);
      p.append(section('線' + (lines.length > 1 ? '（' + lines.length + ' 本）' : ''),
        colorRow('色', lines, 'stroke'),
        row('太さ', range(0.5, 10, 0.5, st.strokeWidth, (v) => setStyle(lines, 'strokeWidth', v))),
        row('種類', seg([['solid', '実線'], ['dashed', '破線'], ['dotted', '点線']], st.dash, (v) => setStyle(lines, 'dash', v))),
        row('経路', seg([['straight', '直線'], ['elbow', 'カギ線']], lines[0].route || 'straight', (v) => change(() => { for (const it of lines) it.route = v; }))),
        row('始点', seg([['none', 'なし'], ['arrow', '矢印'], ['dot', '点']], st.start, (v) => setStyle(lines, 'start', v))),
        row('終点', seg([['none', 'なし'], ['arrow', '矢印'], ['dot', '点']], st.end, (v) => setStyle(lines, 'end', v))),
        row('向き', h('button', { type: 'button', class: 'btn small', onclick: () => change(() => { for (const it of lines) { const f = it.from; it.from = it.to; it.to = f; } }) }, '逆にする')),
        colorRow('文字の色', lines, 'textColor'),
        row('文字の大きさ', range(8, 48, 1, st.fontSize, (v) => setStyle(lines, 'fontSize', v))),
        h('p', { class: 'dg-hint' }, '線をダブルクリックすると、線に文字（ラベル）を付けられます。')));
    }

    // 並び（重なり順・整列）
    const order = (front) => change((m) => {
      const ids = ed.sel;
      const picked = m.items.filter((it) => ids.has(it.id));
      const rest = m.items.filter((it) => !ids.has(it.id));
      m.items = front ? rest.concat(picked) : picked.concat(rest);
    });
    const arrange = [
      h('button', { type: 'button', class: 'btn small', onclick: () => order(true) }, '最前面へ'),
      h('button', { type: 'button', class: 'btn small', onclick: () => order(false) }, '最背面へ'),
    ];
    const box = h('div', { class: 'dg-arrange' }, ...arrange);
    if (shapes.length > 1) {
      const align = (kind) => change(() => {
        const b = { x1: Math.min(...shapes.map((s) => s.x)), y1: Math.min(...shapes.map((s) => s.y)), x2: Math.max(...shapes.map((s) => s.x + s.w)), y2: Math.max(...shapes.map((s) => s.y + s.h)) };
        for (const s of shapes) {
          if (kind === 'left') s.x = b.x1;
          if (kind === 'center') s.x = Math.round((b.x1 + b.x2) / 2 - s.w / 2);
          if (kind === 'right') s.x = b.x2 - s.w;
          if (kind === 'top') s.y = b.y1;
          if (kind === 'middle') s.y = Math.round((b.y1 + b.y2) / 2 - s.h / 2);
          if (kind === 'bottom') s.y = b.y2 - s.h;
        }
        if (kind === 'hdist' || kind === 'vdist') {
          const horiz = kind === 'hdist';
          const list = shapes.slice().sort((a, c) => (horiz ? a.x - c.x : a.y - c.y));
          const total = list.reduce((n, s) => n + (horiz ? s.w : s.h), 0);
          const span = horiz ? b.x2 - b.x1 : b.y2 - b.y1;
          const gap = (span - total) / (list.length - 1);
          let pos = horiz ? b.x1 : b.y1;
          for (const s of list) { if (horiz) s.x = Math.round(pos); else s.y = Math.round(pos); pos += (horiz ? s.w : s.h) + gap; }
        }
        if (kind === 'size') { const w = shapes[0].w; const hh = shapes[0].h; for (const s of shapes) { s.w = w; s.h = hh; } }
      });
      const b = (k, label) => h('button', { type: 'button', class: 'btn small', onclick: () => align(k) }, label);
      box.append(b('left', '左そろえ'), b('center', '左右中央'), b('right', '右そろえ'), b('top', '上そろえ'), b('middle', '上下中央'), b('bottom', '下そろえ'),
        b('hdist', '横に等間隔'), b('vdist', '縦に等間隔'), b('size', '大きさをそろえる'));
    }
    p.append(section('並び', box), h('div', { class: 'dg-arrange' }, h('button', { type: 'button', class: 'btn small danger', onclick: removeSelected }, '削除')));
  }

  app.diagram = {
    open,
    isDiagram: D.isDiagramPath,
    /** 動作確認用 */
    get state() { return ed; },
  };
})();
