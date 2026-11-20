/*
 * editor-live.js — 原稿エディタ（CodeMirror 6）。Obsidian の「ライブプレビュー」のように、
 * Markdown を書きながら見た目がその場で反映される。
 *
 *   ・見出し・太字・リスト・引用・コード・リンクを整形して表示
 *   ・#、**、`、[](url) などの記号は、カーソルのある行（範囲）でだけ表示する
 *   ・画像 / mermaid の図 / 表 は、その場に描画（カーソルを入れると元の記法に戻る）
 *   ・スライドの区切り（---）は「スライド N」の見出し線、??? は「発表者ノート」、||| は「カラム区切り」として表示
 *   ・画像はマウスを乗せると、角のドラッグで大きさ、ボタンで影・丸・削除（{width=…%} などを書き換える）
 *   ・Enter でリストの続き、Ctrl+B / Ctrl+I で太字 / 斜体、Ctrl+Z / Ctrl+Y で元に戻す / やり直し
 *
 * 「ソース」表示に切り替えると、装飾をやめて Markdown をそのまま表示する。
 *
 * ブロック構造（スライド・ノート・カラム・画像・表・図）は core/render.js の editorBlocks()（スライドと同じ解釈）、
 * 行内の装飾（見出し・強調・リンク等）は CodeMirror の Markdown 構文木から作る。
 * 本文の変更は app.applyMd へ、GUI からの変更は app.editor.replaceAll で受け取る（どちらも「元に戻す」に乗る）。
 */
(function () {
  'use strict';
  const CM = window.CM;
  const app = window.KSE;
  const { h, svg, clamp, state } = app;
  const { parse, render, schema } = window.KS;
  const RT = window.Kamishibai;
  const D = CM.Decoration;
  const $ = app.$;

  const host = $('#editorHost');
  const KS_CHANGE = CM.Annotation.define(); // GUI からの変更に付ける（applyMd に渡す opts）
  const focusFx = CM.StateEffect.define();
  const rebuildFx = CM.StateEffect.define();
  const liveSlot = new CM.Compartment();
  let view = null;
  let everFocused = false; // 一度もカーソルを置いていなければ、挿入は「今のスライドの末尾」にする

  const LAYOUT_LABEL = {};
  for (const l of schema.LAYOUTS) LAYOUT_LABEL[l[0]] = l[1];
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).indexOf('Files') >= 0;
  const assetUrl = (src) => app.assetUrl(src);

  // ==================================================================
  // ウィジェット（本文の代わりに表示する部品）
  // ==================================================================
  class SlideWidget extends CM.WidgetType {
    constructor(index, title, layout, current) { super(); Object.assign(this, { index, title, layout, current }); }
    eq(o) { return o.index === this.index && o.title === this.title && o.layout === this.layout && o.current === this.current; }
    toDOM() {
      const el = h('div', { class: 'cm-slide-sep' + (this.current ? ' is-current' : ''), title: 'クリックでこのスライドをプレビュー' },
        h('span', { class: 'n' }, String(this.index + 1)),
        h('span', { class: 't' }, this.title || '（見出しなし）'),
        this.layout ? h('span', { class: 'l' }, this.layout) : null);
      el.addEventListener('mousedown', (e) => { e.preventDefault(); app.setCurrent(this.index, { fromEditor: true }); });
      return el;
    }
    ignoreEvent() { return true; }
  }

  class FrontWidget extends CM.WidgetType {
    constructor(lines) { super(); this.lines = lines; this.key = lines.join('\n'); }
    eq(o) { return o.key === this.key; }
    toDOM() {
      const names = { title: 'タイトル', author: '作成者', date: '日付', lang: '言語' };
      const rows = this.lines.map((l) => /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l)).filter(Boolean)
        .map((m) => h('div', { class: 'row' }, h('span', null, names[m[1]] || m[1]), h('b', null, m[2] || '—')));
      return h('div', { class: 'cm-block is-front' }, h('div', { class: 'cm-front', title: 'クリックで編集' }, h('div', { class: 'label' }, 'デッキ情報'), ...rows));
    }
    ignoreEvent() { return false; }
  }

  class LabelWidget extends CM.WidgetType {
    constructor(kind) { super(); this.kind = kind; }
    eq(o) { return o.kind === this.kind; }
    toDOM() {
      if (this.kind === 'notes') return h('div', { class: 'cm-label is-notes' }, '発表者ノート', h('small', null, '発表者ビューにだけ表示'));
      if (this.kind === 'colsopen') return h('div', { class: 'cm-label is-cols-open' }, 'カラム ここから', h('small', null, '「|||」で区切る'));
      if (this.kind === 'colsclose') return h('div', { class: 'cm-label is-cols-close' }, 'カラム ここまで', h('small', null, 'この下は全幅'));
      return h('div', { class: 'cm-label is-col' }, 'カラム区切り');
    }
    ignoreEvent() { return false; }
  }

  class MermaidWidget extends CM.WidgetType {
    constructor(code) { super(); this.code = code; }
    eq(o) { return o.code === this.code; }
    get estimatedHeight() { return 220; }
    toDOM() {
      const src = h('pre', { class: 'ks-mermaid-src' });
      src.textContent = this.code;
      const box = h('div', { class: 'ks-mermaid' }, src, h('div', { class: 'ks-mermaid-out' }, h('span', { class: 'cm-wait' }, '図を描画しています…')));
      const el = h('div', { class: 'cm-block' }, h('div', { class: 'cm-card cm-mermaid', title: 'クリックで mermaid の記法を編集' }, box));
      setTimeout(() => { if (window.mermaid && el.isConnected) RT.renderMermaid(box); }, 0);
      return el;
    }
    ignoreEvent() { return false; }
  }

  // ------------------------------------------------------------------
  // 表エディタ: Markdown の表を、セルに直接入力できる表として表示する。
  //   入力するたびに（少し待って）Markdown の表を書き直す。行・列の追加 / 削除、列の揃えはボタンで。
  //   Tab / Shift+Tab で隣のセル、Enter で下のセル（最終行なら行を追加）、↑↓ で上下のセル。
  // ------------------------------------------------------------------
  const splitRow = (line) => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    let tick = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '`') tick = !tick;
      if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  };
  function parseTable(src) {
    const lines = src.split('\n').filter((l) => l.trim());
    const head = splitRow(lines[0] || '');
    const aligns = splitRow(lines[1] || '').map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''));
    const rows = lines.slice(2).map(splitRow);
    const n = Math.max(head.length, aligns.length, ...rows.map((r) => r.length), 1);
    const pad = (r) => { r = r.slice(0, n); while (r.length < n) r.push(''); return r; };
    return { cells: [pad(head)].concat(rows.map(pad)), aligns: pad(aligns) };
  }
  function formatTable(t) {
    const cell = (c) => String(c || '').replace(/\n/g, ' ').replace(/\|/g, '\\|');
    const row = (r) => '| ' + r.map(cell).join(' | ') + ' |';
    const al = t.aligns.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'));
    return [row(t.cells[0]), '| ' + al.join(' | ') + ' |'].concat(t.cells.slice(1).map(row)).join('\n');
  }

  const TB_ICON = {
    rowAdd: '<rect x="3.5" y="4" width="17" height="9" rx="2"/><path d="M12 15.5v5M9.5 18h5"/>',
    colAdd: '<rect x="3.5" y="3.5" width="9" height="17" rx="2"/><path d="M15.5 12h5M18 9.5v5"/>',
    rowDel: '<rect x="3.5" y="4" width="17" height="9" rx="2"/><path d="M9.5 18h5"/>',
    colDel: '<rect x="3.5" y="3.5" width="9" height="17" rx="2"/><path d="M15.5 12h5"/>',
    left: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
    center: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
    right: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
    edit: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5"/>',
  };

  class TableWidget extends CM.WidgetType {
    constructor(src) { super(); this.box = { src }; }
    get src() { return this.box.src; }
    set src(v) { this.box.src = v; }
    // 表の中で入力して書き直したときは、box.src を新しい内容に合わせてあるので、DOM（とカーソル）がそのまま使われる。
    // CodeMirror は DOM を使い回すときウィジェットのオブジェクトだけ新しい方に替えるので、box を共有して最新の内容を引き継ぐ
    eq(o) {
      if (o.box.src !== this.box.src) return false;
      if (o.box.owner) this.box = o.box;
      else if (this.box.owner) o.box = this.box;
      return true;
    }
    get estimatedHeight() { return 40 + this.src.split('\n').length * 34; }
    toDOM(v) {
      this.box.owner = this;
      this.view = v;
      this.model = parseTable(this.src);
      this.focusAt = { r: 0, c: 0 };
      this.wrap = h('div', { class: 'cm-block' });
      this.card = h('div', { class: 'cm-card cm-table cm-table-edit' });
      this.wrap.append(this.card);
      this.draw();
      return this.wrap;
    }
    /** 表の Markdown が文書のどこにあるか（今の位置を DOM から引く） */
    range() {
      const v = this.view;
      let pos;
      try { pos = v.posAtDOM(this.wrap); } catch (e) { return null; }
      const doc = v.state.doc;
      const first = doc.lineAt(pos);
      let last = first;
      while (last.number < doc.lines) {
        const next = doc.line(last.number + 1);
        if (!/^\s*\|/.test(next.text) || parse.RE.column.test(next.text)) break;
        last = next;
      }
      return { from: first.from, to: last.to };
    }
    /** 表の内容を Markdown に書き戻す（now = すぐ。入力中は少し待ってまとめる） */
    commit(now) {
      clearTimeout(this.timer);
      const run = () => {
        const r = this.range();
        if (!r) return;
        const text = formatTable(this.model);
        if (this.view.state.sliceDoc(r.from, r.to) === text) return;
        this.src = text; // 新しい装飾と eq で一致させ、表の DOM を作り直させない
        this.view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, userEvent: 'input' });
      };
      if (now) run(); else this.timer = setTimeout(run, 350);
    }
    draw() {
      const m = this.model;
      const table = h('table');
      m.cells.forEach((row, r) => {
        const tr = h('tr');
        row.forEach((text, c) => {
          const input = h('input', { type: 'text', value: text, spellcheck: false, 'data-r': r, 'data-c': c });
          input.addEventListener('focus', () => { this.focusAt = { r, c }; this.card.classList.add('is-active'); this.markCol(c); });
          input.addEventListener('input', () => { m.cells[r][c] = input.value; this.commit(false); });
          input.addEventListener('blur', () => this.commit(true));
          input.addEventListener('keydown', (e) => this.key(e, r, c));
          const cell = h(r === 0 ? 'th' : 'td', { class: m.aligns[c] ? 'is-' + m.aligns[c] : '' }, input);
          tr.append(cell);
        });
        table.append(tr);
      });
      const btn = (icon, label, fn) => h('button', {
        type: 'button', title: label, html: svg(TB_ICON[icon]),
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => { e.stopPropagation(); fn(); },
      });
      const tools = h('div', { class: 'cm-table-tools' },
        btn('rowAdd', '下に行を追加', () => this.edit((t, at) => { t.cells.splice(at.r + 1, 0, t.cells[0].map(() => '')); return { r: at.r + 1, c: at.c }; })),
        btn('colAdd', '右に列を追加', () => this.edit((t, at) => { t.cells.forEach((row) => row.splice(at.c + 1, 0, '')); t.aligns.splice(at.c + 1, 0, ''); return { r: at.r, c: at.c + 1 }; })),
        btn('rowDel', 'この行を削除', () => this.edit((t, at) => { if (t.cells.length <= 2 || at.r === 0) return null; t.cells.splice(at.r, 1); return { r: Math.min(at.r, t.cells.length - 1), c: at.c }; })),
        btn('colDel', 'この列を削除', () => this.edit((t, at) => { if (t.cells[0].length <= 1) return null; t.cells.forEach((row) => row.splice(at.c, 1)); t.aligns.splice(at.c, 1); return { r: at.r, c: Math.min(at.c, t.cells[0].length - 1) }; })),
        h('span', { class: 'sep' }),
        btn('left', 'この列を左揃え', () => this.edit((t, at) => { t.aligns[at.c] = 'left'; return at; })),
        btn('center', 'この列を中央揃え', () => this.edit((t, at) => { t.aligns[at.c] = 'center'; return at; })),
        btn('right', 'この列を右揃え', () => this.edit((t, at) => { t.aligns[at.c] = 'right'; return at; })),
        h('span', { class: 'spacer' }),
        btn('edit', 'Markdown の記法で編集', () => this.reveal()));
      this.card.innerHTML = '';
      this.card.append(tools, table);
    }
    markCol(c) {
      this.card.querySelectorAll('[data-c]').forEach((el) => el.parentNode.classList.toggle('is-col', Number(el.dataset.c) === c));
    }
    cellInput(r, c) { return this.card.querySelector('input[data-r="' + r + '"][data-c="' + c + '"]'); }
    focusCell(r, c, select) {
      const el = this.cellInput(r, c);
      if (!el) return;
      el.focus();
      if (select) el.select();
    }
    /** 表の形を変える操作。fn(model, いまのセル) → 次にカーソルを置くセル（null なら何もしない） */
    edit(fn) {
      const next = fn(this.model, this.focusAt);
      if (!next) return;
      this.draw();
      this.commit(true);
      this.focusCell(next.r, next.c);
    }
    key(e, r, c) {
      const rows = this.model.cells.length;
      const cols = this.model.cells[0].length;
      if (e.key === 'Tab') {
        e.preventDefault();
        let i = r * cols + c + (e.shiftKey ? -1 : 1);
        if (i >= rows * cols) { this.edit((t) => { t.cells.push(t.cells[0].map(() => '')); return { r: rows, c: 0 }; }); return; }
        i = Math.max(0, i);
        this.focusCell(Math.floor(i / cols), i % cols, true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (r + 1 >= rows) this.edit((t) => { t.cells.push(t.cells[0].map(() => '')); return { r: rows, c }; });
        else this.focusCell(r + 1, c, true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (r + 1 < rows) this.focusCell(r + 1, c, true);
        else this.leave(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (r > 0) this.focusCell(r - 1, c, true);
        else this.leave(-1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.leave(1);
      }
    }
    /** 表から出て、表の前後の行にカーソルを移す */
    leave(dir) {
      this.commit(true);
      const r = this.range();
      if (!r) return;
      const doc = this.view.state.doc;
      const pos = dir > 0 ? Math.min(doc.length, r.to + 1) : Math.max(0, r.from - 1);
      this.view.focus();
      this.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    }
    reveal() {
      const r = this.range();
      if (!r) return;
      this.view.focus();
      this.view.dispatch({ selection: { anchor: r.from }, scrollIntoView: true });
    }
    destroy() { clearTimeout(this.timer); }
    ignoreEvent() { return true; }
  }

  class BulletWidget extends CM.WidgetType {
    eq() { return true; }
    toDOM() { return h('span', { class: 'cm-bullet' }, '•'); }
    ignoreEvent() { return false; }
  }

  class InlineImageWidget extends CM.WidgetType {
    constructor(src) { super(); this.src = src; this.url = assetUrl(src); }
    eq(o) { return o.url === this.url; }
    toDOM() { return h('img', { class: 'cm-inline-img', src: this.url, alt: '' }); }
    ignoreEvent() { return false; }
  }

  const IMG_ICON = {
    crop: '<path d="M7 3v14h14M3 7h14v14"/>',
    shadow: '<rect x="4" y="4" width="13" height="13" rx="2"/><path d="M20 8v10a2 2 0 0 1-2 2H8"/>',
    round: '<circle cx="12" cy="12" r="8"/>',
    square: '<rect x="4.5" y="4.5" width="15" height="15"/>',
    reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4.5v4h4"/>',
    edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/>',
    diagram: '<rect x="3.5" y="4" width="7" height="5" rx="1.5"/><path d="M14 15l3.5-3.5 3 3L17 18h-3z"/><path d="M7 9v6h4"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  };

  /** 段落に画像だけが書かれているブロック。マウスを乗せると大きさ変更・影などの操作ができる */
  class ImageWidget extends CM.WidgetType {
    constructor(images, start, end) {
      super();
      this.images = images;
      this.start = start;
      this.end = end;
      // URL（版番号つき）も比べる: 図形を上書き保存したら描き直す
      this.key = start + ':' + end + ':' + images.map((i) => app.assetUrl(i.src) + JSON.stringify(i.attrs)).join('|');
    }
    eq(o) { return o.key === this.key; }
    get estimatedHeight() { return 240; }
    toDOM(v) {
      const wrap = h('div', { class: 'cm-images' + (this.images.length > 1 ? ' is-row' : '') });
      this.images.forEach((im, k) => wrap.append(this.item(v, wrap, im, k)));
      return wrap;
    }
    item(v, wrap, im, k) {
      const range = { start: this.start, end: this.end };
      const edit = (fn) => app.editImage(range, k, im.src, fn);
      const width = im.attrs.width;
      const img = h('img', { src: assetUrl(im.src), alt: im.alt || '', draggable: false, class: im.attrs.classes.join(' ') });
      if (width) img.style.width = /%$/.test(width) ? width : /^\d+(\.\d+)?$/.test(width) ? width + 'px' : width;
      // トリミング（スライドと同じく見せる範囲だけ）
      if (im.attrs.crop) img.style.setProperty('object-view-box', 'inset(' + im.attrs.crop.map((x) => x + '%').join(' ') + ')');
      const cls = im.attrs.classes;
      const toggle = (c, others) => edit((a) => {
        const on = !a.classes.includes(c);
        a.classes = a.classes.filter((x) => x !== c && !(others || []).includes(x));
        if (on) a.classes.push(c);
        return a;
      });
      const tool = (icon, label, fn, active) => h('button', {
        type: 'button', class: 'cv-tool' + (active ? ' is-active' : ''), title: label, html: svg(IMG_ICON[icon]) + '<span>' + label + '</span>',
        onmousedown: (e) => { e.preventDefault(); e.stopPropagation(); },
        onclick: (e) => { e.stopPropagation(); fn(); },
      });
      const tools = h('div', { class: 'cv-toolbar cm-img-tools' },
        tool('shadow', '影', () => toggle('shadow'), cls.includes('shadow')),
        tool('round', '丸く', () => toggle('round', ['plain']), cls.includes('round')),
        tool('square', '角を立てる', () => toggle('plain', ['round']), cls.includes('plain')),
        width ? tool('reset', '大きさを戻す', () => edit((a) => { a.width = undefined; a.height = undefined; return a; })) : null,
        app.diagram && app.diagram.isDiagram(im.src) ? tool('diagram', '図形を編集', () => app.diagram.open({ path: app.safeDecode(im.src) })) : null,
        app.cropImage ? tool('crop', 'トリミング', async () => {
          const c = await app.cropImage({ src: assetUrl(im.src), crop: im.attrs.crop });
          if (c) edit((a) => { a.crop = app.cropActive(c) ? c : null; return a; });
        }, !!im.attrs.crop) : null,
        tool('edit', '記法を編集', () => this.reveal(v)),
        tool('trash', '削除', () => edit(() => null)));
      const label = h('span', { class: 'cm-img-size' });
      const handle = h('div', { class: 'cm-img-handle', title: 'ドラッグで大きさを変更' });
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ref = wrap.getBoundingClientRect();
        const start = img.getBoundingClientRect();
        const cx = (start.left + start.right) / 2;
        let pct = Math.round((start.width / ref.width) * 100);
        box.classList.add('is-resizing');
        const move = (ev) => {
          pct = clamp(Math.round(((2 * Math.abs(ev.clientX - cx)) / ref.width) * 100), 5, 100);
          img.style.width = pct + '%';
          img.style.maxHeight = 'none';
          label.textContent = '幅 ' + pct + '%';
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          box.classList.remove('is-resizing');
          edit((a) => { a.width = pct + '%'; a.height = undefined; return a; });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      const box = h('div', { class: 'cm-img', title: 'ダブルクリックで記法を編集' }, img, handle, tools, label);
      box.addEventListener('dblclick', () => {
        if (app.diagram && app.diagram.isDiagram(im.src)) app.diagram.open({ path: app.safeDecode(im.src) });
        else this.reveal(v);
      });
      return box;
    }
    /** 画像の行にカーソルを置いて、元の記法を表示する */
    reveal(v) {
      const line = v.state.doc.line(Math.min(this.start + 1, v.state.doc.lines));
      v.dispatch({ selection: { anchor: line.to } });
      v.focus();
    }
    ignoreEvent() { return true; }
  }

  // ==================================================================
  // ライブプレビューの装飾を作る
  // ==================================================================
  const isTable = (lines, start, end) => end - start >= 2 && /^\s*\|/.test(lines[start]) && /^\s*\|?\s*:?-{2,}/.test(lines[start + 1]);

  function build(cmState, focused) {
    const doc = cmState.doc;
    const text = doc.toString();
    const decos = [];
    const blocked = []; // ブロックごと差し替えた範囲（行内の装飾は付けない）
    const hidden = []; // 行内で隠した範囲（重ならないように）
    const ranges = cmState.selection.ranges;
    const touches = (from, to) => focused && ranges.some((r) => r.from <= to && r.to >= from);
    const lineAt0 = (n0) => doc.line(clamp(n0 + 1, 1, doc.lines));
    const span = (a, b) => ({ from: lineAt0(a).from, to: lineAt0(b - 1).to }); // 行 [a, b)（0 始まり）
    const lineClass = (a, b, cls) => { for (let i = a; i < b && i < doc.lines; i++) decos.push(D.line({ class: cls }).range(lineAt0(i).from)); };
    const replaceBlock = (r, widget) => {
      decos.push((widget ? D.replace({ widget, block: true }) : D.replace({ block: true })).range(r.from, r.to));
      blocked.push(r);
    };
    const hide = (from, to, widget) => {
      if (to <= from || hidden.some((r) => r.from < to && from < r.to)) return;
      hidden.push({ from, to });
      decos.push((widget ? D.replace({ widget }) : D.replace({})).range(from, to));
    };
    const inBlocked = (from, to) => blocked.some((r) => from >= r.from && to <= r.to);

    const { items, parsed, lines } = render.editorBlocks(text, app.md);
    const out = state.out && state.out.slides;
    const slideWidget = (i) => new SlideWidget(i, parsed.slides[i] ? parsed.slides[i].title : '', out && out[i] ? LAYOUT_LABEL[out[i].layout] : '', i === state.current);
    let firstSlideMarked = false;

    for (const it of items) {
      if (it.type === 'front') {
        const r = span(it.start, it.end);
        if (touches(r.from, r.to)) { lineClass(it.start, it.end, 'cm-fm'); blocked.push(r); } // 中身を見出し等として装飾しない
        else replaceBlock(r, new FrontWidget(lines.slice(it.start, it.end)));
        continue;
      }
      if (!firstSlideMarked && it.slide === 0) {
        firstSlideMarked = true;
        const at = it.type === 'block' ? it.start : it.line;
        if (at < doc.lines) decos.push(D.widget({ widget: slideWidget(0), block: true, side: -1 }).range(lineAt0(at).from));
      }
      if (it.type === 'sep' || it.type === 'notes' || it.type === 'col' || it.type === 'id' || it.type === 'colsopen' || it.type === 'colsclose') {
        const L = lineAt0(it.line);
        const r = { from: L.from, to: L.to };
        if (touches(r.from, r.to)) { lineClass(it.line, it.line + 1, 'cm-mark-line'); blocked.push(r); continue; }
        if (it.type === 'sep') replaceBlock(r, slideWidget(it.slide));
        else if (it.type === 'id') replaceBlock(r, null);
        else replaceBlock(r, new LabelWidget(it.type));
        continue;
      }
      if (it.type !== 'block') continue;
      const first = lines[it.start];
      const r = span(it.start, it.end);
      if (it.note) lineClass(it.start, it.end, 'cm-note');
      // コード・図
      if (/^ {0,3}(```|~~~)/.test(first)) {
        if (/^ {0,3}(```|~~~)\s*mermaid\b/.test(first) && !touches(r.from, r.to)) {
          replaceBlock(r, new MermaidWidget(lines.slice(it.start + 1, it.end - 1).join('\n')));
        } else {
          lineClass(it.start, it.end, 'cm-code');
          decos.push(D.line({ class: 'cm-code-first' }).range(r.from));
          decos.push(D.line({ class: 'cm-code-last' }).range(lineAt0(it.end - 1).from));
          blocked.push(r);
        }
        continue;
      }
      // 表
      if (isTable(lines, it.start, it.end)) {
        if (touches(r.from, r.to)) { lineClass(it.start, it.end, 'cm-table-src'); blocked.push(r); }
        else replaceBlock(r, new TableWidget(lines.slice(it.start, it.end).join('\n')));
        continue;
      }
      // 画像だけの段落
      const images = parse.findImages(text, it.start, it.end);
      if (images.length) {
        let rest = text.slice(r.from, r.to);
        for (let k = images.length - 1; k >= 0; k--) rest = rest.slice(0, images[k].start - r.from) + rest.slice(images[k].end - r.from);
        if (!rest.trim()) {
          const widget = new ImageWidget(images, it.start, it.end);
          if (touches(r.from, r.to)) decos.push(D.widget({ widget, block: true, side: 1 }).range(r.to));
          else replaceBlock(r, widget);
        }
      }
    }

    // ---- 行内の装飾（CodeMirror の Markdown 構文木から） ----
    const tree = CM.ensureSyntaxTree(cmState, doc.length, 250) || CM.syntaxTree(cmState);
    const lineActive = (pos) => { const L = doc.lineAt(pos); return touches(L.from, L.to); };
    tree.iterate({
      enter(node) {
        const { name, from, to } = node;
        if (name === 'Document') return true;
        if (inBlocked(from, to)) return false;
        let m;
        if ((m = /^ATXHeading(\d)$/.exec(name)) || (m = /^SetextHeading(\d)$/.exec(name))) {
          decos.push(D.line({ class: 'cm-h cm-h' + m[1] }).range(doc.lineAt(from).from));
          return true;
        }
        switch (name) {
          case 'HeaderMark':
            if (node.node.parent && /^ATX/.test(node.node.parent.name) && !lineActive(from)) {
              hide(from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to);
            }
            return false;
          case 'EmphasisMark':
          case 'StrikethroughMark': {
            const p = node.node.parent;
            if (p && !touches(p.from, p.to)) hide(from, to);
            return false;
          }
          case 'InlineCode':
            decos.push(D.mark({ class: 'cm-icode' }).range(from, to));
            if (!touches(from, to)) {
              for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') hide(c.from, c.to);
            }
            return false;
          case 'Link':
            decos.push(D.mark({ class: 'cm-link' }).range(from, to));
            if (!touches(from, to)) {
              for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark' || c.name === 'URL' || c.name === 'LinkTitle') hide(c.from, c.to);
            }
            return true;
          case 'Image': {
            if (touches(from, to)) return false;
            const after = /^\{[^}\n]*\}/.exec(doc.sliceString(to, Math.min(doc.length, to + 80)));
            const url = node.node.getChild('URL');
            hide(from, to + (after ? after[0].length : 0), new InlineImageWidget(url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, '') : ''));
            return false;
          }
          case 'ListMark': {
            const list = node.node.parent && node.node.parent.parent;
            if (list && list.name === 'BulletList') {
              if (!lineActive(from)) hide(from, to, new BulletWidget());
            } else {
              decos.push(D.mark({ class: 'cm-olmark' }).range(from, to));
            }
            return false;
          }
          case 'Blockquote':
            for (let p = from; p <= to; ) { const L = doc.lineAt(p); decos.push(D.line({ class: 'cm-quote' }).range(L.from)); p = L.to + 1; }
            return true;
          case 'QuoteMark':
            if (!lineActive(from)) hide(from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to);
            return false;
          case 'HorizontalRule':
            decos.push(D.line({ class: 'cm-hr' }).range(doc.lineAt(from).from));
            return false;
          default:
            return true;
        }
      },
    });
    try {
      return D.set(decos, true);
    } catch (e) {
      console.error('[kamishibai] live preview', e);
      return D.none;
    }
  }

  const livePreview = CM.StateField.define({
    create(s) { return { focused: false, deco: build(s, false) }; },
    update(v, tr) {
      let focused = v.focused;
      let force = false;
      for (const e of tr.effects) {
        if (e.is(focusFx)) { focused = e.value; force = true; }
        if (e.is(rebuildFx)) force = true;
      }
      if (!tr.docChanged && !tr.selection && !force) return v;
      try {
        return { focused, deco: build(tr.state, focused) };
      } catch (e) {
        console.error('[kamishibai] live preview', e);
        return { focused, deco: D.none };
      }
    },
    provide: (f) => CM.EditorView.decorations.from(f, (v) => v.deco),
  });

  // ==================================================================
  // エディタの組み立て
  // ==================================================================
  const t = CM.tags;
  const highlight = CM.HighlightStyle.define([
    { tag: t.heading, fontWeight: '700' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.link, color: 'var(--accent)' },
    { tag: t.url, color: 'var(--muted)' },
    { tag: t.monospace, fontFamily: 'var(--mono)' },
    { tag: t.quote, color: 'var(--text-soft)' },
    { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: 'var(--muted)' },
    { tag: t.comment, color: 'var(--muted)', fontStyle: 'italic' },
  ]);

  /** 選択範囲を open〜close で囲む / 既に囲まれていれば外す（Ctrl+B / Ctrl+I・書式ボタン） */
  function toggleWrap(open, close) {
    close = close == null ? open : close;
    return (v) => {
      const a = open.length;
      const b = close.length;
      const tr = v.state.changeByRange((r) => {
        const doc = v.state.doc;
        const before = doc.sliceString(r.from - a, r.from);
        const after = doc.sliceString(r.to, r.to + b);
        if (before === open && after === close) {
          return { changes: [{ from: r.from - a, to: r.from }, { from: r.to, to: r.to + b }], range: CM.EditorSelection.range(r.from - a, r.to - a) };
        }
        return { changes: [{ from: r.from, insert: open }, { from: r.to, insert: close }], range: CM.EditorSelection.range(r.from + a, r.to + a) };
      });
      v.dispatch(v.state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
      return true;
    };
  }

  // 行頭の記号（見出し・リスト・引用）を外す / 付ける
  const RE_LINE_PREFIX = /^(\s*)(#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/;
  /**
   * 選択している行すべての行頭を書き換える。
   * kind: 'h1'〜'h3' 見出し / 'p' 本文に戻す / 'ul' 箇条書き / 'ol' 番号付き / 'quote' 引用
   * 全行が既にその形なら外す（トグル）
   */
  function setLinePrefix(v, kind) {
    const s = v.state;
    const lines = [];
    for (const r of s.selection.ranges) {
      for (let n = s.doc.lineAt(r.from).number; n <= s.doc.lineAt(r.to).number; n++) if (!lines.includes(n)) lines.push(n);
    }
    const want = (i) => ({ h1: '# ', h2: '## ', h3: '### ', ul: '- ', ol: i + 1 + '. ', quote: '> ', p: '' }[kind]);
    const isKind = (text) => {
      const m = RE_LINE_PREFIX.exec(text);
      const p = m ? m[2] : '';
      if (kind === 'ol') return /^\d+[.)]\s/.test(p);
      if (kind === 'ul') return /^[-*+]\s/.test(p);
      if (kind === 'quote') return /^>/.test(p);
      return p.trim() === want(0).trim() && !!p;
    };
    const textLines = lines.map((n) => s.doc.line(n)).filter((L) => L.text.trim() || lines.length === 1);
    const allSame = kind !== 'p' && textLines.every((L) => isKind(L.text));
    let k = 0;
    const changes = textLines.map((L) => {
      const m = RE_LINE_PREFIX.exec(L.text);
      const indent = m ? m[1] : /^\s*/.exec(L.text)[0];
      const oldLen = m ? m[0].length : indent.length;
      // 見出しは字下げしない。リストは字下げ（入れ子）を保つ
      const keep = kind === 'ul' || kind === 'ol' ? indent : '';
      const insert = allSame ? keep : keep + want(k++);
      return { from: L.from, to: L.from + oldLen, insert };
    });
    v.dispatch({ changes, scrollIntoView: true, userEvent: 'input' });
    v.focus();
  }

  /** リンク: 選択した文字をリンクにする（URL の部分を選んだ状態にする） */
  function insertLink(v) {
    const r = v.state.selection.main;
    const label = v.state.sliceDoc(r.from, r.to) || 'リンクの文字';
    const url = 'https://';
    const text = '[' + label + '](' + url + ')';
    const at = r.from + label.length + 3;
    v.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: at, head: at + url.length }, scrollIntoView: true, userEvent: 'input' });
    v.focus();
  }

  /** 書式ボタン（ツールバー）から呼ぶ。Markdown を知らなくても使えるように */
  const FORMATS = {
    bold: (v) => toggleWrap('**')(v),
    italic: (v) => toggleWrap('*')(v),
    strike: (v) => toggleWrap('~~')(v),
    mark: (v) => toggleWrap('<mark>', '</mark>')(v),
    code: (v) => toggleWrap('`')(v),
    link: insertLink,
    h1: (v) => setLinePrefix(v, 'h1'),
    h2: (v) => setLinePrefix(v, 'h2'),
    h3: (v) => setLinePrefix(v, 'h3'),
    p: (v) => setLinePrefix(v, 'p'),
    ul: (v) => setLinePrefix(v, 'ul'),
    ol: (v) => setLinePrefix(v, 'ol'),
    quote: (v) => setLinePrefix(v, 'quote'),
    undo: (v) => CM.undo(v),
    redo: (v) => CM.redo(v),
  };

  /** カーソル位置の行が属するブロックの末尾の行（0 始まり、そこに挿入すると直後に入る） */
  function blockEndAt(line0) {
    const { items } = render.editorBlocks(view.state.doc.toString(), app.md);
    const b = items.find((it) => it.type === 'block' && it.start <= line0 && line0 < it.end);
    return b ? b.end : line0 + 1;
  }

  function followCursor(s) {
    const line0 = s.doc.lineAt(s.selection.main.head).number - 1;
    const index = parse.slideIndexAtLine(parse.parseDeck(s.doc.toString()), line0);
    if (index !== state.current) app.setCurrent(index, { fromEditor: true });
  }

  function extensions() {
    return [
      CM.keymap.of([
        { key: 'Mod-Enter', run: () => { app.present(); return true; } },
        { key: 'Mod-b', run: toggleWrap('**') },
        { key: 'Mod-i', run: toggleWrap('*') },
      ]),
      CM.history(),
      CM.drawSelection(),
      CM.EditorView.lineWrapping,
      CM.markdown({ base: CM.markdownLanguage }),
      CM.syntaxHighlighting(highlight),
      CM.keymap.of([...CM.defaultKeymap, ...CM.historyKeymap, CM.indentWithTab]),
      CM.placeholder('# タイトル\n\nここに書きます。「---」だけの行（前後は空行）で次のスライドへ。'),
      liveSlot.of(state.mode === 'source' ? [] : livePreview),
      CM.EditorView.focusChangeEffect.of((s, focusing) => focusFx.of(focusing)),
      CM.EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          let opts = null;
          for (const tr of u.transactions) { const a = tr.annotation(KS_CHANGE); if (a) opts = a; }
          app.applyMd(u.state.doc.toString(), opts || { from: 'editor' });
        }
        if (u.focusChanged && u.view.hasFocus) everFocused = true;
        if ((u.selectionSet || u.docChanged) && u.view.hasFocus) followCursor(u.state);
      }),
      CM.EditorView.domEventHandlers({
        paste(e) {
          const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => /^image\//.test(f.type));
          if (!files.length) return false;
          e.preventDefault();
          app.uploadImages(files);
          return true;
        },
        dragover(e) {
          if (!hasFiles(e)) return false;
          e.preventDefault();
          host.classList.add('is-dropping');
          return true;
        },
        dragleave(e) {
          if (!host.contains(e.relatedTarget)) host.classList.remove('is-dropping');
          return false;
        },
        drop(e, v) {
          if (!hasFiles(e)) return false;
          e.preventDefault();
          e.stopPropagation();
          host.classList.remove('is-dropping');
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          const target = pos == null ? { slide: state.current } : { line: blockEndAt(v.state.doc.lineAt(pos).number - 1) };
          app.uploadImages(Array.from(e.dataTransfer.files), target);
          return true;
        },
      }),
    ];
  }

  function createState(doc) {
    return CM.EditorState.create({ doc, extensions: extensions() });
  }

  // 装飾の作り直し（スライドの並びやレイアウトが変わったとき）。更新処理の最中に呼ばれることがあるので少し遅らせる
  let rebuildTimer = 0;
  function rebuildSoon() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { if (view) view.dispatch({ effects: rebuildFx.of(null) }); }, 0);
  }

  function scrollToSlide(index) {
    const slides = parse.parseDeck(view.state.doc.toString()).slides;
    const s = slides[index];
    if (!s) return;
    const line0 = index === 0 ? s.startLine : s.startLine - 1;
    const pos = view.state.doc.line(clamp(line0 + 1, 1, view.state.doc.lines)).from;
    view.dispatch({ effects: CM.EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 }) });
  }

  // ==================================================================
  // app.editor（editor.js などから使う窓口）
  // ==================================================================
  app.editor = {
    /** 別のデッキを開いたとき。履歴もリセットされる */
    load(text) {
      everFocused = false;
      if (!view) view = new CM.EditorView({ state: createState(text), parent: host });
      else view.setState(createState(text));
      view.scrollDOM.scrollTop = 0;
    },

    /** GUI 操作による全文の差し替え（差分だけを 1 つの変更として入れる → Ctrl+Z で戻せる） */
    replaceAll(text, opts) {
      opts = opts || {};
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let a = 0;
      while (a < cur.length && a < text.length && cur.charCodeAt(a) === text.charCodeAt(a)) a++;
      let b = 0;
      while (b < cur.length - a && b < text.length - a && cur.charCodeAt(cur.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
      view.dispatch({
        changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) },
        annotations: [KS_CHANGE.of(opts), CM.Transaction.addToHistory.of(opts.history !== false)],
      });
    },

    undo(redo) {
      if (view) (redo ? CM.redo : CM.undo)(view);
    },

    /**
     * スニペット・画像の挿入。
     *   slide: 今のスライドの後ろ / notes: 今のスライドの末尾（既にあればそこへ移動）
     *   それ以外: カーソルのあるブロックの直後（まだ書き始めていなければ、今のスライドの末尾）
     */
    insert(text, kind) {
      const doc = view.state.doc.toString();
      const slides = parse.parseDeck(doc).slides;
      const slide = slides[clamp(state.current, 0, slides.length - 1)];
      let at;
      if (kind === 'slide') at = slide.endLine + 1;
      else if (kind === 'notes') {
        if (slide.notesLine >= 0) {
          const L = view.state.doc.line(clamp(slide.endLine + 1, 1, view.state.doc.lines));
          view.dispatch({ selection: { anchor: L.to }, scrollIntoView: true });
          view.focus();
          app.toast('このスライドには既にノートがあります');
          return;
        }
        at = parse.slideBodyRange(slide).end;
      } else if (everFocused) {
        const line0 = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
        at = view.state.doc.line(line0 + 1).text.trim() ? blockEndAt(line0) : line0;
      } else {
        at = parse.slideBodyRange(slide).end;
      }
      const r = parse.insertBlockAt(doc, at, text);
      app.updateMd(r.text, { from: 'api', now: true });
      // 入れたところにカーソルを置く（画像はカーソルを置かず、見える位置までスクロールだけ）
      const last = view.state.doc.line(clamp(r.line + r.count, 1, view.state.doc.lines));
      if (kind === 'image') {
        view.dispatch({ effects: CM.EditorView.scrollIntoView(last.from, { y: 'center' }) });
      } else {
        const first = kind === 'slide' ? view.state.doc.line(clamp(r.line + 3, 1, view.state.doc.lines)) : last;
        view.dispatch({ selection: { anchor: first.to }, scrollIntoView: true });
        view.focus();
      }
    },

    /** 書式ボタン: 'bold' 'italic' 'strike' 'mark' 'code' 'link' 'h1'〜'h3' 'p' 'ul' 'ol' 'quote' 'undo' 'redo' */
    format(name) {
      if (!view || !FORMATS[name]) return;
      FORMATS[name](view);
      view.focus();
    },
    focus() { if (view) view.focus(); },
    /** CodeMirror の EditorView（動作確認・デバッグ用） */
    get view() { return view; },
  };

  // ==================================================================
  // 他の部品との連携
  // ==================================================================
  app.on('refresh', () => {
    if (state.out) host.setAttribute('style', render.tokensToStyle(state.out.resolved.tokens)); // 図の色をテーマに合わせる
    rebuildSoon();
  });
  app.on('current', (o) => {
    rebuildSoon();
    if (!o.fromEditor && view) setTimeout(() => scrollToSlide(o.index), 0);
  });
  app.on('mermaid', rebuildSoon);
  app.on('mode', (mode) => {
    host.classList.toggle('is-source', mode === 'source');
    if (view) view.dispatch({ effects: liveSlot.reconfigure(mode === 'source' ? [] : livePreview) });
  });
  app.on('side', (side) => { if (side === 'write' && view) setTimeout(() => view.requestMeasure(), 0); });
  host.addEventListener('dragleave', (e) => { if (!host.contains(e.relatedTarget)) host.classList.remove('is-dropping'); });
  host.dataset.dropLabel = 'ここに画像を挿入';
})();
