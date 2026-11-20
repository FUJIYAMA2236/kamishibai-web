/*
 * editor-grid.js — 升目（手動配置）レイアウトの、プレビュー上での配置の操作。
 *
 *   ・部品（画像・図・Mermaid・文章のまとまり）にマウスを乗せると、左上に「移動」、右下に「広げる」のつまみが出る
 *   ・「移動」をドラッグ → 落としたマスへ置く（大きさ＝何マス分かはそのまま）
 *   ・「広げる」をドラッグ → 何マス分を使うかを変える
 *   ・ドラッグ中は升目の線と、置く先の範囲を出す
 *   ・置いた範囲に重なる別の部品は、置き場所を外して空いているマスへ回す（重ならないように）
 *
 * 置き場所は deck.json の slides.<ID>.grid.place に { 部品の key: [列, 行, 横のマス数, 縦のマス数] }（1 始まり）で入る。
 * 原稿（slides.md）は書き換えない。書き換えは editor.js の app.setSlideValue を通す。
 */
(function () {
  'use strict';
  const app = window.KSE;
  const { h, state } = app;
  const $ = app.$;

  const host = $('#stageHost');
  const layer = h('div', { class: 'gd-layer' });
  const lines = h('div', { class: 'gd-lines', hidden: true });
  const target = h('div', { class: 'gd-target', hidden: true });
  const frame = h('div', { class: 'gd-frame', hidden: true });
  const grip = h('button', { type: 'button', class: 'gd-grip', title: 'ドラッグして別のマスへ移動', hidden: true, html: '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>' });
  const sizer = h('button', { type: 'button', class: 'gd-sizer', title: 'ドラッグして何マス分を使うかを変える', hidden: true, html: '<svg viewBox="0 0 24 24"><path d="M20 10v10H10M20 20L9 9"/></svg>' });
  layer.append(lines, target, frame, grip, sizer);
  host.append(layer);

  let hover = null; // マウスを乗せている部品（.ks-cell）
  let drag = null; // { mode: 'move' | 'size', key, start: [列, 行, 横, 縦], grab: [列, 行], area }

  const slideEl = () => $('#mainStage') && $('#mainStage').querySelector('.ks-slide.ks-layout-grid');
  const info = () => { const o = app.currentOut && app.currentOut(); return o && o.grid ? o.grid : null; };
  const hostRect = () => host.getBoundingClientRect();

  /** 升目の線の位置（画面の座標）。xs / ys は各マスの [始まり, 終わり] */
  function geometry() {
    const slide = slideEl();
    const g = info();
    if (!slide || !g) return null;
    const body = slide.querySelector('.ks-body');
    if (!body || !body.offsetWidth) return null;
    const r = body.getBoundingClientRect();
    const k = r.width / body.offsetWidth; // プレビューの縮小率
    const cs = getComputedStyle(body);
    const gx = (parseFloat(cs.columnGap) || 0) * k;
    const gy = (parseFloat(cs.rowGap) || 0) * k;
    const tracks = (v, n, start, gap) => {
      const sizes = String(v).split(' ').map(parseFloat).filter((x) => !isNaN(x)).slice(0, n);
      const out = [];
      let p = start;
      for (const s of sizes) { out.push([p, p + s * k]); p += s * k + gap; }
      return out;
    };
    const xs = tracks(cs.gridTemplateColumns, g.cols, r.left, gx);
    const ys = tracks(cs.gridTemplateRows, g.rows, r.top, gy);
    if (xs.length !== g.cols || ys.length !== g.rows) return null;
    return { xs, ys, g };
  }
  /** 画面の座標 → いちばん近いマス（1 始まり） */
  function cellAt(geo, x, y) {
    const near = (list, v) => {
      let best = 0;
      let d = Infinity;
      list.forEach(([a, b], i) => { const dd = v < a ? a - v : v > b ? v - b : 0; if (dd < d) { d = dd; best = i; } });
      return best + 1;
    };
    return [near(geo.xs, x), near(geo.ys, y)];
  }
  /** 部品がいま占めている範囲（置き場所が無い部品は、実際に描かれた位置から求める） */
  function areaOf(geo, cell) {
    const key = cell.dataset.part;
    const g = geo.g;
    const p = g.parts.find((x) => x.key === key);
    if (p && p.at) return p.at.slice();
    const r = cell.getBoundingClientRect();
    const a = cellAt(geo, r.left + 2, r.top + 2);
    const b = cellAt(geo, r.right - 2, r.bottom - 2);
    return [a[0], a[1], Math.max(1, b[0] - a[0] + 1), Math.max(1, b[1] - a[1] + 1)];
  }
  const rectOf = (geo, a) => {
    const hr = hostRect();
    const x1 = geo.xs[a[0] - 1][0];
    const y1 = geo.ys[a[1] - 1][0];
    const x2 = geo.xs[Math.min(geo.xs.length, a[0] + a[2] - 1) - 1][1];
    const y2 = geo.ys[Math.min(geo.ys.length, a[1] + a[3] - 1) - 1][1];
    return { left: x1 - hr.left, top: y1 - hr.top, width: x2 - x1, height: y2 - y1 };
  };
  const place = (el, r) => Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });

  function drawLines(geo) {
    lines.replaceChildren();
    const hr = hostRect();
    for (const [x1, x2] of geo.xs) for (const [y1, y2] of geo.ys) {
      const d = h('div', { class: 'gd-cell' });
      place(d, { left: x1 - hr.left, top: y1 - hr.top, width: x2 - x1, height: y2 - y1 });
      lines.append(d);
    }
    lines.hidden = false;
  }

  function hideAll() {
    for (const el of [lines, target, frame, grip, sizer]) el.hidden = true;
  }

  /** マウスを乗せている部品に、枠とつまみを出す */
  function redraw() {
    if (drag) return;
    const geo = geometry();
    if (!geo || !hover || !hover.isConnected) { hideAll(); hover = null; return; }
    const hr = hostRect();
    const r = hover.getBoundingClientRect();
    place(frame, { left: r.left - hr.left, top: r.top - hr.top, width: r.width, height: r.height });
    frame.hidden = false;
    Object.assign(grip.style, { left: r.left - hr.left + 6 + 'px', top: r.top - hr.top + 6 + 'px' });
    Object.assign(sizer.style, { left: r.right - hr.left - 30 + 'px', top: r.bottom - hr.top - 30 + 'px' });
    grip.hidden = false;
    sizer.hidden = false;
  }

  host.addEventListener('pointermove', (e) => {
    if (drag) return;
    if (!info()) { if (hover) { hover = null; hideAll(); } return; }
    if (e.target === grip || e.target === sizer || grip.contains(e.target) || sizer.contains(e.target)) return;
    // 要素ではなく位置で探す（マスのすき間や、部品の上に重なった枠の上でも、いちばん近い部品を拾う）
    const slide = slideEl();
    const cell = slide && [...slide.querySelectorAll('.ks-cell')].find((el) => {
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
    });
    if (cell) { if (cell !== hover) { hover = cell; redraw(); } }
    else if (hover) { hover = null; hideAll(); }
  });
  host.addEventListener('pointerleave', () => { if (!drag) { hover = null; hideAll(); } });

  function startDrag(mode, e) {
    const geo = geometry();
    if (!geo || !hover) return;
    e.preventDefault();
    e.stopPropagation();
    const start = areaOf(geo, hover);
    drag = { mode, key: hover.dataset.part, start, grab: cellAt(geo, e.clientX, e.clientY), area: start.slice(), geo };
    (mode === 'move' ? grip : sizer).setPointerCapture(e.pointerId);
    drawLines(geo);
    frame.hidden = true;
    place(target, rectOf(geo, drag.area));
    target.hidden = false;
    document.body.classList.add('is-grid-dragging');
  }
  function moveDrag(e) {
    if (!drag) return;
    const { geo, start } = drag;
    const g = geo.g;
    const [c, r] = cellAt(geo, e.clientX, e.clientY);
    if (drag.mode === 'move') {
      // つかんだマスからのずれだけ動かす（はみ出さないように）
      const nc = Math.min(Math.max(1, start[0] + c - drag.grab[0]), g.cols - start[2] + 1);
      const nr = Math.min(Math.max(1, start[1] + r - drag.grab[1]), g.rows - start[3] + 1);
      drag.area = [nc, nr, start[2], start[3]];
    } else {
      drag.area = [start[0], start[1], Math.max(1, c - start[0] + 1), Math.max(1, r - start[1] + 1)];
    }
    place(target, rectOf(geo, drag.area));
  }
  function endDrag() {
    if (!drag) return;
    const { key, area, start } = drag;
    const g = drag.geo.g;
    drag = null;
    document.body.classList.remove('is-grid-dragging');
    hideAll();
    if (area.join() === start.join() && (g.parts.find((p) => p.key === key) || {}).at) { redraw(); return; }
    // 新しい範囲に重なる、ほかの部品の置き場所は外す（空いているマスへ回る）
    const overlap = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    const next = {};
    for (const p of g.parts) if (p.at && p.key !== key && !overlap(p.at, area)) next[p.key] = p.at;
    next[key] = area;
    app.setSlideValue(['grid', 'place'], next);
    app.refresh();
    app.renderPanel();
  }

  grip.addEventListener('pointerdown', (e) => startDrag('move', e));
  sizer.addEventListener('pointerdown', (e) => startDrag('size', e));
  for (const el of [grip, sizer]) {
    el.addEventListener('pointermove', moveDrag);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', () => { drag = null; document.body.classList.remove('is-grid-dragging'); hideAll(); });
  }

  app.on('main', () => requestAnimationFrame(redraw));
  app.on('fit', () => requestAnimationFrame(redraw));
  app.on('current', () => { hover = null; hideAll(); });
  app.on('open', () => { hover = null; hideAll(); });
})();
