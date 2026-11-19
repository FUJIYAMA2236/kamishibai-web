/*
 * editor.js — エディタ（GUI）の本体。フレームワークなしの素の DOM 操作。
 *
 * 画面は 2 ペイン（左右は入れ替え可能）:
 *   プレビュー   本番と同じ render.js + runtime.css/js。画像はその場でドラッグ操作できる（editor-canvas.js）
 *   編集パネル   タブで切り替え
 *                「原稿」  Markdown（slides.md）を書く。ライブプレビュー付きのエディタ（editor-live.js / CodeMirror 6）
 *                「デザイン」deck.json / theme.json を GUI で編集する
 *
 * データの流れ:
 *   入力 → CodeMirror → applyMd() → state.md → refresh() で再描画 → 少し待ってサーバーへ自動保存（save）
 *   GUI 操作で Markdown を書き換えるときは updateMd() を通す（エディタへの変更として入るので、Ctrl+Z で戻せる）。
 *   デザインの変更は designChanged() を通す。
 *
 * 他のファイル（editor-canvas.js / editor-live.js）とは window.KSE（= app）を通じてやりとりする。
 * 起動は index.html の最後で KSE.start() を呼ぶ。
 *
 * デザインパネルの項目は core/schema.js の定義から自動生成している。
 * 調整項目を増やしたいときは、ここではなく schema.js に足す。
 */
(function () {
  'use strict';
  const { schema, parse, render } = window.KS;
  const RT = window.Kamishibai;
  const md = render.createMarkdown(window.markdownit, window.hljs);

  const $ = (sel, root) => (root || document).querySelector(sel);
  const THUMB_WIDTH = 168;

  const state = {
    decks: [],
    themes: {},
    name: null, // 開いているデッキ名
    md: '',
    design: {},
    deckCss: '',
    mtime: {},
    parsed: null, // parse.parseDeck の結果
    out: null, // render.renderDeck の結果
    current: 0,
    tab: 'deck',
    mode: localStorage.getItem('ks.editorMode') === 'source' ? 'source' : 'live', // エディタの表示（ライブ / ソース）
    side: localStorage.getItem('ks.side') === 'design' ? 'design' : 'write', // 編集パネルのタブ
    dirty: { md: false, design: false },
    saving: 0,
    deckSig: '',
  };
  const thumbs = []; // [{ wrap, deck, stage, slide, html, num, pin }]

  // 他のファイルから使う窓口。listeners は on() / emit() で使うイベント
  const listeners = {};
  const app = (window.KSE = {
    state, md, $,
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    emit(name, arg) { for (const fn of listeners[name] || []) { try { fn(arg); } catch (e) { console.error(e); } } },
  });

  // ------------------------------------------------------------------
  // 小道具
  // ------------------------------------------------------------------
  /** h('div', { class: 'x', onclick: fn }, child, 'text') */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'class') el.className = v;
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(c));
    }
    return el;
  }
  const svg = (paths) => '<svg viewBox="0 0 24 24">' + paths + '</svg>';
  const ICON_RESET = svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4.5v4h4"/>');
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const debounce = (fn, ms) => { let t = 0; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; };
  const kb = (bytes) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.ceil(bytes / 1024) + ' KB');
  const safeDecode = (s) => { try { return decodeURI(String(s)); } catch (e) { return String(s); } };

  function toast(message, isError) {
    const el = h('div', { class: 'toast' + (isError ? ' is-error' : '') }, message);
    $('#toasts').append(el);
    setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 300); }, isError ? 6000 : 2600);
  }

  const desktop = window.KSDesktop || null; // デスクトップアプリ（Tauri）: 裏側の処理をこの画面の中で直接呼ぶ
  async function api(method, url, body, type) {
    if (desktop) return desktop.api(method, url, body, type);
    const opt = { method, headers: {} };
    if (body !== undefined) {
      opt.body = type ? body : JSON.stringify(body);
      opt.headers['Content-Type'] = type || 'application/json';
    }
    const res = await fetch(url, opt);
    const isJson = (res.headers.get('content-type') || '').indexOf('json') >= 0;
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || res.status + ' ' + res.statusText);
    return data;
  }
  const deckUrl = (suffix) => '/api/project' + (suffix || '');

  // 任意の CSS 色を #rrggbb に（<input type="color"> 用）
  const colorCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  function toHex(color) {
    if (!color) return '';
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
    colorCtx.clearRect(0, 0, 1, 1);
    colorCtx.fillStyle = '#000';
    colorCtx.fillStyle = color;
    colorCtx.fillRect(0, 0, 1, 1);
    const d = colorCtx.getImageData(0, 0, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------
  // 保存（自動）
  // ------------------------------------------------------------------
  const saveTimers = {};
  function setStatus(kind, message) {
    const el = $('#status');
    el.dataset.state = kind;
    el.lastElementChild.textContent = message || (kind === 'saving' ? '保存中…' : '保存済み');
    el.title = kind === 'error' ? message : '変更は自動で保存されます (Ctrl+S で今すぐ保存)';
  }
  function markDirty(kind) {
    state.dirty[kind] = true;
    state.tempEdited = true; // 保存先の無いプロジェクトを書き換えた（ブラウザ版の離れるときの確認に使う）
    setStatus('saving');
    clearTimeout(saveTimers[kind]);
    saveTimers[kind] = setTimeout(() => save(kind), kind === 'md' ? 700 : 350);
  }
  async function save(kind) {
    clearTimeout(saveTimers[kind]);
    if (!state.dirty[kind] || !state.project) return;
    state.dirty[kind] = false;
    state.saving++;
    const name = state.name;
    try {
      const r = kind === 'md'
        ? await api('PUT', deckUrl('/md'), state.md, 'text/plain; charset=utf-8')
        : await api('PUT', deckUrl('/design'), state.design);
      if (name === state.name) state.mtime = r.mtime;
    } catch (e) {
      state.dirty[kind] = true;
      state.saving--;
      setStatus('error', '保存に失敗: ' + e.message);
      return;
    }
    state.saving--;
    if (!state.saving && !state.dirty.md && !state.dirty.design) setStatus('saved');
  }
  const flushSave = () => Promise.all([save('md'), save('design')]);

  // 外部エディタ（VS Code など）や git 操作でファイルが変わったら取り込む
  async function pollExternalChanges() {
    if (!state.project || document.hidden || state.saving || state.dirty.md || state.dirty.design) return;
    const name = state.name;
    try {
      const stat = await api('GET', deckUrl('/stat'));
      if (name !== state.name || state.saving || state.dirty.md || state.dirty.design) return;
      if (stat.md === state.mtime.md && stat.design === state.mtime.design && stat.css === state.mtime.css) return;
      const d = await api('GET', deckUrl());
      if (name !== state.name || state.dirty.md || state.dirty.design) return;
      state.mtime = d.mtime;
      const changed = d.md !== state.md || JSON.stringify(d.design) !== JSON.stringify(state.design) || d.css !== state.deckCss;
      if (!changed) return;
      state.design = d.design || {};
      state.deckCss = d.css || '';
      if (d.md !== state.md) updateMd(d.md, { from: 'external', save: false, now: true });
      else refresh();
      renderPanel();
      toast('ファイルの変更を読み込みました');
    } catch (e) { /* サーバー停止中などは黙って次回に回す */ }
  }

  // ------------------------------------------------------------------
  // Markdown の更新
  //   エディタ（app.editor = editor-live.js）が本文の持ち主。GUI からの書き換えも
  //   エディタへの変更として流すので、入力と同じ「元に戻す」の履歴に乗る。
  // ------------------------------------------------------------------
  /**
   * GUI 操作などで Markdown 全体を差し替える。
   * @param {string} text
   * @param {Object} [opts]
   *   from:    'api'（GUI 操作）| 'external'（ディスクの変更を取り込み）
   *   history: false なら「元に戻す」の履歴に積まない
   *   now:     true ならプレビューをすぐ描き直す（既定は少し待つ）
   *   save:    false なら保存しない（ディスクから読み込んだとき）
   */
  function updateMd(text, opts) {
    opts = opts || {};
    text = String(text).replace(/\r\n?/g, '\n');
    if (text === state.md) return;
    if (app.editor) app.editor.replaceAll(text, opts); // → エディタの変更通知から applyMd が呼ばれる
    else applyMd(text, opts);
  }

  /** 本文が変わった（エディタでの入力も含む）ときの処理。エディタ以外からは呼ばない */
  function applyMd(text, opts) {
    opts = opts || {};
    state.md = text;
    if (opts.save !== false) markDirty('md');
    app.emit('md', opts);
    if (opts.now) refresh();
    else refreshSoon();
  }

  function undo(redo) {
    if (app.editor) app.editor.undo(redo);
  }

  // ------------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------------
  function currentTheme() {
    const t = state.themes;
    return t[state.design.theme] || t[schema.DEFAULT_THEME] || t[Object.keys(t)[0]] || { id: '', tokens: {}, animation: {}, chrome: {}, css: '' };
  }
  const currentSlide = () => state.parsed.slides[state.current];
  const currentOut = () => state.out.slides[state.current];

  function applyDeck(el, extraClass, scale) {
    for (const a of Array.from(el.attributes)) if (a.name.indexOf('data-') === 0) el.removeAttribute(a.name);
    for (const k in state.out.deckAttrs) el.setAttribute(k, state.out.deckAttrs[k]);
    el.className = 'ks-deck' + (extraClass ? ' ' + extraClass : '');
    el.style.cssText = state.out.deckStyle;
    if (scale) el.style.setProperty('--ks-scale', scale);
  }

  const assetBase = () => '/files/';
  // 上書き保存した画像（図形など）は URL に版番号を付けて、古い表示が残らないようにする
  const assetVersions = {};
  const cleanSrc = (src) => { const s = String(src).split(/[?#]/)[0]; try { return decodeURI(s); } catch (e) { return s; } };
  /** プロジェクト内のファイル（assets/… など）を画面で表示するときの URL */
  function assetUrl(src, fresh) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return src;
    const v = fresh ? Date.now() : assetVersions[cleanSrc(src)];
    const base = desktop ? desktop.fileUrl(src) : assetBase() + src;
    return base + (v ? (base.indexOf('?') >= 0 ? '&' : '?') + 'v=' + v : '');
  }
  function bumpAsset(path) {
    assetVersions[cleanSrc(path)] = Date.now();
    thumbs.forEach((t) => { t.html = null; t.prepared = null; });
    refresh();
  }
  function refresh() {
    if (!state.project) return;
    const theme = currentTheme();
    state.parsed = parse.parseDeck(state.md);
    state.out = render.renderDeck(state.parsed, state.design, theme, { md, resolveAsset: (src) => assetUrl(src) });
    state.current = clamp(state.current, 0, state.out.slides.length - 1);
    const css = (theme.css || '') + '\n' + (state.deckCss || '');
    if ($('#themeCss').textContent !== css) $('#themeCss').textContent = css;
    syncThumbs();
    showMain(false);
    updateBar();
    app.emit('refresh');
  }
  const refreshSoon = debounce(refresh, 120);
  let refreshFrame = 0;
  function refreshNextFrame() {
    cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(refresh);
  }

  function syncThumbs() {
    const out = state.out;
    const film = $('#film');
    const sig = out.deckStyle + JSON.stringify(out.deckAttrs) + $('#themeCss').textContent.length;
    const deckChanged = sig !== state.deckSig;
    state.deckSig = sig;
    while (thumbs.length > out.slides.length) thumbs.pop().wrap.remove();
    out.slides.forEach((s, i) => {
      let t = thumbs[i];
      if (!t) {
        t = { html: null };
        t.stage = h('div', { class: 'ks-stage' });
        t.deck = h('div', { class: 'ks-deck ks-static' }, t.stage);
        t.num = h('span', { class: 'num' }, String(i + 1));
        t.pin = h('span', { class: 'pin', title: 'このスライドには個別のデザイン設定があります' });
        t.wrap = h('button', { class: 'thumb', type: 'button', onclick: () => setCurrent(i) }, t.deck, t.num, t.pin);
        makeDropTarget(t.wrap, () => ({ slide: i }), 'このスライドに画像を追加');
        thumbs.push(t);
        film.append(t.wrap);
        applyDeck(t.deck, 'ks-static', THUMB_WIDTH / out.width);
      } else if (deckChanged) {
        applyDeck(t.deck, 'ks-static', THUMB_WIDTH / out.width);
      }
      if (t.html !== s.html) {
        t.stage.innerHTML = s.html;
        t.html = s.html;
        t.slide = t.stage.firstElementChild;
      }
      if (t.prepared !== s.html + sig) {
        t.prepared = s.html + sig;
        RT.prepareSlide(t.slide, (slide) => {
          const cur = thumbs[state.current];
          if (cur && cur.slide === slide) showMain(false);
        });
      }
      t.wrap.classList.toggle('is-current', i === state.current);
      t.wrap.title = (s.title || '（無題）') + ' — ' + s.id;
      t.pin.hidden = !(state.design.slides && state.design.slides[s.id]);
    });
  }

  let stepTimers = [];
  /** 中央の大きなプレビューに現在のスライドを映す。animate=true なら登場アニメーションを再生 */
  function showMain(animate) {
    const deck = $('#mainDeck');
    const stage = $('#mainStage');
    stepTimers.forEach(clearTimeout);
    stepTimers = [];
    if (!state.out) return;
    applyDeck(deck, animate ? '' : 'ks-noanim');
    fitMain();
    const t = thumbs[state.current];
    stage.innerHTML = '';
    if (!t || !t.slide) return;
    const copy = t.slide.cloneNode(true);
    copy.classList.remove('ks-measuring', 'is-active');
    stage.append(copy);
    RT.reidSvgs(stage);
    const steps = Array.from(copy.querySelectorAll('.ks-step'));
    if (animate) {
      void copy.offsetWidth; // 初期状態を確定させてから is-active を付ける（切り替え効果も再生される）
      copy.classList.add('is-active');
      const dur = Number(state.out.resolved.animation.duration) || 600;
      steps.forEach((el, k) => stepTimers.push(setTimeout(() => el.classList.add('is-shown'), dur + 500 + k * 550)));
    } else {
      copy.classList.add('is-active');
      steps.forEach((el) => el.classList.add('is-shown'));
    }
    app.emit('main', copy);
  }
  function fitMain() {
    if (!state.out) return;
    const host = $('#stageHost');
    $('#mainDeck').style.setProperty('--ks-scale', Math.min(host.clientWidth / state.out.width, host.clientHeight / state.out.height) || 0.1);
    app.emit('fit');
  }

  function updateBar() {
    const out = state.out;
    const s = currentOut();
    $('#count').textContent = state.current + 1 + ' / ' + out.slides.length;
    const label = (id) => (schema.LAYOUTS.find((l) => l[0] === id) || [id, id])[1];
    const sd = (state.design.slides || {})[s.id] || {};
    $('#layoutChip').textContent = 'レイアウト: ' + label(s.layout) + (sd.layout ? '' : '（自動）');
    $('#notesView').classList.toggle('is-empty', !s.notesHtml);
    $('#notesBody').innerHTML = s.notesHtml || 'このスライドにノートはありません（??? の行より後ろに書くと、発表者ビューにだけ表示されます）';
  }

  function setCurrent(index, opts) {
    opts = opts || {};
    index = clamp(index, 0, state.out.slides.length - 1);
    const changed = index !== state.current;
    state.current = index;
    thumbs.forEach((t, i) => t.wrap.classList.toggle('is-current', i === index));
    if (thumbs[index]) thumbs[index].wrap.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    showMain(changed || opts.replay);
    updateBar();
    if (state.tab === 'slide') renderPanel();
    app.emit('current', { index, fromEditor: !!opts.fromEditor });
  }

  // ------------------------------------------------------------------
  // 本文への挿入
  // ------------------------------------------------------------------
  function lineOffset(line) {
    let off = 0;
    const text = state.md;
    for (let i = 0; i < line; i++) {
      const n = text.indexOf('\n', off);
      if (n < 0) return text.length;
      off = n + 1;
    }
    return off;
  }
  /** スライドの本文の末尾（ノートの前）にブロックを足す */
  function insertIntoSlide(index, block) {
    const slide = state.parsed.slides[clamp(index, 0, state.parsed.slides.length - 1)];
    const r = parse.insertBlockAt(state.md, parse.slideBodyRange(slide).end, block);
    updateMd(r.text, { from: 'api', now: true });
    return r;
  }
  function insertAtLine(line, block) {
    const r = parse.insertBlockAt(state.md, line, block);
    updateMd(r.text, { from: 'api', now: true });
    return r;
  }

  const SNIPPETS = {
    slide: '---\n\n## 見出し\n\n- ',
    notes: '???\nここに発表者ノートを書きます',
    columns: '::: columns\n\n### 左の見出し\n\n内容\n\n|||\n\n### 右の見出し\n\n内容\n\n:::',
    mermaid: '```mermaid\nflowchart LR\n  A[はじめる] --> B{判断}\n  B -->|はい| C[実行する]\n  B -->|いいえ| D[見直す]\n  D --> B\n```',
    table: '| 項目 | 内容 |\n| --- | --- |\n| A | 説明 |\n| B | 説明 |',
    code: '```js\nconsole.log("hello");\n```',
  };

  /** スニペットの挿入。どこに入れるかはエディタ（カーソル位置 / 今のスライドの末尾）に任せる */
  function insertSnippet(kind) {
    if (app.editor) app.editor.insert(SNIPPETS[kind], kind);
  }

  /**
   * 大きな写真は、長辺 2560px に縮小して保存する（スマホの写真をそのまま埋め込むと、書き出した HTML が重くなるため）。
   * PNG / GIF / SVG（図・スクリーンショット・アニメーション）はそのまま。
   */
  const MAX_PHOTO = 2560;
  async function shrinkPhoto(file) {
    if (!/^image\/(jpeg|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return file;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = MAX_PHOTO / Math.max(bmp.width, bmp.height);
      if (scale >= 1) { bmp.close(); return file; }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch (e) {
      return file;
    }
  }

  // ------------------------------------------------------------------
  // 画像: アップロードとドロップ
  // ------------------------------------------------------------------
  /** assets/ に新しいファイルとして保存し、slides.md から参照するパスを返す（同名があれば名前をずらす） */
  async function saveAsset(name, blob) {
    const r = await api('POST', deckUrl('/assets?name=' + encodeURIComponent(name)), blob, blob.type || 'application/octet-stream');
    return r.path;
  }
  /** プロジェクト内の既存のファイル（assets/ の画像・図形）を上書きする */
  async function writeProjectFile(path, blob) {
    return api('PUT', deckUrl('/file?path=' + encodeURIComponent(path)), blob, blob.type || 'application/octet-stream');
  }
  /** ブロック（画像など）をエディタのカーソル位置（無ければ今のスライドの末尾）に入れる */
  function insertBlock(text) {
    if (app.editor) app.editor.insert(text, 'image');
    else insertIntoSlide(state.current, text);
  }

  /**
   * 画像を assets/ に保存して Markdown に挿入する。
   * @param {File[]} files
   * @param {Object} [target] { slide: index } そのスライドの末尾 / { line } その行 / なし: エディタのカーソル位置
   */
  async function uploadImages(files, target) {
    const paths = [];
    for (const original of files) {
      if (!/^image\//.test(original.type)) continue;
      const file = await shrinkPhoto(original);
      let name = file.name;
      if (!name || /^image\.\w+$/.test(name)) {
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        name = 'image-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.' + ext;
      }
      try {
        paths.push(await saveAsset(name, file));
      } catch (e) {
        toast('画像を保存できませんでした: ' + e.message, true);
      }
    }
    if (!paths.length) return;
    const block = paths.map((p) => '![](' + encodeURI(p) + ')').join('\n\n');
    if (target && target.slide != null) {
      insertIntoSlide(target.slide, block);
      if (target.slide !== state.current) setCurrent(target.slide);
    } else if (target && target.line != null) {
      insertAtLine(target.line, block);
    } else if (app.editor) {
      app.editor.insert(block, 'image');
    } else {
      insertIntoSlide(state.current, block);
    }
    toast(paths.length + ' 枚の画像を assets/ に保存しました');
  }

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).indexOf('Files') >= 0;
  /**
   * el を画像のドロップ先にする。getTarget(event) は uploadImages の target を返す（null なら受け付けない）
   */
  function makeDropTarget(el, getTarget, label) {
    if (label) el.dataset.dropLabel = label;
    let depth = 0;
    el.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; el.classList.add('is-dropping'); } });
    el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; app.emit('dragover', { el, event: e }); } });
    el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('is-dropping'); });
    el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      el.classList.remove('is-dropping');
      const target = getTarget(e);
      if (target !== null) uploadImages(Array.from(e.dataTransfer.files), target);
    });
  }

  /** ウィンドウのどこにドロップしても、ブラウザが画像を開いて画面が切り替わらないようにする */
  function guardWindowDrop() {
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      uploadImages(Array.from(e.dataTransfer.files), { slide: state.current });
    });
  }

  // ------------------------------------------------------------------
  // 画像の属性の書き換え（サイズ・影など。プレビューやリッチ表示から使う）
  // ------------------------------------------------------------------
  /**
   * 行範囲 [start, end) の index 番目の画像の {…} を書き換える。
   * @param {string} rawSrc  画面側で見えている画像の src（取り違え防止の照合用。null なら照合しない）
   * @param {Function} change attrs を受け取り、新しい attrs を返す。null を返すと画像そのものを消す
   */
  function editImage(range, index, rawSrc, change) {
    const im = parse.findImages(state.md, range.start, range.end)[index];
    if (!im || (rawSrc != null && safeDecode(im.src) !== safeDecode(rawSrc))) {
      toast('画像の書かれている場所を特定できませんでした。Markdown を直接書き換えてください', true);
      return false;
    }
    const attrs = change({ width: im.attrs.width, height: im.attrs.height, classes: im.attrs.classes.slice() });
    let text;
    if (attrs === null) {
      // 画像を消す。行に他に何も無ければ行ごと消す
      const lines = state.md.split('\n');
      const lineStart = lineOffset(im.line);
      const rest = (lines[im.line].slice(0, im.start - lineStart) + lines[im.line].slice(im.end - lineStart)).trim();
      if (!rest) { lines.splice(im.line, 1); text = lines.join('\n').replace(/\n{3,}/g, '\n\n'); }
      else text = state.md.slice(0, im.start) + state.md.slice(im.end);
    } else {
      text = parse.setImageAttrs(state.md, im, attrs);
    }
    updateMd(text, { from: 'api', now: true });
    return true;
  }
  const slideRange = (index) => parse.slideBodyRange(state.parsed.slides[index == null ? state.current : index]);
  const slideImages = (index) => { const r = slideRange(index); return parse.findImages(state.md, r.start, r.end); };

  // ------------------------------------------------------------------
  // デザインの変更
  // ------------------------------------------------------------------
  function designChanged() {
    state.design = render.normalize(state.design);
    markDirty('design');
    refreshNextFrame();
  }
  function themeValue(section, key) {
    const theme = currentTheme();
    const defaults = { tokens: schema.DEFAULT_TOKENS, animation: schema.DEFAULT_ANIMATION, chrome: schema.DEFAULT_CHROME }[section];
    return theme[section] && key in theme[section] ? theme[section][key] : defaults[key];
  }
  /** デッキ全体の設定（section = tokens | animation | chrome）。value が undefined ならテーマの値に戻す */
  function setDeckValue(section, key, value) {
    const d = state.design;
    d[section] = d[section] || {};
    if (value === undefined || String(value) === String(themeValue(section, key))) delete d[section][key];
    else d[section][key] = value;
    designChanged();
  }
  const deckValue = (section, key) => (state.design[section] && key in state.design[section] ? state.design[section][key] : themeValue(section, key));
  const deckOverridden = (section, key) => !!(state.design[section] && key in state.design[section]);

  /** スライド個別の設定。初めて設定するときに slides.md へ ID コメントを書き込んで固定する */
  function setSlideValue(path, value) {
    let slide = currentSlide();
    const empty = value === undefined || value === '';
    if (empty && !(state.design.slides && state.design.slides[slide.id])) return; // 何も設定していないスライドは触らない
    if (!slide.explicitId) {
      const r = parse.pinSlideId(state.md, slide);
      updateMd(r.text, { from: 'api', history: false });
      state.parsed = parse.parseDeck(state.md);
      slide = currentSlide();
    }
    const d = state.design;
    d.slides = d.slides || {};
    let node = (d.slides[slide.id] = d.slides[slide.id] || {});
    for (let i = 0; i < path.length - 1; i++) node = node[path[i]] = node[path[i]] || {};
    if (empty) delete node[path[path.length - 1]];
    else node[path[path.length - 1]] = value;
    designChanged();
  }
  function slideDesign() {
    return (state.design.slides && state.design.slides[currentSlide().id]) || {};
  }

  // ------------------------------------------------------------------
  // デザインパネルの部品
  // ------------------------------------------------------------------
  /**
   * 1 行ぶんの設定項目。
   * @param {Object} o { label, control, overridden, onReset, wide }
   */
  function field(o) {
    const row = h('div', { class: 'field' + (o.overridden ? ' is-overridden' : '') + (o.wide ? ' wide' : '') },
      h('label', null, o.label),
      o.control,
      h('button', { class: 'reset', type: 'button', title: '既定値に戻す', html: ICON_RESET, onclick: () => { o.onReset(); renderPanel(); } }));
    row.markOverridden = (on) => row.classList.toggle('is-overridden', on);
    return row;
  }

  /** 記号 1 つを選ぶ（よく使う記号のボタン + 自由入力） */
  const BULLET_CHARS = ['◆', '◇', '●', '○', '■', '□', '▶', '▸', '★', '✔', '※', '・', '→', '»', '–', '✦'];
  function charControl(value, onChange) {
    const input = h('input', { type: 'text', value: value || '', class: 'char-input', maxlength: 4, spellcheck: false, title: '好きな記号・絵文字を入力できます' });
    const pick = (c) => { input.value = c; grid.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.textContent === c)); onChange(c); };
    const grid = h('div', { class: 'char-grid' }, ...BULLET_CHARS.map((c) => h('button', { type: 'button', class: c === value ? 'is-active' : '', onclick: () => pick(c) }, c)));
    input.addEventListener('change', () => { if (input.value.trim()) pick(input.value.trim()); });
    return h('div', { class: 'stack' }, grid, input);
  }

  function colorControl(value, onInput, allowEmpty, emptyLabel) {
    const swatch = h('label', { class: 'swatch' + (value ? '' : ' is-empty') });
    const picker = h('input', { type: 'color', value: toHex(value) || '#888888' });
    const text = h('input', { type: 'text', value: value || '', placeholder: allowEmpty ? emptyLabel || '（デッキの色）' : '', spellcheck: false });
    const paint = (v) => { swatch.style.background = v || ''; swatch.classList.toggle('is-empty', !v); };
    paint(value);
    picker.addEventListener('input', () => { text.value = picker.value; paint(picker.value); onInput(picker.value); });
    text.addEventListener('change', () => {
      const v = text.value.trim();
      if (v && !CSS.supports('color', v)) { toast('色として読めません: ' + v, true); return; }
      if (v) picker.value = toHex(v);
      paint(v);
      onInput(v || undefined);
    });
    swatch.append(picker);
    return h('div', { class: 'color' }, swatch, text);
  }

  function rangeControl(def, value, onInput, onCommit) {
    const out = h('output', null, String(value));
    const input = h('input', { type: 'range', min: def.min, max: def.max, step: def.step, value });
    input.addEventListener('input', () => { out.textContent = input.value; onInput(Number(input.value)); });
    if (onCommit) input.addEventListener('change', () => onCommit(Number(input.value)));
    return h('div', { class: 'range' }, input, out);
  }

  function selectControl(options, value, onChange) {
    const sel = h('select');
    for (const o of options) sel.append(h('option', { value: o[0], selected: String(o[0]) === String(value) }, o[1]));
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  function fontControl(value, onChange) {
    const preset = schema.FONT_PRESETS.find((f) => f.value === value);
    const options = schema.FONT_PRESETS.map((f) => [f.id, f.label]).concat([['custom', 'カスタム（CSS で指定）…']]);
    const text = h('input', { type: 'text', value, hidden: !!preset, spellcheck: false, placeholder: '"Font Name", sans-serif' });
    const sel = selectControl(options, preset ? preset.id : 'custom', (id) => {
      const p = schema.FONT_PRESETS.find((f) => f.id === id);
      text.hidden = !!p;
      if (p) { text.value = p.value; onChange(p.value); } else text.focus();
    });
    text.addEventListener('change', () => { if (text.value.trim()) onChange(text.value.trim()); });
    return h('div', { class: 'stack' }, sel, text);
  }

  function textControl(value, placeholder, onChange) {
    const input = h('input', { type: 'text', value: value || '', placeholder: placeholder || '', spellcheck: false });
    input.addEventListener('change', () => onChange(input.value.trim()));
    return input;
  }

  function segControl(options, value, onChange) {
    const seg = h('div', { class: 'seg' });
    for (const o of options) {
      seg.append(h('button', {
        type: 'button', class: String(o[0]) === String(value) ? 'is-active' : '', title: o[2] || '',
        onclick: (e) => {
          seg.querySelectorAll('button').forEach((b) => b.classList.remove('is-active'));
          e.currentTarget.classList.add('is-active');
          onChange(o[0]);
        },
      }, o[1]));
    }
    return seg;
  }

  function switchControl(value, onChange) {
    const b = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(!!value) });
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(on));
      onChange(on);
    });
    return b;
  }

  const openGroups = JSON.parse(localStorage.getItem('ks.groups') || '{}');
  const OPEN_BY_DEFAULT = { theme: true, color: true, layout: true, columns: true, images: true, themeNew: true, themeEdit: true, themeShare: true };
  function group(id, title, children, badge) {
    const d = h('details', { class: 'group', open: id in openGroups ? !!openGroups[id] : !!OPEN_BY_DEFAULT[id] },
      h('summary', null, title, badge ? h('span', { class: 'badge' }, String(badge)) : null),
      h('div', { class: 'group-body' }, ...children));
    d.addEventListener('toggle', () => { openGroups[id] = d.open; localStorage.setItem('ks.groups', JSON.stringify(openGroups)); });
    return d;
  }

  /** schema.TOKENS の定義 1 つから入力欄を作る（デッキ全体用） */
  function tokenField(def) {
    const value = deckValue('tokens', def.key);
    let row;
    // 他の項目の表示条件（showIf）になっている項目を変えたら、パネルを描き直して出し入れする
    const controlsOthers = schema.TOKENS.some((t) => t.showIf && def.key in t.showIf);
    const set = (v) => {
      setDeckValue('tokens', def.key, v);
      row.markOverridden(deckOverridden('tokens', def.key));
      if (controlsOthers) renderPanel();
    };
    let control;
    if (def.type === 'color') control = colorControl(value, (v) => set(v === undefined ? undefined : v), def.optional, def.optional ? '（自動）' : '');
    else if (def.type === 'char') control = charControl(value, set);
    else if (def.type === 'number') control = rangeControl(def, value, set);
    else if (def.type === 'font') control = fontControl(value, set);
    else if (def.type === 'select') control = selectControl(def.options, value, set);
    else control = textControl(value, def.placeholder, (v) => set(v || undefined));
    row = field({
      label: def.label, control, wide: def.type === 'css' || def.type === 'font',
      overridden: deckOverridden('tokens', def.key),
      onReset: () => setDeckValue('tokens', def.key, undefined),
    });
    return row;
  }

  function optionField(section, key, def) {
    const value = deckValue(section, key);
    let row;
    const set = (v) => { setDeckValue(section, key, v); row.markOverridden(deckOverridden(section, key)); };
    let control;
    if (def.options) control = selectControl(def.options, value, set);
    else if (def.type === 'number') control = rangeControl(def, value, set);
    else if (def.type === 'bool') control = switchControl(value, set);
    else control = textControl(value, def.placeholder, (v) => set(v));
    row = field({
      label: def.label, control, wide: def.type === 'text',
      overridden: deckOverridden(section, key),
      onReset: () => setDeckValue(section, key, undefined),
    });
    return row;
  }

  // ------------------------------------------------------------------
  // タブ: 全体
  // ------------------------------------------------------------------
  function themeCard(theme) {
    const t = Object.assign({}, schema.DEFAULT_TOKENS, theme.tokens);
    // 背景の指定が var(--ks-accent) などを参照するので、カード自身にもトークンを CSS 変数として持たせる
    const sample = h('div', { class: 'sample', style: render.tokensToStyle(t) + ';background:' + (t.bgTitle || t.bgSlide || t.bg) + ';color:' + t.text + ';font-family:' + t.fontHeading },
      h('b', null, 'Aa あ'),
      h('i', { style: 'background:linear-gradient(90deg,' + t.accent + ',' + t.accent2 + ')' }),
      h('span', { style: 'background:' + t.text }));
    return h('button', {
      type: 'button', class: 'theme-card' + (theme.id === currentTheme().id ? ' is-active' : ''), title: theme.description || theme.name,
      onclick: () => {
        state.design.theme = theme.id;
        designChanged();
        refresh();
        renderPanel();
      },
    }, sample, h('div', { class: 'name' }, theme.name));
  }

  function renderDeckTab(panel) {
    const d = state.design;
    const overrides = Object.keys(d.tokens || {}).length + Object.keys(d.animation || {}).length;
    panel.append(
      group('theme', 'テーマ', [
        ...[['simple', 'シンプル'], ['decorative', '装飾あり']].map(([cat, label]) => {
          const list = Object.values(state.themes).filter((t) => (t.category || 'simple') === cat)
            .sort((a, b) => (a.order || 100) - (b.order || 100) || a.name.localeCompare(b.name));
          return list.length ? h('div', { class: 'theme-section' }, h('div', { class: 'theme-cat' }, label), h('div', { class: 'theme-grid' }, ...list.map(themeCard))) : null;
        }),
        overrides
          ? h('div', { class: 'row-actions' }, h('button', {
              class: 'btn small', type: 'button',
              onclick: () => { delete state.design.tokens; delete state.design.animation; designChanged(); renderPanel(); },
            }, 'テーマの既定に戻す（' + overrides + ' 件の調整を破棄）'))
          : null,
        field({
          label: '画面の比率',
          control: segControl(Object.keys(schema.ASPECTS).map((a) => [a, a]), state.out.resolved.aspect, (v) => { state.design.aspect = v; designChanged(); }),
          overridden: !!d.aspect,
          onReset: () => { delete state.design.aspect; designChanged(); },
        }),
      ])
    );
    const visible = (t) => !t.showIf || Object.keys(t.showIf).every((k) => String(deckValue('tokens', k)) === String(t.showIf[k]));
    for (const g of schema.TOKEN_GROUPS) {
      const defs = schema.TOKENS.filter((t) => t.group === g[0] && visible(t));
      const count = defs.filter((t) => deckOverridden('tokens', t.key)).length;
      const extra = g[0] === 'columns'
        ? [h('p', { class: 'hint' }, '色が空欄ならテーマのアクセント色から自動で決まります。カラムの色は「囲み」が枠線・塗り・カードのときに使われます。スライドごとの変更は「このスライド」タブから（そちらが優先）。')]
        : [];
      panel.append(group(g[0], g[1], defs.map(tokenField).concat(extra), count || null));
    }
    panel.append(
      group('animation', 'アニメーション',
        Object.keys(schema.ANIMATION).map((k) => optionField('animation', k, schema.ANIMATION[k])).concat([
          h('p', { class: 'hint' }, '中央の「アニメーションを再生」で確認できます。スライドごとの変更は「このスライド」タブから。'),
        ]),
        Object.keys(d.animation || {}).length || null),
      group('chrome', 'ページ番号・フッター', Object.keys(schema.CHROME).map((k) => optionField('chrome', k, schema.CHROME[k])))
    );
  }

  // ------------------------------------------------------------------
  // タブ: このスライド
  // ------------------------------------------------------------------
  const LAYOUT_ICONS = {
    title: [[8, 8, 24, 4.5, 'a'], [12, 15, 16, 2, 'm']],
    section: [[5, 7, 7, 1.6, 'a'], [5, 10.5, 22, 4.5, 'm']],
    content: [[5, 4, 16, 3, 'a'], [5, 10, 30, 2, 'm'], [5, 14, 26, 2, 'm'], [5, 18, 28, 2, 'm']],
    center: [[9, 8.5, 22, 2.6, 'm'], [13, 13, 14, 2.6, 'm']],
    columns: [[5, 4, 16, 3, 'a'], [5, 10, 13, 2, 'm'], [5, 14, 13, 2, 'm'], [5, 18, 13, 2, 'm'], [22, 10, 13, 2, 'm'], [22, 14, 13, 2, 'm'], [22, 18, 13, 2, 'm']],
    'image-right': [[5, 5, 12, 3, 'a'], [5, 11, 13, 2, 'm'], [5, 15, 11, 2, 'm'], [22, 0, 18, 24, 'i']],
    'image-left': [[0, 0, 18, 24, 'i'], [22, 5, 12, 3, 'a'], [22, 11, 13, 2, 'm'], [22, 15, 11, 2, 'm']],
    'image-full': [[0, 0, 40, 24, 'i'], [5, 13, 16, 3, 'a'], [5, 18.5, 22, 2, 'm']],
    quote: [[6, 4.5, 4.5, 4.5, 'a'], [6, 11.5, 26, 2.4, 'm'], [6, 16, 20, 2.4, 'm']],
  };
  function layoutIcon(id) {
    const rects = LAYOUT_ICONS[id];
    const inner = rects
      ? rects.map((r) => '<rect x="' + r[0] + '" y="' + r[1] + '" width="' + r[2] + '" height="' + r[3] + '" rx="' + (r[4] === 'i' ? 0 : 0.9) + '" class="' + r[4] + '"/>').join('')
      : '<text x="20" y="15" text-anchor="middle">AUTO</text>';
    return '<svg viewBox="0 0 40 24">' + inner + '</svg>';
  }
  // カラムの囲みの見本（パネルのボタン用）
  const COL_ICONS = {
    '': '<text x="20" y="15" text-anchor="middle">AUTO</text>',
    none: '<rect x="5" y="6" width="13" height="2" class="m"/><rect x="5" y="10" width="11" height="2" class="m"/><rect x="22" y="6" width="13" height="2" class="m"/><rect x="22" y="10" width="11" height="2" class="m"/>',
    outline: '<rect x="4" y="4" width="14.5" height="16" rx="2" class="o"/><rect x="21.5" y="4" width="14.5" height="16" rx="2" class="o2"/>',
    fill: '<rect x="4" y="4" width="14.5" height="16" rx="2" class="a"/><rect x="21.5" y="4" width="14.5" height="16" rx="2" class="i"/>',
    card: '<rect x="4" y="4" width="14.5" height="16" rx="1.5" class="c"/><rect x="4" y="4" width="14.5" height="2" class="a"/><rect x="21.5" y="4" width="14.5" height="16" rx="1.5" class="c"/><rect x="21.5" y="4" width="14.5" height="2" class="i"/>',
  };

  function slideField(label, path, control, wide) {
    const sd = slideDesign();
    let v = sd;
    for (const p of path) v = v == null ? undefined : v[p];
    return field({ label, control, wide, overridden: v !== undefined, onReset: () => setSlideValue(path, undefined) });
  }

  function renderColumnsGroup(panel, out, sd) {
    const tokens = state.out.resolved.tokens;
    const deckStyle = tokens.colStyle || 'none';
    const current = sd.colStyle || '';
    const effective = current || deckStyle;
    const count = Math.max(2, state.parsed.slides[state.current].columns.length);
    const styles = [['', 'デッキ設定'], ['none', 'なし'], ['outline', '枠線'], ['fill', '塗り'], ['card', 'カード']];
    const children = [
      h('div', { class: 'layout-grid cols5' }, ...styles.map((s) => h('button', {
        type: 'button',
        class: 'layout-btn' + (current === s[0] ? ' is-active' : '') + (s[0] === deckStyle && !current ? ' is-detected' : ''),
        title: s[0] === '' ? 'デッキ全体の設定（全体タブ →「カラムの囲み」）に従う' : '',
        html: '<svg viewBox="0 0 40 24">' + COL_ICONS[s[0]] + '</svg><span>' + s[1] + '</span>',
        onclick: () => { setSlideValue(['colStyle'], s[0] || undefined); renderPanel(); },
      }))),
      slideField('並べ方', ['colDir'], segControl([['', '自動'], ['row', '横'], ['column', '縦'], ['grid', '格子']], sd.colDir || '', (v) => { setSlideValue(['colDir'], v || undefined); renderPanel(); })),
      slideField('文字の横位置', ['colAlign'], segControl([['', '全体設定'], ['left', '左'], ['center', '中央']], sd.colAlign || '', (v) => { setSlideValue(['colAlign'], v || undefined); renderPanel(); })),
      slideField('文字の縦位置', ['colValign'], segControl([['', '全体設定'], ['top', '上詰め'], ['center', '中央'], ['bottom', '下詰め']], sd.colValign || '', (v) => { setSlideValue(['colValign'], v || undefined); renderPanel(); })),
    ];
    if (effective !== 'none') {
      const colors = Array.isArray(sd.colColors) ? sd.colColors.slice() : [];
      for (let i = 0; i < count; i++) {
        children.push(field({
          label: 'カラム' + (i + 1) + 'の色',
          control: colorControl(colors[i], (v) => {
            const next = (Array.isArray(slideDesign().colColors) ? slideDesign().colColors.slice() : []);
            while (next.length < count) next.push('');
            next[i] = v || '';
            setSlideValue(['colColors'], next.some(Boolean) ? next : undefined);
          }, true),
          overridden: !!colors[i],
          onReset: () => {
            const next = (Array.isArray(slideDesign().colColors) ? slideDesign().colColors.slice() : []);
            next[i] = '';
            setSlideValue(['colColors'], next.some(Boolean) ? next : undefined);
          },
        }));
      }
      if (effective === 'fill') {
        children.push(slideField('箱の文字色', ['colText'], segControl([['', '自動'], ['light', '白'], ['dark', '黒']], sd.colText || '', (v) => { setSlideValue(['colText'], v || undefined); renderPanel(); })));
      }
      children.push(h('p', { class: 'hint' }, '色が空欄ならテーマのアクセント色。文字色の「自動」は、箱の色の明るさに合わせて白／黒を選びます。'));
    } else {
      children.push(h('p', { class: 'hint' }, 'カラムを枠線や塗りの「箱」にできます。'));
    }
    panel.append(group('columns', 'カラムの囲み', children, current || (sd.colColors ? '色' : null)));
  }

  function renderSlideTab(panel) {
    const slide = currentSlide();
    const out = currentOut();
    const sd = slideDesign();
    const anim = Object.assign({}, state.out.resolved.animation, sd.animation);
    const isImageLayout = out.layout.indexOf('image-') === 0;
    const follow = (def) => [['', 'デッキの設定に従う']].concat(def.options);
    const pick = (path, def) => {
      let v = sd;
      for (const p of path) v = v == null ? undefined : v[p];
      return selectControl(follow(def), v === undefined ? '' : v, (val) => { setSlideValue(path, val || undefined); renderPanel(); });
    };

    panel.append(
      h('div', { class: 'id-chip', title: 'デザイン設定はこの ID でスライドに紐付きます' },
        h('code', null, slide.id),
        h('span', null, slide.explicitId ? 'ID 固定済み' : '見出しから自動'))
    );

    const layouts = [['', '自動']].concat(schema.LAYOUTS);
    panel.append(
      group('layout', 'レイアウト', [
        h('div', { class: 'layout-grid' }, ...layouts.map((l) => h('button', {
          type: 'button',
          class: 'layout-btn' + ((sd.layout || '') === l[0] ? ' is-active' : '') + (l[0] === out.autoLayout ? ' is-detected' : ''),
          disabled: l[0].indexOf('image-') === 0 && !out.hasImage,
          title: l[0].indexOf('image-') === 0 && !out.hasImage ? 'このスライドには画像がありません' : l[0] === out.autoLayout ? '内容から自動で選ばれているレイアウト' : '',
          html: layoutIcon(l[0]) + '<span>' + l[1] + '</span>',
          onclick: () => { setSlideValue(['layout'], l[0] || undefined); refresh(); renderPanel(); },
        }))),
        slideField('横の位置', ['align'], segControl([['', '自動'], ['left', '左'], ['center', '中央']], sd.align || '', (v) => { setSlideValue(['align'], v || undefined); renderPanel(); })),
        slideField('縦の位置', ['valign'], segControl([['', '自動'], ['top', '上'], ['center', '中央']], sd.valign || '', (v) => { setSlideValue(['valign'], v || undefined); renderPanel(); })),
        isImageLayout ? slideField('画像の収め方', ['fit'], segControl([['cover', '全面に敷く'], ['contain', '全体を見せる']], sd.fit || 'cover', (v) => { setSlideValue(['fit'], v === 'cover' ? undefined : v); renderPanel(); })) : null,
        isImageLayout && out.layout !== 'image-full'
          ? slideField('画像の幅 (%)', ['mediaSize'], rangeControl({ min: 20, max: 75, step: 1 }, sd.mediaSize || 46, (v) => setSlideValue(['mediaSize'], v)))
          : null,
        isImageLayout ? h('p', { class: 'hint' }, 'プレビューの画像をクリックすると、ドラッグで幅や表示位置を直接変えられます。') : null,
      ])
    );

    if (out.layout === 'columns') renderColumnsGroup(panel, out, sd);
    if (app.renderImagePanel) app.renderImagePanel(panel, { group, field, rangeControl, segControl });

    panel.append(
      group('slideAnim', 'アニメーション', [
        slideField('切り替え', ['animation', 'transition'], pick(['animation', 'transition'], schema.ANIMATION.transition)),
        slideField('要素の登場', ['animation', 'entrance'], pick(['animation', 'entrance'], schema.ANIMATION.entrance)),
        slideField('段階表示', ['animation', 'build'], pick(['animation', 'build'], schema.ANIMATION.build)),
        h('p', { class: 'hint' }, '現在: ' + [anim.transition, anim.entrance, anim.build].join(' / ')),
      ], Object.keys(sd.animation || {}).length || null)
    );

    const colorDefs = schema.TOKENS.filter((t) => t.perSlide);
    panel.append(
      group('slideColor', 'このスライドだけ色を変える', colorDefs.map((def) => {
        const v = sd.tokens && sd.tokens[def.key];
        return slideField(def.label, ['tokens', def.key], colorControl(v, (val) => setSlideValue(['tokens', def.key], val), true));
      }), Object.keys(sd.tokens || {}).length || null)
    );

    panel.append(
      h('div', { class: 'row-actions', style: 'margin-top:14px' },
        h('button', {
          class: 'btn small danger', type: 'button', disabled: !Object.keys(sd).length,
          onclick: () => { delete state.design.slides[slide.id]; designChanged(); refresh(); renderPanel(); },
        }, 'このスライドの設定をすべて戻す')),
      h('p', { class: 'hint' }, '個別設定を付けると、slides.md に ', h('code', null, '<!-- id: … -->'), ' が自動で入り、見出しを変えても設定が外れなくなります。')
    );
  }

  // ------------------------------------------------------------------
  // タブ: テーマ（作る・保存する）
  // ------------------------------------------------------------------
  function themeSnapshot(base) {
    const r = state.out.resolved;
    return {
      name: base.name,
      description: base.description,
      aspect: state.design.aspect || base.aspect,
      tokens: Object.assign({}, r.tokens),
      animation: Object.assign({}, r.animation),
      chrome: { pageNumber: r.chrome.pageNumber, progress: r.chrome.progress },
      css: base.css || '',
    };
  }
  async function saveTheme(id, data, message) {
    try {
      const saved = await api('PUT', '/api/themes/' + encodeURIComponent(id), data);
      state.themes[saved.id] = saved;
      state.design.theme = saved.id;
      delete state.design.tokens; // 調整内容はテーマ側に移ったので、デッキの上書きは消す
      delete state.design.animation;
      if (state.design.chrome) { delete state.design.chrome.pageNumber; delete state.design.chrome.progress; }
      designChanged();
      refresh();
      renderPanel();
      toast(message);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderThemeTab(panel) {
    const theme = currentTheme();
    const overrides = Object.keys(state.design.tokens || {}).length + Object.keys(state.design.animation || {}).length;

    // ---- 自作テーマの読み込み・書き出し ----
    const bridgeApp = window.kamishibaiApp || null;
    const askPath = (label, def) => { const v = prompt(label, def || ''); return v && v.trim(); };
    async function importTheme(kind) {
      const src = bridgeApp ? await bridgeApp.pickThemeSource(kind) : askPath('読み込むテーマのフォルダ・theme.json・zip のパス');
      if (!src) return;
      let r;
      try {
        r = await api('POST', '/api/themes/import', { path: src });
      } catch (e) {
        if (!/既にあります/.test(e.message)) { toast(e.message, true); return; }
        if (!confirm(e.message + '\n上書きしますか？')) return;
        try { r = await api('POST', '/api/themes/import', { path: src, overwrite: true }); } catch (e2) { toast(e2.message, true); return; }
      }
      state.themes = (await api('GET', '/api/state')).themes;
      renderPanel();
      const names = r.imported.map((t) => '「' + t.name + '」').join('');
      if (r.warnings.length) {
        showInfo('<h2>テーマを読み込みました</h2><p>' + render.esc(names) + ' を読み込みました。「全体」タブのテーマの一覧から選べます。</p>' +
          '<p>次の点は確認してください（読み込みはできています）:</p><ul>' + r.warnings.map((w) => '<li>' + render.esc(w) + '</li>').join('') + '</ul>');
      } else {
        toast('テーマ ' + names + ' を読み込みました。「全体」タブのテーマの一覧から選べます');
      }
    }
    async function exportTheme() {
      const out = bridgeApp ? await bridgeApp.pickThemeExport(theme.id) : askPath('書き出す zip のパス', theme.id + '.zip');
      if (!out) return;
      try {
        const r = await api('POST', '/api/themes/export', { id: theme.id, out });
        toast('テーマ「' + theme.name + '」を書き出しました（' + r.file + '）');
      } catch (e) { toast(e.message, true); }
    }
    panel.append(
      group('themeShare', '自作テーマを読み込む・書き出す', [
        h('p', { class: 'hint' }, 'テーマのフォルダ（theme.json と theme.css）や、それを zip にまとめたものを読み込むと、どのプロジェクトからも選べるようになります。書き方は docs/THEME_REFERENCE.md にあります。'),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn small', type: 'button', onclick: () => importTheme('folder') }, 'フォルダから読み込む…'),
          h('button', { class: 'btn small', type: 'button', onclick: () => importTheme('file') }, 'theme.json / zip を読み込む…')),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn small', type: 'button', title: '使用中のテーマを zip にします。人に渡すと、上の「読み込む」でそのまま使えます', onclick: exportTheme }, '使用中のテーマを zip に書き出す…'),
          window.KSWeb ? '' : h('button', {
            class: 'btn small ghost', type: 'button', title: 'ここにテーマのフォルダを置いても読み込まれます',
            onclick: () => api('POST', '/api/themes/reveal', {}).catch((e) => toast(e.message, true)),
          }, 'テーマのフォルダを開く')),
      ])
    );

    const idInput = h('input', { type: 'text', placeholder: 'テーマID（半角英数字とハイフン）例: my-brand', spellcheck: false });
    const nameInput = h('input', { type: 'text', placeholder: '表示名　例: 自社ブランド' });
    const descInput = h('input', { type: 'text', placeholder: '説明（任意）' });
    panel.append(
      group('themeNew', '新しいテーマとして保存', [
        h('p', { class: 'hint' }, '「全体」タブで色やフォントを調整してから保存すると、いまの見た目がそのまま新しいテーマになります。'),
        h('div', { class: 'stack' }, idInput, nameInput, descInput,
          h('button', {
            class: 'btn primary', type: 'button',
            onclick: () => {
              const id = idInput.value.trim();
              if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) { toast('テーマIDは半角英小文字・数字・ハイフンで入力してください', true); idInput.focus(); return; }
              if (state.themes[id] && !confirm('テーマ「' + id + '」は既にあります。上書きしますか？')) return;
              const data = themeSnapshot(theme);
              data.name = nameInput.value.trim() || id;
              data.description = descInput.value.trim();
              saveTheme(id, data, 'テーマ「' + data.name + '」を保存しました（themes/' + id + '/）');
            },
          }, 'テーマを作成')),
      ])
    );

    const cssArea = h('textarea', { spellcheck: false, placeholder: '/* 例 */\n.ks-deck .ks-layout-title h1 {\n  text-transform: uppercase;\n}', disabled: !theme.editable });
    cssArea.value = theme.css || '';
    cssArea.addEventListener('input', () => {
      theme.css = cssArea.value; // 保存前でもプレビューには即反映
      refreshNextFrame();
    });
    panel.append(
      group('themeEdit', '使用中のテーマ: ' + theme.name, [
        h('p', { class: 'hint' }, theme.description || ''),
        theme.editable
          ? h('div', { class: 'row-actions' }, h('button', {
              class: 'btn small', type: 'button', disabled: !overrides,
              title: overrides ? '' : '「全体」タブで調整した項目があると押せます',
              onclick: () => {
                if (!confirm('テーマ「' + theme.name + '」を、いまの調整内容で上書きします。このテーマを使う他のデッキにも反映されます。')) return;
                saveTheme(theme.id, themeSnapshot(theme), 'テーマ「' + theme.name + '」を更新しました');
              },
            }, 'いまの調整をこのテーマに反映（' + overrides + ' 件）'))
          : h('p', { class: 'hint' }, 'このテーマはツール同梱のため直接は編集できません。上の「新しいテーマとして保存」で複製してください。'),
        h('label', { class: 'hint' }, '追加 CSS（theme.css）— トークンで表現できない装飾を書けます'),
        cssArea,
        theme.editable
          ? h('div', { class: 'row-actions' }, h('button', {
              class: 'btn small', type: 'button',
              onclick: async () => {
                try {
                  const saved = await api('PUT', '/api/themes/' + encodeURIComponent(theme.id), Object.assign({}, theme, { css: cssArea.value }));
                  state.themes[saved.id] = saved;
                  toast('theme.css を保存しました');
                } catch (e) { toast(e.message, true); }
              },
            }, 'CSS を保存'))
          : null,
        h('p', { class: 'hint' }, theme.builtin
          ? 'ツール同梱のテーマです。'
          : '作ったテーマはユーザーのテーマ（Windows では %APPDATA%\\Kamishibai\\themes）に保存され、どのプロジェクトからも使えます。1 ファイル（.kami）に保存すると、使っているテーマも一緒に入ります。'),
      ])
    );
  }

  function renderPanel() {
    const panel = $('#panel');
    const scroll = panel.scrollTop;
    panel.innerHTML = '';
    if (!state.out) return;
    if (state.tab === 'deck') renderDeckTab(panel);
    else if (state.tab === 'slide') renderSlideTab(panel);
    else renderThemeTab(panel);
    panel.scrollTop = scroll;
  }
  function showTab(tab) {
    state.tab = tab;
    $('#tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x.dataset.tab === tab));
    renderPanel();
  }

  // ------------------------------------------------------------------
  // プロジェクトを開く・スタート画面・ファイルメニュー
  //   デスクトップアプリでは window.kamishibaiApp（electron/preload.js）がダイアログを出して開き直す。
  //   ブラウザ版ではスタート画面でパスを入力して開く。
  // ------------------------------------------------------------------
  const bridge = window.kamishibaiApp || null;

  async function loadProject(info) {
    app.emit('beforeOpen');
    const d = await api('GET', '/api/project');
    state.project = info;
    state.name = d.name;
    state.design = d.design || {};
    state.deckCss = d.css || '';
    state.mtime = d.mtime;
    state.current = 0;
    state.deckSig = '';
    const text = String(d.md).replace(/\r\n?/g, '\n');
    if (app.editor) app.editor.load(text); // 新しい文書として読み込む（「元に戻す」の履歴もリセット）
    applyMd(text, { from: 'external', save: false, now: true });
    document.title = d.name + ' — Kamishibai';
    $('#projectName').textContent = d.name;
    $('#projectKind').textContent = info.temporary ? '未保存' : info.kamiFile ? '.kami' : 'フォルダ';
    $('#projectKind').dataset.kind = info.temporary ? 'temp' : info.kamiFile ? 'kami' : 'folder';
    $('#projectPath').textContent = info.temporary
      ? (window.KSWeb ? '保存先はまだありません。「1 ファイル（.kami）として保存」で決めてください。' : '保存先はまだありません。「1 ファイルとして保存」か「フォルダとして保存」で決めてください。')
      : window.KSWeb ? (window.KSDesktop.describe ? window.KSDesktop.describe(info.kamiFile) : info.kamiFile) : info.kamiFile || info.dir;
    document.body.classList.remove('is-start');
    $('#startScreen').hidden = true;
    renderPanel();
    state.tempEdited = false;
    setStatus(info.temporary ? 'temp' : 'saved', info.temporary ? '未保存（保存先を選んでください）' : undefined);
    app.emit('open');
  }

  /** ブラウザ版: サーバーに開く / 作るを頼んで、画面を読み込み直す */
  async function browserAction(endpoint, body) {
    try {
      await api('POST', '/api/' + endpoint, body || {});
      location.reload();
    } catch (e) { toast(e.message, true); }
  }

  /** ファイルメニュー・スタート画面の操作 */
  async function fileAction(name) {
    $('#fileMenu').hidden = true;
    await flushSave();
    if (bridge) {
      const map = { newFolder: () => bridge.newProject('folder'), newKami: () => bridge.newProject('kami') };
      const fn = map[name] || bridge[name];
      if (fn) await fn();
      return;
    }
    // ブラウザ版はダイアログが無いので、パスを入力してもらう
    const ask = (label, def) => { const v = prompt(label, def || ''); return v && v.trim(); };
    // 保存先の無いプロジェクト（サンプルなど）を書き換えたまま離れるときの確認（アプリは tauri-host.js の confirmLeave）
    if (/^(close|openSample|openFolder|openFile|newFolder|newKami)$/.test(name) && state.project && state.project.temporary && state.tempEdited &&
      !confirm('「' + state.project.name.replace(/（.*）/, '') + '」はまだ保存していません。保存しないで続けますか？\n（保存するときは、ファイルメニューの「1 ファイルとして保存」などを使ってください）')) return;
    if (name === 'close') return browserAction('close');
    if (name === 'openSample') return browserAction('sample');
    if (name === 'reveal' && state.project) return api('POST', '/api/reveal', { path: state.project.kamiFile || state.project.dir }).catch((e) => toast(e.message, true));
    if (name === 'openFolder' || name === 'openFile') { const p = ask('開くフォルダか .kami のパス'); if (p) browserAction('open', { path: p }); return; }
    if (name === 'newFolder' || name === 'newKami') {
      const p = ask(name === 'newKami' ? '作る .kami ファイルのパス（例: C:\\資料\\発表.kami）' : '作るフォルダのパス（空のフォルダか、まだ無いフォルダ）');
      if (p) browserAction('new', { path: p, kind: name === 'newKami' ? 'kami' : 'folder' });
      return;
    }
    if (name === 'saveAsKami' || name === 'saveAsFolder') {
      const p = ask(name === 'saveAsKami' ? '保存する .kami ファイルのパス' : '保存するフォルダのパス（空のフォルダ）');
      if (p) browserAction('save-as', { path: p, kind: name === 'saveAsKami' ? 'kami' : 'folder' });
    }
  }

  function showStart(s) {
    document.body.classList.add('is-start');
    $('#startScreen').hidden = false;
    $('#projectName').textContent = 'Kamishibai';
    $('#projectKind').textContent = '';
    document.title = 'Kamishibai';
    const actionsEl = $('#startActions');
    actionsEl.innerHTML = '';
    const card = (icon, title, sub, onclick, primary) => h('button', { type: 'button', class: 'start-action' + (primary ? ' is-primary' : ''), onclick, html: svg(icon) + '<b>' + render.esc(title) + '</b><small>' + render.esc(sub) + '</small>' });
    if (bridge && window.KSWeb) {
      // Web 版は .kami だけ（フォルダの形は扱わない）
      actionsEl.append(
        card('<path d="M6 3.5h8l4 4v13H6z"/><path d="M12 11v5M9.5 13.5h5"/>', '新規作成', '.kami — 画像も含めて 1 ファイル', () => fileAction('newKami'), true),
        card('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/>', 'ファイルを開く', '.kami ファイル', () => fileAction('openFile')),
      );
    } else if (bridge) {
      actionsEl.append(
        card('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>', '新規作成（フォルダ）', 'git で管理しやすい形', () => fileAction('newFolder'), true),
        card('<path d="M6 3.5h8l4 4v13H6z"/><path d="M12 11v5M9.5 13.5h5"/>', '新規作成（1 ファイル）', '.kami — 画像も含めて 1 ファイル', () => fileAction('newKami')),
        card('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>', 'フォルダを開く', 'slides.md のあるフォルダ', () => fileAction('openFolder')),
        card('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/>', 'ファイルを開く', '.kami ファイル', () => fileAction('openFile')),
      );
    } else {
      $('#startPath').hidden = false;
    }
    actionsEl.append(card('<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>', 'サンプルを開く', '機能紹介のデッキ（保存先はあとで決める）', () => fileAction('openSample')));
    const recent = $('#startRecent');
    recent.innerHTML = '';
    if (s.recent && s.recent.length) {
      recent.append(h('div', { class: 'start-label' }, '最近使ったもの'));
      for (const r of s.recent) {
        recent.append(h('button', {
          type: 'button', class: 'start-recent-item', title: r.label || r.path,
          onclick: () => (bridge ? bridge.openPath(r.path) : browserAction('open', { path: r.path })),
        }, h('span', { class: 'kind' }, r.kind === 'kami' ? '.kami' : 'フォルダ'), h('b', null, r.name), h('small', null, r.label || r.path)));
      }
    }
  }

  function initFileMenu() {
    const menu = $('#fileMenu');
    // Web 版は .kami だけ。フォルダの項目と、それで空になった区切り線を消す
    if (window.KSWeb) {
      menu.querySelectorAll('[data-file="newFolder"], [data-file="openFolder"], [data-file="saveAsFolder"]').forEach((b) => b.remove());
      menu.querySelectorAll('.menu-sep').forEach((s) => { const n = s.nextElementSibling; if (!n || n.classList.contains('menu-sep')) s.remove(); });
    }
    $('#projectBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      // 開いていないときはメニューを出さず、スタート画面のまま
      if (!state.project) return;
      menu.hidden = !menu.hidden;
      menu.querySelector('[data-file="reveal"]').hidden = !!state.project.temporary || !!window.KSWeb;
    });
    document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-file]');
      if (b) fileAction(b.dataset.file);
    });
    $('#btnOpenPath').addEventListener('click', () => { const p = $('#pathInput').value.trim(); if (p) browserAction('open', { path: p }); });
    $('#btnNewPath').addEventListener('click', () => { const p = $('#pathInput').value.trim(); if (p) browserAction('new', { path: p }); });
    $('#pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnOpenPath').click(); });
    $('#status').addEventListener('click', () => { if (state.project && state.project.temporary) fileAction('saveAsKami'); });
  }

  // ------------------------------------------------------------------
  // 書き出し
  // ------------------------------------------------------------------
  function showInfo(html) {
    $('#infoBody').innerHTML = html;
    $('#dlgInfo').showModal();
  }
  function exportDialog(title, r) {
    const esc = render.esc;
    if (window.KSWeb) {
      // Web 版: 印刷ダイアログ（PDF）/ ダウンロード / 選んだファイルに保存
      const msg = r.print
        ? '別のウィンドウで印刷画面を開きました。送信先（プリンター）で「PDF に保存」を選ぶと PDF になります。'
        : r.downloaded ? 'ダウンロードしました（' + kb(r.bytes) + '）。' : '選んだファイルに保存しました（' + kb(r.bytes) + '）。';
      showInfo(
        '<h2>' + esc(r.print ? 'PDF を作る' : title) + '</h2><p>' + esc(msg) + '</p>' +
        (r.warnings.length ? '<ul>' + r.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>' : '') +
        (r.file && /\.html$/i.test(r.file) ? '<div class="dialog-actions" style="justify-content:flex-start;margin-top:0"><button class="btn" type="button" data-open-file="' + esc(r.file) + '">開く</button></div>' : '')
      );
      return;
    }
    const note = /\.pdf$/i.test(r.file) ? '' : r.files ? '画像などは隣の「_files」フォルダに置きました。HTML と一緒に持ち運んでください。' : 'このファイルだけで完結しているので、そのまま持ち出せます。';
    showInfo(
      '<h2>' + esc(title) + '</h2><p>次の場所に保存しました（' + kb(r.bytes) + '）。' + note + '</p>' +
      '<code class="path">' + esc(r.file) + '</code>' +
      (r.warnings.length ? '<ul>' + r.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>' : '') +
      '<div class="dialog-actions" style="justify-content:flex-start;margin-top:0">' +
      (bridge ? '<button class="btn" type="button" data-open-file="' + esc(r.file) + '">開く</button>' : '') +
      '<button class="btn" type="button" data-reveal="' + esc(r.file) + '">フォルダを表示</button></div>'
    );
  }

  const EXPORTS = {
    'slides-html': { label: 'HTML を書き出しました', kind: 'slides', format: 'html' },
    'slides-pdf': { label: 'PDF を書き出しました', kind: 'slides', format: 'pdf' },
    'doc-html': { label: '資料（HTML）を書き出しました', kind: 'doc', format: 'html' },
    'doc-pdf': { label: '資料（PDF）を書き出しました', kind: 'doc', format: 'pdf' },
    'slides-pptx': { label: 'PowerPoint を書き出しました', kind: 'slides', format: 'pptx', office: true },
    'slides-odp': { label: 'OpenDocument プレゼンテーションを書き出しました', kind: 'slides', format: 'odp', office: true },
    'doc-docx': { label: 'Word 文書を書き出しました', kind: 'doc', format: 'docx', office: true },
    'doc-odt': { label: 'OpenDocument テキストを書き出しました', kind: 'doc', format: 'odt', office: true },
  };

  /** 画面で作ったファイル（Word・PowerPoint など）を書き出し先に保存する。out が無ければ既定の場所 */
  async function saveExport(o) {
    const q = '?kind=' + o.kind + '&format=' + encodeURIComponent(o.format) + (o.out ? '&out=' + encodeURIComponent(o.out) : '');
    return api('POST', '/api/project/export-file' + q, o.data, o.data.type || 'application/octet-stream');
  }
  const docNotes = () => localStorage.getItem('ks.docNotes') === '1';
  const embedImages = () => localStorage.getItem('ks.embed') !== '0';

  async function runExport(id) {
    const job = EXPORTS[id];
    const button = $('#btnExportMenu');
    closeMenu();
    await flushSave();
    // デスクトップアプリでは書き出し先をダイアログで選ぶ（ブラウザ版は既定の場所）
    let out = null;
    if (bridge) {
      out = await bridge.chooseExportPath({ kind: job.kind, format: job.format });
      if (!out) return;
    }
    button.disabled = true;
    try {
      if (job.format === 'pdf' || job.office) toast(job.format.toUpperCase() + ' を作成しています…（数秒かかります）');
      const r = job.office
        ? await app.exportOffice(job.format, out)
        : await api('POST', '/api/project/export', { kind: job.kind, format: job.format, notes: docNotes(), embed: embedImages(), out });
      exportDialog(job.label, r);
    } catch (e) {
      showInfo('<h2>書き出せませんでした</h2><p>' + render.esc(e.message) + '</p>');
    }
    button.disabled = false;
  }

  function openWindow(url) {
    // ポップアップブロックを避けるため、先にウィンドウを開いてから保存を待つ
    const w = window.open('', '_blank');
    flushSave().then(() => { if (w) w.location = url; else location.href = url; });
  }
  const present = () => {
    if (!state.project) return;
    if (desktop) flushSave().then(() => desktop.present(state.current)).catch((e) => toast(e.message, true));
    else openWindow('/present#' + (state.current + 1));
  };

  function closeMenu() { $('#exportMenu').hidden = true; }
  function initExportMenu() {
    const menu = $('#exportMenu');
    const notes = $('#docNotes');
    notes.checked = docNotes();
    notes.addEventListener('change', () => localStorage.setItem('ks.docNotes', notes.checked ? '1' : '0'));
    const embed = $('#embedImages');
    embed.checked = embedImages();
    embed.addEventListener('change', () => localStorage.setItem('ks.embed', embed.checked ? '1' : '0'));
    $('#btnExportMenu').addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.project) menu.hidden = !menu.hidden;
    });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-export]');
      if (item) runExport(item.dataset.export);
      const preview = e.target.closest('[data-doc-preview]');
      if (preview) {
        closeMenu();
        if (desktop) flushSave().then(() => desktop.docPreview(docNotes())).catch((err) => toast(err.message, true));
        else openWindow('/doc' + (docNotes() ? '?notes=1' : ''));
      }
    });
    document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
    $('#dlgInfo').addEventListener('click', (e) => {
      const b = e.target.closest('[data-reveal]');
      if (b) api('POST', '/api/reveal', { path: b.dataset.reveal }).catch((err) => toast(err.message, true));
      const o = e.target.closest('[data-open-file]');
      if (o && bridge) bridge.openExported(o.dataset.openFile);
    });
  }

  /** エディタの表示: live（書きながら見た目に反映）/ source（記号をすべて表示） */
  function setMode(mode) {
    state.mode = mode === 'source' ? 'source' : 'live';
    localStorage.setItem('ks.editorMode', state.mode);
    document.querySelectorAll('#modeSeg [data-mode]').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === state.mode));
    app.emit('mode', state.mode);
  }

  /** 編集パネルのタブ: write（原稿）/ design（デザイン） */
  function setSide(side) {
    state.side = side === 'design' ? 'design' : 'write';
    localStorage.setItem('ks.side', state.side);
    document.querySelectorAll('#sideTabs [data-side]').forEach((b) => b.classList.toggle('is-active', b.dataset.side === state.side));
    $('#pageWrite').hidden = state.side !== 'write';
    $('#pageDesign').hidden = state.side !== 'design';
    if (state.side === 'design') renderPanel();
    app.emit('side', state.side);
  }

  /** プレビューと編集パネルの左右を入れ替える（left = 編集パネルが左） */
  function setLayout(flip) {
    $('#panes').dataset.side = flip ? 'left' : 'right';
    localStorage.setItem('ks.sideLeft', flip ? '1' : '0');
  }

  function initTopbar() {
    $('#btnPresent').addEventListener('click', present);
    $('#btnPrev').addEventListener('click', () => setCurrent(state.current - 1));
    $('#btnNext').addEventListener('click', () => setCurrent(state.current + 1));
    $('#btnReplay').addEventListener('click', () => showMain(true));
    initExportMenu();

    // 配色・文字の大きさなどのアプリの設定は settings.js
    $('#btnScheme').addEventListener('click', () => app.settings.toggleScheme());
    $('#btnSettings').addEventListener('click', () => app.settings.open());

    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      $('#panel').scrollTop = 0;
      showTab(b.dataset.tab);
    });

    document.querySelectorAll('dialog').forEach((dlg) => {
      dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
    });
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '') || (document.activeElement && document.activeElement.isContentEditable);
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave().then(() => toast('保存しました')); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); present(); }
      else if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
      else if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(true); }
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty.md || state.dirty.design) { flushSave(); e.preventDefault(); e.returnValue = ''; }
    });
  }

  function initSplitter() {
    const panes = $('#panes');
    const splitter = $('#splitter');
    const saved = localStorage.getItem('ks.sideWidth');
    if (saved) panes.style.setProperty('--side-w', saved);
    splitter.addEventListener('pointerdown', (e) => {
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('is-dragging');
      const move = (ev) => {
        // 編集パネルの幅。パネルが右にあるときは右端から、左にあるときは左端から測る
        const r = panes.getBoundingClientRect();
        const left = panes.dataset.side === 'left';
        const w = clamp(left ? ev.clientX - r.left : r.right - ev.clientX, 360, r.width - 420) + 'px';
        panes.style.setProperty('--side-w', w);
        localStorage.setItem('ks.sideWidth', w);
      };
      const up = () => {
        splitter.classList.remove('is-dragging');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
  }

  /** スライドの一覧（下の横並び）は、マウスホイールの縦の回転で横にスクロールする */
  function initFilmWheel() {
    const film = $('#film');
    film.addEventListener('wheel', (e) => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // タッチパッドの横スクロールはそのまま
      if (film.scrollWidth <= film.clientWidth) return;
      e.preventDefault();
      // 1 行（deltaMode 1）・1 ページ（2）単位の回転も px にそろえる
      const step = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? film.clientWidth : 1;
      film.scrollBy({ left: e.deltaY * step, behavior: Math.abs(e.deltaY * step) > 60 ? 'smooth' : 'auto' });
    }, { passive: false });
  }

  function initWritePage() {
    $('#filePicker').addEventListener('change', (e) => { uploadImages(Array.from(e.target.files)); e.target.value = ''; });
    const toolbar = $('#toolbar');
    // ボタンを押してもテキスト入力からフォーカスが外れないようにする（カーソル位置に挿入するため）
    toolbar.addEventListener('mousedown', (e) => { if (e.target.closest('[data-insert]')) e.preventDefault(); });
    toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-insert]');
      if (!b) return;
      if (b.dataset.insert === 'image') $('#filePicker').click();
      else if (b.dataset.insert === 'diagram') { if (app.diagram) app.diagram.open({}); }
      else insertSnippet(b.dataset.insert);
    });
    // 書式ボタン。押してもエディタのカーソル（選択範囲）を失わないよう mousedown を止める
    const fmt = $('#formatBar');
    fmt.addEventListener('mousedown', (e) => { if (e.target.closest('[data-fmt]')) e.preventDefault(); });
    fmt.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fmt]');
      if (b && app.editor) app.editor.format(b.dataset.fmt);
    });
    $('#fmtBlock').addEventListener('change', (e) => {
      if (e.target.value && app.editor) app.editor.format(e.target.value);
      e.target.value = '';
    });
    $('#modeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) setMode(b.dataset.mode);
    });
    $('#sideTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-side]');
      if (b) setSide(b.dataset.side);
    });
    $('#btnSwap').addEventListener('click', () => setLayout($('#panes').dataset.side !== 'left'));
  }

  // ------------------------------------------------------------------
  // 他のファイルに公開する関数
  // ------------------------------------------------------------------
  Object.assign(app, {
    h, svg, clamp, toast, api, deckUrl, assetBase, assetUrl, bumpAsset, saveAsset, writeProjectFile, insertBlock, safeDecode,
    refresh, setCurrent, showMain, renderPanel, showTab, currentSlide, currentOut,
    updateMd, applyMd, insertIntoSlide, insertAtLine, uploadImages, makeDropTarget, present,
    editImage, slideRange, slideImages, setSlideValue, slideDesign, designChanged, setSide, setMode, setLayout,
    currentTheme, saveExport,
    /** 描画済みのスライド（サムネイルの中の .ks-slide）。PowerPoint などへの書き出しが使う */
    slideElements: () => thumbs.map((t) => t.slide),
    async start() {
      initWritePage();
      initTopbar();
      initFileMenu();
      initSplitter();
      guardWindowDrop();
      initFilmWheel();
      setLayout(localStorage.getItem('ks.sideLeft') === '1');
      setSide(state.side);
      setMode(state.mode);
      new ResizeObserver(fitMain).observe($('#stageHost'));
      // mermaid は大きいので後から読み込まれる。届いたら図を描き直す
      window.addEventListener('ks-mermaid-ready', () => {
        thumbs.forEach((t) => { t.prepared = null; });
        if (state.out) syncThumbs();
        app.emit('mermaid');
      });
      setInterval(pollExternalChanges, 2500);
      if (desktop) await desktop.startup; // 起動時に渡された .kami を開き終えてから
      await app.restart();
    },
    /** 開いているプロジェクトを読み込み直す（無ければスタート画面）。アプリでファイルを開き直したときにも呼ばれる */
    async restart() {
      const s = await api('GET', '/api/state');
      state.themes = s.themes;
      $('#fileMenu').hidden = true;
      if (s.project) await loadProject(s.project);
      else { state.project = null; showStart(s); }
    },
    flushSave,
  });
})();
