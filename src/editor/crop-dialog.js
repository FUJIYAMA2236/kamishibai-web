/*
 * crop-dialog.js — 画像のトリミング（切り抜く範囲を選ぶダイアログ）。スライドの画像と、図形エディタの画像の両方で使う。
 *
 *   app.cropImage({ src, crop }) → Promise<[上, 右, 下, 左] | null>
 *     src  … 表示できる画像の URL（asset URL / data URI）
 *     crop … いまの切り抜き（それぞれ画像の幅・高さに対する %。無ければ全体）
 *     戻り値 … 決めた切り抜き（[0, 0, 0, 0] = 切り抜かない）。キャンセルなら null
 *
 * 元の画像は変えない（どこを見せるかだけを持つ）ので、あとからいつでも戻せる。
 */
(function () {
  'use strict';
  const app = window.KSE;
  const { h } = app;

  const RATIOS = [['', '自由'], ['1', '1:1'], ['1.3333', '4:3'], ['1.7778', '16:9'], ['0.75', '3:4']];
  const round1 = (v) => Math.round(v * 10) / 10;

  app.cropImage = function cropImage(opts) {
    return new Promise((resolve) => {
      const crop0 = Array.isArray(opts.crop) && opts.crop.length === 4 ? opts.crop.map(Number) : [0, 0, 0, 0];
      // 切り抜く範囲は、画像の幅・高さに対する割合（0〜1）の四角で持つ
      let box = { x: crop0[3] / 100, y: crop0[0] / 100, w: 1 - (crop0[1] + crop0[3]) / 100, h: 1 - (crop0[0] + crop0[2]) / 100 };
      let ratio = ''; // 縦横比を固定するとき（幅 / 高さ。画面上の比）
      let nat = { w: 1, h: 1 };

      const img = h('img', { class: 'cr-img', src: opts.src, alt: '', draggable: false });
      const sel = h('div', { class: 'cr-sel' });
      const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((k) => {
        const el = h('div', { class: 'cr-h cr-' + k });
        el.dataset.h = k;
        sel.append(el);
        return el;
      });
      const stage = h('div', { class: 'cr-stage' }, img, sel);
      const sizeLabel = h('span', { class: 'cr-size' });
      const ratioBtns = RATIOS.map(([v, label]) => {
        const b = h('button', { type: 'button', class: 'btn small' + (v === ratio ? ' is-active' : '') }, label);
        b.addEventListener('click', () => { ratio = v; ratioBtns.forEach((x) => x.classList.toggle('is-active', x === b)); if (v) applyRatio(); draw(); });
        return b;
      });
      const done = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const ok = h('button', { type: 'button', class: 'btn primary' }, '決定');
      const cancel = h('button', { type: 'button', class: 'btn' }, 'キャンセル');
      const reset = h('button', { type: 'button', class: 'btn' }, '全体に戻す');
      const dialog = h('div', { class: 'cr-dialog', role: 'dialog', 'aria-label': 'トリミング' },
        h('div', { class: 'cr-head' }, h('b', null, 'トリミング'), h('span', { class: 'cr-hint' }, '枠の辺・角をドラッグで範囲、中をドラッグで移動。元の画像は残るので、いつでも戻せます')),
        stage,
        h('div', { class: 'cr-foot' }, h('div', { class: 'cr-ratios' }, h('span', null, '縦横比'), ...ratioBtns), sizeLabel, h('div', { class: 'cr-btns' }, reset, cancel, ok)));
      const overlay = h('div', { class: 'cr-overlay' }, dialog);
      document.body.append(overlay);

      function applyRatio() {
        // 画面上の縦横比 → 割合の四角の縦横比（画像自体の縦横比で割る）
        const r = Number(ratio) / (nat.w / nat.h);
        let w = box.w;
        let hh = w / r;
        if (hh > 1) { hh = 1; w = hh * r; }
        if (w > 1) { w = 1; hh = w / r; }
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        box = { x: Math.min(Math.max(0, cx - w / 2), 1 - w), y: Math.min(Math.max(0, cy - hh / 2), 1 - hh), w, h: hh };
      }
      function draw() {
        Object.assign(sel.style, { left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.w * 100 + '%', height: box.h * 100 + '%' });
        sizeLabel.textContent = Math.round(box.w * nat.w) + ' × ' + Math.round(box.h * nat.h) + ' px';
      }
      img.addEventListener('load', () => { nat = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 }; draw(); });
      if (img.complete && img.naturalWidth) nat = { w: img.naturalWidth, h: img.naturalHeight };
      draw();

      // ドラッグ（中 = 移動 / 辺・角 = 範囲）
      let drag = null;
      stage.addEventListener('pointerdown', (e) => {
        const k = e.target.dataset && e.target.dataset.h;
        if (!k && e.target !== sel) return;
        e.preventDefault();
        stage.setPointerCapture(e.pointerId);
        drag = { k: k || 'move', sx: e.clientX, sy: e.clientY, b: Object.assign({}, box) };
      });
      stage.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const r = img.getBoundingClientRect();
        const dx = (e.clientX - drag.sx) / r.width;
        const dy = (e.clientY - drag.sy) / r.height;
        const b = drag.b;
        const MIN = 0.03;
        if (drag.k === 'move') {
          box = { x: Math.min(Math.max(0, b.x + dx), 1 - b.w), y: Math.min(Math.max(0, b.y + dy), 1 - b.h), w: b.w, h: b.h };
        } else {
          let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
          if (drag.k.includes('w')) x1 = Math.min(Math.max(0, b.x + dx), x2 - MIN);
          if (drag.k.includes('e')) x2 = Math.max(Math.min(1, x2 + dx), x1 + MIN);
          if (drag.k.includes('n')) y1 = Math.min(Math.max(0, b.y + dy), y2 - MIN);
          if (drag.k.includes('s')) y2 = Math.max(Math.min(1, y2 + dy), y1 + MIN);
          if (ratio) {
            // 縦横比の固定: 動かした辺に合わせてもう一方を決める（角は横を優先）
            const rr = Number(ratio) / (nat.w / nat.h);
            if (drag.k === 'n' || drag.k === 's') {
              const w = (y2 - y1) * rr; const cx = (x1 + x2) / 2; x1 = cx - w / 2; x2 = cx + w / 2;
            } else {
              const hh = (x2 - x1) / rr;
              if (drag.k.includes('n')) y1 = y2 - hh; else if (drag.k.includes('s') || drag.k === 'e' || drag.k === 'w') {
                if (drag.k === 'e' || drag.k === 'w') { const cy = (y1 + y2) / 2; y1 = cy - hh / 2; y2 = cy + hh / 2; } else y2 = y1 + hh;
              }
            }
            if (x1 < 0 || y1 < 0 || x2 > 1 || y2 > 1) return; // 画像からはみ出す大きさにはしない
          }
          box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        }
        draw();
      });
      const end = () => { drag = null; };
      stage.addEventListener('pointerup', end);
      stage.addEventListener('pointercancel', end);

      const result = () => {
        const v = [box.y, 1 - box.x - box.w, 1 - box.y - box.h, box.x].map((x) => Math.max(0, round1(x * 100)));
        return v.every((x) => x < 0.2) ? [0, 0, 0, 0] : v;
      };
      ok.addEventListener('click', () => done(result()));
      cancel.addEventListener('click', () => done(null));
      reset.addEventListener('click', () => { box = { x: 0, y: 0, w: 1, h: 1 }; ratio = ''; ratioBtns.forEach((x, i) => x.classList.toggle('is-active', i === 0)); draw(); });
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) done(null); });
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); }
        else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(result()); }
      }
      document.addEventListener('keydown', onKey, true);
      ok.focus();
    });
  };

  /** [上, 右, 下, 左]（%）が何かを切り抜いているか */
  app.cropActive = (c) => Array.isArray(c) && c.length === 4 && c.some((v) => Number(v) > 0);
})();
