/*
 * editor-canvas.js — プレビュー上で画像を直接操作する。
 *
 *   ・画像にマウスを乗せると枠が出て、クリックで選択
 *   ・本文の画像（図）     … 角をドラッグで大きさ（{width=NN%} を slides.md に書く）
 *   ・横に並べた画像       … 境目をドラッグで幅（deck.json の mediaSize）、画像をドラッグで見せる位置（focus）
 *   ・全面に敷いた画像     … ドラッグで見せる位置
 *   ・選択中に出るツールバーで、左右入れ替え・全面・影・削除など
 *   ・プレビューやサムネイルに画像ファイルをドロップすると、そのスライドに追加
 *   ・「このスライド」タブに、スライド内の画像の一覧（幅スライダー等）を出す
 *
 * 書き換えはすべて editor.js の app.editImage / app.setSlideValue を通す（元に戻す・保存が効く）。
 */
(function () {
  'use strict';
  const app = window.KSE;
  const { h, svg, clamp, state } = app;
  const $ = app.$;

  const host = $('#stageHost');
  const layer = h('div', { class: 'cv-layer' });
  const hoverBox = h('div', { class: 'cv-hover', hidden: true });
  const selBox = h('div', { class: 'cv-sel', hidden: true });
  const toolbar = h('div', { class: 'cv-toolbar', hidden: true });
  const badge = h('div', { class: 'cv-badge', hidden: true });
  layer.append(hoverBox, selBox, toolbar, badge);
  host.append(layer);

  let sel = null; // { index, src }
  let dragging = false;

  const ICONS = {
    swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
    full: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 15l3-3 2 2 3-3"/>',
    side: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M13 5v14"/>',
    inline: '<path d="M5 7h14M5 11h9M5 15h14M5 19h9"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    center: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
    shadow: '<rect x="4" y="4" width="13" height="13" rx="2"/><path d="M20 8v10a2 2 0 0 1-2 2H8"/>',
    round: '<circle cx="12" cy="12" r="8"/>',
    square: '<rect x="4.5" y="4.5" width="15" height="15"/>',
    reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4.5v4h4"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
    crop: '<path d="M7 3v14h14M3 7h14v14"/>',
    diagram: '<rect x="3.5" y="4" width="7" height="5" rx="1.5"/><path d="M14 15l3.5-3.5 3 3L17 18h-3z"/><path d="M7 9v6h4"/>',
  };

  const stage = () => $('#mainStage');
  const slideEl = () => stage().querySelector('.ks-slide');
  const hostRect = () => host.getBoundingClientRect();

  /** 画像の種類: media（横に並べた画像）/ full（全面）/ figure（本文の中の画像） */
  function kindOf(img) {
    if (img.closest('.ks-media')) return 'media';
    if (img.closest('.ks-bg')) return 'full';
    return 'figure';
  }
  /** 枠を描く対象（横の画像は画像の箱、全面はスライド全体） */
  function frameOf(img) {
    const k = kindOf(img);
    if (k === 'media') return img.closest('.ks-media');
    if (k === 'full') return slideEl();
    return img;
  }
  function place(box, el) {
    const r = el.getBoundingClientRect();
    const hr = hostRect();
    box.style.left = r.left - hr.left + 'px';
    box.style.top = r.top - hr.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    return { left: r.left - hr.left, top: r.top - hr.top, width: r.width, height: r.height };
  }

  /** ポインタの下にある操作できる画像（全面画像は、文字の上でなければ拾う） */
  function imageAt(e) {
    const t = e.target;
    if (!(t instanceof Element) || !stage().contains(t)) return null;
    const img = t.closest('img[data-img]');
    if (img) return img;
    const slide = slideEl();
    if (slide && slide.dataset.layout === 'image-full' && !t.closest('.ks-head > *, .ks-body > *, .ks-chrome')) {
      return slide.querySelector('.ks-bg img[data-img]');
    }
    return null;
  }
  const selectedImg = () => (sel ? stage().querySelector('img[data-img="' + sel.index + '"]') : null);

  // ------------------------------------------------------------------
  // 選択と表示
  // ------------------------------------------------------------------
  function select(img) {
    sel = img ? { index: Number(img.dataset.img), src: img.dataset.src } : null;
    redraw();
  }

  function redraw() {
    if (dragging) return;
    const img = selectedImg();
    if (!img) {
      selBox.hidden = true;
      toolbar.hidden = true;
      if (sel && !stage().querySelector('img[data-img]')) sel = null;
      return;
    }
    const kind = kindOf(img);
    selBox.hidden = false;
    selBox.dataset.kind = kind;
    const box = place(selBox, frameOf(img));
    selBox.innerHTML = '';
    if (kind === 'figure') {
      for (const corner of ['nw', 'ne', 'sw', 'se']) selBox.append(handle('cv-corner ' + corner, (e) => resizeFigure(e, img, corner)));
    }
    if (kind === 'media') {
      const right = slideEl().dataset.layout === 'image-right';
      selBox.append(handle('cv-edge ' + (right ? 'left' : 'right'), (e) => resizeMedia(e, img)));
    }
    if ((kind === 'media' || kind === 'full') && slideEl().dataset.fit !== 'contain') {
      const pan = handle('cv-pan', (e) => panImage(e, img));
      pan.title = 'ドラッグで見せる位置を調整';
      selBox.prepend(pan);
    }
    buildToolbar(img, kind);
    toolbar.hidden = false;
    const hr = hostRect();
    const tw = toolbar.offsetWidth;
    const top = box.top > 46 ? box.top - 42 : Math.min(box.top + box.height + 8, hr.height - 40);
    toolbar.style.left = clamp(box.left + box.width / 2 - tw / 2, 4, hr.width - tw - 4) + 'px';
    toolbar.style.top = Math.max(4, top) + 'px';
  }

  function handle(cls, onDown) {
    return h('div', {
      class: cls,
      onpointerdown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onDown(e);
      },
    });
  }

  function showBadge(text, x, y) {
    badge.hidden = false;
    badge.textContent = text;
    const hr = hostRect();
    badge.style.left = clamp(x - hr.left + 14, 0, hr.width - 90) + 'px';
    badge.style.top = clamp(y - hr.top + 14, 0, hr.height - 30) + 'px';
  }

  /** ドラッグ共通: move(e) を呼び続け、離したら up(e) */
  function drag(e, move, up) {
    dragging = true;
    hoverBox.hidden = true;
    toolbar.hidden = true;
    document.body.classList.add('is-dragging-canvas');
    const onMove = (ev) => move(ev);
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-dragging-canvas');
      dragging = false;
      badge.hidden = true;
      up(ev);
      redraw();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ---- 本文の画像の大きさ ----
  function resizeFigure(e, img, corner) {
    const parent = img.parentElement;
    const centered = parent.classList.contains('ks-figure') && !parent.classList.contains('ks-figure-row');
    const ref = (parent.classList.contains('ks-figure') ? parent : img.closest('p, li, td, .ks-col, .ks-body') || parent).getBoundingClientRect();
    const start = img.getBoundingClientRect();
    const cx = (start.left + start.right) / 2;
    let pct = Math.round((start.width / ref.width) * 100);
    drag(e, (ev) => {
      const w = centered ? 2 * Math.abs(ev.clientX - cx) : /e$/.test(corner) ? ev.clientX - start.left : start.right - ev.clientX;
      pct = clamp(Math.round((w / ref.width) * 100), 5, 100);
      img.style.width = pct + '%';
      img.style.height = 'auto';
      if (parent.classList.contains('ks-figure')) parent.classList.add('ks-sized');
      place(selBox, img);
      showBadge('幅 ' + pct + '%', ev.clientX, ev.clientY);
    }, () => {
      app.editImage(app.slideRange(), sel.index, sel.src, (a) => { a.width = pct + '%'; a.height = undefined; return a; });
    });
  }

  // ---- 横に並べた画像の幅 ----
  function resizeMedia(e, img) {
    const slide = slideEl();
    const inner = slide.querySelector('.ks-inner');
    const r = inner.getBoundingClientRect();
    const scale = r.width / inner.offsetWidth;
    const cs = getComputedStyle(inner);
    const padL = parseFloat(cs.paddingLeft) * scale;
    const padR = parseFloat(cs.paddingRight) * scale;
    const contentW = r.width - padL - padR;
    const right = slide.dataset.layout === 'image-right';
    const cover = slide.dataset.fit !== 'contain'; // cover のときは画像がスライドの端まで伸びている
    let pct = 46;
    drag(e, (ev) => {
      const basis = right ? (cover ? r.right : r.right - padR) - ev.clientX : ev.clientX - (cover ? r.left : r.left + padL);
      pct = clamp(Math.round((basis / contentW) * 100), 20, 75);
      slide.style.setProperty('--ks-media-size', pct + '%');
      place(selBox, img.closest('.ks-media'));
      showBadge('画像の幅 ' + pct + '%', ev.clientX, ev.clientY);
    }, () => app.setSlideValue(['mediaSize'], pct));
  }

  // ---- 見せる位置（object-position） ----
  function panImage(e, img) {
    const box = img.getBoundingClientRect();
    const pos = getComputedStyle(img).objectPosition.split(' ').map((v) => (/%$/.test(v) ? parseFloat(v) : 50));
    let [x, y] = [pos[0], pos.length > 1 ? pos[1] : 50];
    const nw = img.naturalWidth || box.width;
    const nh = img.naturalHeight || box.height;
    const s = Math.max(box.width / nw, box.height / nh);
    const overX = Math.max(1, nw * s - box.width);
    const overY = Math.max(1, nh * s - box.height);
    const sx = e.clientX;
    const sy = e.clientY;
    const x0 = x;
    const y0 = y;
    drag(e, (ev) => {
      x = clamp(x0 - ((ev.clientX - sx) / overX) * 100, 0, 100);
      y = clamp(y0 - ((ev.clientY - sy) / overY) * 100, 0, 100);
      img.style.objectPosition = x.toFixed(1) + '% ' + y.toFixed(1) + '%';
      showBadge('位置 ' + Math.round(x) + '% / ' + Math.round(y) + '%', ev.clientX, ev.clientY);
    }, () => {
      if (Math.abs(x - x0) + Math.abs(y - y0) < 0.5) return;
      app.setSlideValue(['focus'], Math.round(x * 10) / 10 + '% ' + Math.round(y * 10) / 10 + '%');
    });
  }

  // ---- ツールバー ----
  function tool(icon, label, onClick, active) {
    return h('button', {
      type: 'button', class: 'cv-tool' + (active ? ' is-active' : ''), title: label,
      html: svg(ICONS[icon]) + '<span>' + label + '</span>',
      onclick: (e) => { e.stopPropagation(); onClick(); },
    });
  }
  function setClass(cls, on, others) {
    app.editImage(app.slideRange(), sel.index, sel.src, (a) => {
      a.classes = a.classes.filter((c) => c !== cls && !(others || []).includes(c));
      if (on) a.classes.push(cls);
      return a;
    });
  }
  function removeImage() {
    const ok = app.editImage(app.slideRange(), sel.index, sel.src, () => null);
    if (ok) { sel = null; app.toast('画像を取り除きました（Ctrl+Z で元に戻せます）'); }
  }

  function buildToolbar(img, kind) {
    toolbar.innerHTML = '';
    const slide = slideEl();
    const sd = app.slideDesign();
    const layout = slide.dataset.layout;
    const setLayout = (l) => { app.setSlideValue(['layout'], l); app.renderPanel(); };
    const fit = slide.dataset.fit === 'contain';
    const classes = img.className.split(/\s+/);
    if (kind === 'media' || kind === 'full') {
      if (kind === 'media') toolbar.append(tool('swap', '左右入れ替え', () => setLayout(layout === 'image-right' ? 'image-left' : 'image-right')));
      else toolbar.append(tool('side', '横に並べる', () => setLayout('image-right')));
      if (kind === 'media') toolbar.append(tool('full', '全面に敷く', () => setLayout('image-full')));
      toolbar.append(
        tool('inline', '本文に戻す', () => setLayout('content')),
        tool('fit', fit ? '全面に敷く' : '全体を見せる', () => { app.setSlideValue(['fit'], fit ? undefined : 'contain'); app.renderPanel(); }, fit)
      );
      if (sd.focus) toolbar.append(tool('center', '位置を中央に', () => app.setSlideValue(['focus'], undefined)));
    } else {
      const figures = slideEl().querySelectorAll('.ks-figure:not(.ks-figure-row) > img[data-img]');
      const onlyFigure = figures.length === 1 && figures[0] === img;
      toolbar.append(
        tool('shadow', '影', () => setClass('shadow', !classes.includes('shadow')), classes.includes('shadow')),
        tool('round', '丸く', () => setClass('round', !classes.includes('round'), ['plain']), classes.includes('round')),
        tool('square', '角を立てる', () => setClass('plain', !classes.includes('plain'), ['round']), classes.includes('plain'))
      );
      if (img.style.width || /width/.test(img.getAttribute('style') || '')) {
        toolbar.append(tool('reset', '大きさを戻す', () => app.editImage(app.slideRange(), sel.index, sel.src, (a) => { a.width = undefined; a.height = undefined; return a; })));
      }
      if (onlyFigure) {
        toolbar.append(
          tool('side', '横に並べる', () => setLayout('image-right')),
          tool('full', '全面に敷く', () => setLayout('image-full'))
        );
      }
    }
    if (app.diagram && app.diagram.isDiagram(sel.src)) toolbar.prepend(tool('diagram', '図形を編集', () => app.diagram.open({ path: app.safeDecode(sel.src) })));
    toolbar.append(tool('crop', 'トリミング', cropSelected, !!img.dataset.crop));
    toolbar.append(tool('trash', '削除', removeImage));
  }
  // トリミング: ダイアログで範囲を選び、slides.md の {crop=上,右,下,左} に書く（元の画像はそのまま）
  async function cropSelected() {
    if (!sel || !app.cropImage) return;
    const target = sel;
    const im = app.slideImages()[target.index];
    if (!im) return;
    const v = await app.cropImage({ src: app.assetUrl(im.src), crop: im.attrs.crop });
    if (!v) return;
    app.editImage(app.slideRange(), target.index, target.src, (a) => { a.crop = app.cropActive(v) ? v : null; return a; });
  }
  // 図形（.diagram.svg）はダブルクリックで図形エディタを開く
  host.addEventListener('dblclick', () => {
    if (sel && app.diagram && app.diagram.isDiagram(sel.src)) app.diagram.open({ path: app.safeDecode(sel.src) });
  });

  // ------------------------------------------------------------------
  // マウス操作
  // ------------------------------------------------------------------
  host.addEventListener('pointermove', (e) => {
    if (dragging) return;
    const img = imageAt(e);
    host.classList.toggle('is-over-image', !!img);
    if (!img || (sel && Number(img.dataset.img) === sel.index)) { hoverBox.hidden = true; return; }
    hoverBox.hidden = false;
    place(hoverBox, frameOf(img));
  });
  host.addEventListener('pointerleave', () => { hoverBox.hidden = true; });
  host.addEventListener('click', (e) => {
    if (layer.contains(e.target) && e.target !== layer) return;
    select(imageAt(e));
  });
  document.addEventListener('keydown', (e) => {
    if (!sel || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) return;
    if (e.key === 'Escape') select(null);
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeImage(); }
  });

  app.on('main', () => requestAnimationFrame(redraw));
  app.on('fit', () => requestAnimationFrame(redraw));
  app.on('current', () => { sel = null; redraw(); });
  app.on('open', () => { sel = null; redraw(); });

  // プレビューにドロップ → 表示中のスライドに追加
  app.makeDropTarget(host, () => ({ slide: state.current }), 'このスライドに画像を追加');

  // ------------------------------------------------------------------
  // 「このスライド」タブ: 画像の一覧
  // ------------------------------------------------------------------
  app.renderImagePanel = function (panel, ui) {
    const images = app.slideImages();
    const out = app.currentOut();
    const rows = images.map((im, k) => {
      const dom = stage().querySelector('img[data-img="' + k + '"]');
      const placed = dom && dom.closest('.ks-media, .ks-bg');
      const width = /^(\d+)%$/.exec(im.attrs.width || '');
      const name = decodeURIComponent(im.src.split('/').pop() || im.src);
      const edit = (fn) => app.editImage(app.slideRange(), k, im.src, fn);
      const thumb = h('img', { class: 'img-thumb', src: app.assetUrl(im.src), alt: '' });
      const head = h('div', { class: 'img-row-head' }, thumb, h('span', { class: 'img-name', title: im.src }, name),
        h('button', { class: 'btn ghost icon small', type: 'button', title: '削除', html: svg(ICONS.trash), onclick: () => edit(() => null) }));
      const row = h('div', {
        class: 'img-row' + (sel && sel.index === k ? ' is-selected' : ''),
        onmouseenter: () => { if (dom) { hoverBox.hidden = false; place(hoverBox, frameOf(dom)); } },
        onmouseleave: () => { hoverBox.hidden = true; },
        onclick: (e) => { if (dom && !e.target.closest('input, button')) select(dom); },
      }, head);
      if (placed) {
        row.append(h('p', { class: 'hint' }, placed.classList.contains('ks-bg') ? '全面に敷いています（ドラッグで位置調整）' : '横に並べています（境目のドラッグで幅を変更）'));
      } else {
        const value = width ? Number(width[1]) : 100;
        const label = h('output', null, width ? value + '%' : '自動');
        const range = h('input', { type: 'range', min: 5, max: 100, step: 1, value });
        range.addEventListener('input', () => {
          label.textContent = range.value + '%';
          if (dom) { dom.style.width = range.value + '%'; const f = dom.parentElement; if (f.classList.contains('ks-figure')) f.classList.add('ks-sized'); }
        });
        range.addEventListener('change', () => edit((a) => { a.width = range.value + '%'; a.height = undefined; return a; }));
        const has = (c) => im.attrs.classes.includes(c);
        const toggle = (c, label2, others) => h('button', {
          type: 'button', class: has(c) ? 'is-active' : '',
          onclick: () => edit((a) => { a.classes = a.classes.filter((x) => x !== c && !(others || []).includes(x)); if (!has(c)) a.classes.push(c); return a; }),
        }, label2);
        row.append(
          h('div', { class: 'range' }, range, label,
            h('button', { class: 'btn ghost small', type: 'button', title: '大きさの指定を外す', disabled: !width, onclick: () => edit((a) => { a.width = undefined; a.height = undefined; return a; }) }, '自動')),
          h('div', { class: 'seg' }, toggle('shadow', '影'), toggle('round', '丸', ['plain']), toggle('plain', '角', ['round']))
        );
      }
      return row;
    });
    const children = rows.length
      ? rows.concat([h('p', { class: 'hint' }, out.layout.indexOf('image-') === 0 ? '' : 'プレビューの画像をクリックすると、角のドラッグで大きさを変えられます。')])
      : [h('p', { class: 'hint' }, '画像ファイルをプレビューやサムネイルにドロップすると、このスライドに追加されます。')];
    panel.append(ui.group('images', '画像', children, images.length || null));
  };
})();
