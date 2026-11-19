/*
 * runtime.js — ブラウザ上でスライドを「動かす」部分。依存ライブラリなし。
 *
 * 2 つの使われ方をする:
 *   1. 書き出した HTML の中で Kamishibai.start() が呼ばれ、スライドショーとして動く
 *   2. エディタが prepareSlide() などを部品として使い、プレビューを本番と同じ見た目にする
 *
 * 公開 API は末尾の Object.assign を参照。
 */
(function (root) {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------
  // アニメーションの下ごしらえ
  //   .ks-anim … スライド表示時に --i の順で登場
  //   .ks-step … data-build="items" のとき、クリックごとに 1 つずつ表示
  // ------------------------------------------------------------------
  function enhanceSlide(slide) {
    slide.querySelectorAll('.ks-anim, .ks-step').forEach((el) => {
      el.classList.remove('ks-anim', 'ks-step', 'is-shown');
      el.style.removeProperty('--i');
    });
    const fixed = []; // 見出し・画像など、常に最初から出すもの
    const flow = []; // 本文の各ブロック（リストは項目単位）
    const collect = (container) => {
      for (const el of container.children) {
        if (el.tagName === 'UL' || el.tagName === 'OL') flow.push.apply(flow, el.children);
        // カラムは 1 列（箱）ごとに 1 つ。段階表示ではクリックごとに 1 列ずつ出す（箱の中身だけが後から出ると、空の箱が先に見えてしまう）
        else if (el.classList.contains('ks-cols')) flow.push.apply(flow, el.children);
        else if (el.classList.contains('ks-cols-pre') || el.classList.contains('ks-cols-post')) collect(el);
        else flow.push(el);
      }
    };
    const head = slide.querySelector('.ks-head');
    const body = slide.querySelector('.ks-body');
    const media = slide.querySelector('.ks-media');
    if (head) fixed.push(head);
    if (media) fixed.push(media);
    if (body) collect(body);

    const build = slide.dataset.build === 'items';
    // 段階表示でも、スライドが空で始まらないよう最低 1 つは最初から出す
    if (build && !fixed.length && flow.length) fixed.push(flow.shift());
    const entering = build ? fixed : fixed.concat(flow);
    // 要素が多いスライドでも登場に時間がかかりすぎないよう、間隔を詰める
    const squeeze = entering.length > 9 ? 9 / entering.length : 1;
    entering.forEach((el, i) => {
      el.classList.add('ks-anim');
      el.style.setProperty('--i', (i * squeeze).toFixed(2));
    });
    if (build) flow.forEach((el) => el.classList.add('ks-step'));
  }

  // ------------------------------------------------------------------
  // はみ出したら文字を自動で縮める（--ks-fit）
  // ------------------------------------------------------------------
  function overflows(slide, inner) {
    if (inner.scrollHeight > inner.clientHeight + 1 || inner.scrollWidth > inner.clientWidth + 1) return true;
    for (const el of slide.querySelectorAll('pre.ks-code')) if (el.scrollWidth > el.clientWidth + 1) return true;
    return false;
  }

  // カラムの中身があふれたら、カラムの文字だけを縮める（--ks-col-fit。全カラムで同じ倍率にしてそろえる）
  function columnsOverflow(cols) {
    for (const col of cols.children) {
      if (col.scrollHeight > col.clientHeight + 1 || col.scrollWidth > col.clientWidth + 1) return true;
    }
    return false;
  }
  function fitColumns(slide) {
    slide.querySelectorAll('.ks-cols').forEach((cols) => {
      cols.style.removeProperty('--ks-col-fit');
      if (!cols.clientHeight || !columnsOverflow(cols)) return;
      let fit = 1;
      while (columnsOverflow(cols) && fit > 0.55) {
        fit = Math.round((fit - 0.05) * 100) / 100;
        cols.style.setProperty('--ks-col-fit', fit);
      }
    });
  }

  function fitSlide(slide) {
    const inner = slide.querySelector('.ks-inner');
    if (!inner || !inner.clientHeight) return;
    const before = slide.style.getPropertyValue('--ks-fit');
    slide.style.removeProperty('--ks-fit');
    // 登場アニメーション中の transform を誤検出しないよう、計測中だけ止める
    slide.classList.add('ks-measuring');
    fitColumns(slide);
    if (!overflows(slide, inner)) { slide.classList.remove('ks-measuring'); return; }
    let fit = 1;
    while (overflows(slide, inner) && fit > 0.5) {
      fit = Math.round((fit - 0.05) * 100) / 100;
      slide.style.setProperty('--ks-fit', fit);
    }
    if (fit === 1 && before) slide.style.removeProperty('--ks-fit');
    slide.classList.remove('ks-measuring');
  }

  function watchImages(slide, onChange) {
    slide.querySelectorAll('img').forEach((img) => {
      if (img.complete) return;
      img.addEventListener('load', () => { fitSlide(slide); if (onChange) onChange(slide); }, { once: true });
    });
  }

  // ------------------------------------------------------------------
  // mermaid（図）: テーマの色に合わせて描画する
  // ------------------------------------------------------------------
  const colorCache = new Map();
  let colorCtx = null;
  function rgb(color) {
    if (colorCache.has(color)) return colorCache.get(color);
    if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    colorCtx.clearRect(0, 0, 1, 1);
    colorCtx.fillStyle = '#000';
    colorCtx.fillStyle = color || '#000';
    colorCtx.fillRect(0, 0, 1, 1);
    const d = colorCtx.getImageData(0, 0, 1, 1).data;
    const out = [d[0], d[1], d[2]];
    colorCache.set(color, out);
    return out;
  }
  const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const luminance = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

  function mermaidVars(scope) {
    const cs = getComputedStyle(scope);
    const get = (name) => cs.getPropertyValue(name).trim();
    const bg = rgb(get('--ks-bg'));
    const text = rgb(get('--ks-text'));
    const accent = rgb(get('--ks-accent'));
    const accent2 = rgb(get('--ks-accent2'));
    const node = hex(mix(accent, bg, 0.16));
    const line = hex(mix(text, bg, 0.55));
    const t = hex(text);
    return {
      darkMode: luminance(bg) < 0.5,
      background: hex(bg),
      fontFamily: get('--ks-font-body') || 'sans-serif',
      fontSize: '16px',
      primaryColor: node,
      primaryTextColor: t,
      primaryBorderColor: hex(accent),
      secondaryColor: hex(mix(accent2, bg, 0.16)),
      secondaryTextColor: t,
      secondaryBorderColor: hex(accent2),
      tertiaryColor: hex(mix(text, bg, 0.06)),
      tertiaryTextColor: t,
      tertiaryBorderColor: hex(mix(text, bg, 0.22)),
      lineColor: line,
      textColor: t,
      mainBkg: node,
      nodeBorder: hex(accent),
      clusterBkg: hex(mix(text, bg, 0.05)),
      clusterBorder: hex(mix(text, bg, 0.22)),
      edgeLabelBackground: hex(bg),
      titleColor: t,
      noteBkgColor: hex(mix(accent2, bg, 0.18)),
      noteTextColor: t,
      noteBorderColor: hex(accent2),
    };
  }

  let mermaidSeq = 0;
  const mermaidCache = new Map(); // key → { id, svg }
  let mermaidQueue = Promise.resolve();

  // 同じ SVG を複数箇所に置くと id が重複し、矢印（marker）の参照が壊れるので振り直す
  function reidSvgs(rootEl) {
    rootEl.querySelectorAll('.ks-mermaid-out').forEach((out) => {
      const svg = out.querySelector('svg[id]');
      if (!svg) return;
      out.innerHTML = out.innerHTML.split(svg.id).join('ks-mmd-' + ++mermaidSeq);
    });
  }

  function sizeMermaid(out, scope) {
    const svg = out.querySelector('svg');
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal || !svg.viewBox.baseVal.width) return;
    const vb = svg.viewBox.baseVal;
    const base = parseFloat(getComputedStyle(scope).getPropertyValue('--ks-base-size')) || 28;
    const zoom = (base * 0.8) / 16; // 図の文字を本文の 8 割ほどの大きさに
    svg.style.maxWidth = '';
    svg.setAttribute('width', Math.round(vb.width * zoom));
    svg.setAttribute('height', Math.round(vb.height * zoom));
  }

  async function renderMermaidNow(rootEl) {
    const mermaid = root.mermaid;
    if (!mermaid) return;
    const nodes = rootEl.matches && rootEl.matches('.ks-mermaid') ? [rootEl] : Array.from(rootEl.querySelectorAll('.ks-mermaid'));
    for (const el of nodes) {
      const srcEl = el.querySelector('.ks-mermaid-src');
      const out = el.querySelector('.ks-mermaid-out');
      if (!srcEl || !out || !el.isConnected) continue;
      const scope = el.closest('.ks-slide') || el;
      const vars = mermaidVars(scope);
      const code = srcEl.textContent;
      const key = JSON.stringify(vars) + '\n' + code;
      if (el.dataset.ksKey === key) continue;
      let hit = mermaidCache.get(key);
      if (!hit) {
        const id = 'ks-mmd-' + ++mermaidSeq;
        let svg;
        try {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            theme: 'base',
            themeVariables: vars,
            fontFamily: vars.fontFamily,
            flowchart: { curve: 'basis', padding: 14, useMaxWidth: true },
          });
          svg = (await mermaid.render(id, code)).svg;
        } catch (e) {
          svg = '<pre class="ks-mermaid-error">図を描画できません（mermaid 記法を確認してください）\n' + esc((e && e.message) || e) + '</pre>';
          for (const leftover of [document.getElementById(id), document.getElementById('d' + id)]) if (leftover) leftover.remove();
        }
        hit = { id, svg };
        mermaidCache.set(key, hit);
      }
      out.innerHTML = hit.svg.split(hit.id).join('ks-mmd-' + ++mermaidSeq);
      el.dataset.ksKey = key;
      sizeMermaid(out, scope);
    }
  }

  /**
   * 書き出し用: 文字も SVG で描いた mermaid の図（SVG の文字列）を返す。
   * 画面用の図は文字を HTML で描く（foreignObject）ため、画像（PNG）にできない。PowerPoint などへ書き出すときはこちらを使う。
   * @param {string} code mermaid の記法
   * @param {Element} scope 色を読む要素（スライドなど）
   */
  function mermaidPlainSvg(code, scope) {
    const job = mermaidQueue.then(async () => {
      const mermaid = root.mermaid;
      if (!mermaid) return null;
      const vars = mermaidVars(scope);
      const id = 'ks-mmd-x' + ++mermaidSeq;
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: 'base',
          themeVariables: vars,
          fontFamily: vars.fontFamily,
          htmlLabels: false,
          flowchart: { curve: 'basis', padding: 14, useMaxWidth: false, htmlLabels: false },
        });
        return (await mermaid.render(id, code)).svg;
      } catch (e) {
        for (const leftover of [document.getElementById(id), document.getElementById('d' + id)]) if (leftover) leftover.remove();
        return null;
      }
    });
    mermaidQueue = job.catch(() => null);
    return job;
  }

  /** rootEl 以下の mermaid ブロックを描画する（呼び出しは直列化される） */
  function renderMermaid(rootEl) {
    mermaidQueue = mermaidQueue.then(() => renderMermaidNow(rootEl)).catch((e) => console.error('[kamishibai] mermaid', e));
    return mermaidQueue;
  }

  /** スライド 1 枚をまとめて準備する（エディタのプレビュー用） */
  function prepareSlide(slide, onChange) {
    enhanceSlide(slide);
    fitSlide(slide);
    watchImages(slide, onChange);
    if (!slide.querySelector('.ks-mermaid')) return Promise.resolve();
    return renderMermaid(slide).then(() => { fitSlide(slide); if (onChange) onChange(slide); });
  }

  /**
   * スライドの静止コピー（サムネイル）を作る。
   * @param {Element} deck   元の .ks-deck（CSS 変数と data 属性をコピーする）
   * @param {Element} slide  元の .ks-slide
   * @param {Object}  [opts] { doc: 生成先 document, dimSteps: 未表示のステップを薄く残す }
   */
  function staticDeck(deck, slide, opts) {
    opts = opts || {};
    const doc = opts.doc || document;
    const wrap = doc.createElement('div');
    wrap.className = 'ks-deck ks-static' + (opts.dimSteps ? ' ks-dim-steps' : '');
    for (const a of Array.from(deck.attributes)) if (a.name.indexOf('data-') === 0) wrap.setAttribute(a.name, a.value);
    wrap.style.cssText = deck.style.cssText;
    const stage = doc.createElement('div');
    stage.className = 'ks-stage';
    const copy = doc.importNode(slide, true);
    copy.classList.remove('is-past', 'is-future', 'ks-measuring');
    copy.classList.add('is-active');
    copy.removeAttribute('aria-hidden');
    if (!opts.dimSteps) copy.querySelectorAll('.ks-step').forEach((el) => el.classList.add('is-shown'));
    stage.appendChild(copy);
    wrap.appendChild(stage);
    reidSvgs(wrap);
    return wrap;
  }

  // ------------------------------------------------------------------
  // スライドショー本体
  // ------------------------------------------------------------------
  const ICONS = {
    prev: '<path d="M15 6l-6 6 6 6"/>',
    next: '<path d="M9 6l6 6-6 6"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    presenter: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    print: '<path d="M7 8V4h10v4M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.8M12 17h.01"/>',
  };
  const HELP = [
    ['→ ↓ Space PageDown', '次へ'],
    ['← ↑ PageUp', '前へ'],
    ['Home / End', '最初 / 最後'],
    ['数字 + Enter', 'そのページへ移動'],
    ['F', '全画面'],
    ['S', '発表者ビュー（ノート・タイマー・次のスライド）'],
    ['O', 'スライド一覧'],
    ['B', '画面を暗転'],
    ['Ctrl + P', '印刷 / PDF として保存'],
    ['?', 'このヘルプ'],
  ];

  function start(config) {
    config = config || {};
    const deck = document.querySelector('.ks-deck');
    const stage = deck && deck.querySelector('.ks-stage');
    if (!stage) return null;
    const slides = Array.from(stage.children).filter((el) => el.classList.contains('ks-slide'));
    const n = slides.length;
    const W = stage.offsetWidth;
    const H = stage.offsetHeight;
    let cur = -1;
    let step = 0;
    let numBuf = '';
    let pv = null; // 発表者ビューのウィンドウ
    let timerBase = Date.now();
    let timerPaused = 0; // 一時停止中なら、その時点の経過 ms

    const el = (tag, cls, html, doc) => {
      const e = (doc || document).createElement(tag);
      if (cls) e.className = cls;
      if (html != null) e.innerHTML = html;
      return e;
    };
    const stepsOf = (slide) => Array.from(slide.querySelectorAll('.ks-step'));

    // ---- レイアウト ----
    function layout() {
      deck.style.setProperty('--ks-scale', Math.min(window.innerWidth / W, window.innerHeight / H));
      sizeOverview();
    }

    // ---- 移動 ----
    function go(index, opts) {
      index = Math.max(0, Math.min(n - 1, index));
      const sts = stepsOf(slides[index]);
      step = opts && opts.allSteps ? sts.length : 0;
      sts.forEach((s, k) => s.classList.toggle('is-shown', k < step));
      if (index !== cur) {
        cur = index;
        slides.forEach((s, j) => {
          s.classList.toggle('is-active', j === cur);
          s.classList.toggle('is-past', j < cur);
          s.classList.toggle('is-future', j > cur);
          s.setAttribute('aria-hidden', j === cur ? 'false' : 'true');
        });
      }
      update();
    }
    function next() {
      const sts = stepsOf(slides[cur]);
      if (step < sts.length) { sts[step++].classList.add('is-shown'); update(); }
      else if (cur < n - 1) go(cur + 1);
    }
    function prev() {
      const sts = stepsOf(slides[cur]);
      if (step > 0) { sts[--step].classList.remove('is-shown'); update(); }
      else if (cur > 0) go(cur - 1, { allSteps: true });
    }

    function update() {
      deck.style.setProperty('--ks-progress', n > 1 ? cur / (n - 1) : 1);
      count.textContent = cur + 1 + ' / ' + n;
      try { history.replaceState(null, '', '#' + (cur + 1)); } catch (e) { /* file:// で失敗しても無視 */ }
      overviewGrid.querySelectorAll('.ks-ov-item').forEach((item, i) => item.classList.toggle('is-current', i === cur));
      syncPresenter();
    }

    // ---- 画面上の UI ----
    const controls = el('div', 'ks-ui ks-controls');
    const button = (icon, title, fn) => {
      const b = el('button', '', '<svg viewBox="0 0 24 24">' + ICONS[icon] + '</svg>');
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', (e) => { fn(); e.currentTarget.blur(); });
      controls.appendChild(b);
      return b;
    };
    button('prev', '前へ (←)', prev);
    const count = el('span', 'ks-count');
    controls.appendChild(count);
    button('next', '次へ (→)', next);
    controls.appendChild(el('span', 'ks-sep'));
    button('grid', '一覧 (O)', () => toggleOverview());
    button('presenter', '発表者ビュー (S)', openPresenter);
    button('full', '全画面 (F)', toggleFullscreen);
    button('print', '印刷 / PDF (Ctrl+P)', () => window.print());
    button('help', 'キー操作 (?)', () => toggleHelp());

    const blackout = el('div', 'ks-ui ks-blackout');
    blackout.addEventListener('click', () => blackout.classList.remove('is-on'));

    const overview = el('div', 'ks-ui ks-overlay');
    overview.hidden = true;
    const overviewGrid = el('div', 'ks-overview-grid');
    overview.appendChild(overviewGrid);
    overview.addEventListener('click', (e) => { if (e.target === overview || e.target === overviewGrid) toggleOverview(false); });

    const help = el('div', 'ks-ui ks-overlay ks-help',
      '<div class="ks-help-card"><h2>キー操作</h2><dl>' +
        HELP.map((h) => '<dt>' + h[0].split(' ').map((k) => (/^[/+]$/.test(k) ? k : '<kbd>' + esc(k) + '</kbd>')).join(' ') + '</dt><dd>' + h[1] + '</dd>').join('') +
        '</dl></div>');
    help.hidden = true;
    help.addEventListener('click', () => toggleHelp(false));

    const toastEl = el('div', 'ks-ui ks-toast');
    toastEl.style.opacity = '0';
    let toastTimer = 0;
    function toast(message, ms) {
      toastEl.textContent = message;
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, ms || 1600);
    }

    document.body.append(controls, blackout, overview, help, toastEl);
    if (config.progress !== false) stage.appendChild(el('div', 'ks-progress'));

    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    }
    function toggleHelp(on) {
      help.hidden = on === undefined ? !help.hidden : !on;
    }
    function sizeOverview() {
      if (overview.hidden) return;
      overviewGrid.querySelectorAll('.ks-ov-item').forEach((item) => {
        item.firstElementChild.style.setProperty('--ks-scale', item.clientWidth / W);
      });
    }
    function toggleOverview(on) {
      const show = on === undefined ? overview.hidden : on;
      if (show) {
        overviewGrid.innerHTML = '';
        slides.forEach((s, i) => {
          const item = el('div', 'ks-ov-item' + (i === cur ? ' is-current' : ''));
          item.appendChild(staticDeck(deck, s));
          item.appendChild(el('span', 'ks-ov-num', String(i + 1)));
          item.addEventListener('click', () => { go(i); toggleOverview(false); });
          overviewGrid.appendChild(item);
        });
      }
      overview.hidden = !show;
      if (show) {
        sizeOverview();
        const current = overviewGrid.querySelector('.is-current');
        if (current) current.scrollIntoView({ block: 'center' });
      }
    }

    // ---- 発表者ビュー ----
    function openPresenter() {
      if (pv && !pv.closed) { pv.focus(); return; }
      pv = window.open('', 'ks-presenter', 'width=1180,height=720');
      if (!pv) { toast('ポップアップがブロックされました。許可してからもう一度 S を押してください', 4000); return; }
      const d = pv.document;
      d.open();
      d.write('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>発表者ビュー</title></head><body class="ks-presenter ks-ui"></body></html>');
      d.close();
      document.querySelectorAll('style, link[rel="stylesheet"]').forEach((s) => d.head.appendChild(d.importNode(s, true)));
      d.title = '発表者ビュー — ' + (config.title || document.title);
      d.body.innerHTML =
        '<div class="ks-pv">' +
        '<div class="ks-pv-bar"><span class="ks-pv-timer" data-r="timer">00:00</span>' +
        '<button type="button" data-a="pause">一時停止</button><button type="button" data-a="reset">リセット</button>' +
        '<span class="ks-pv-clock" data-r="clock"></span>' +
        '<span class="ks-pv-count" data-r="count"></span>' +
        '<button type="button" data-a="prev">← 前へ</button><button type="button" data-a="next">次へ →</button></div>' +
        '<div class="ks-pv-left"><span class="ks-pv-label">現在のスライド</span><div class="ks-pv-frame" data-r="cur"></div></div>' +
        '<div class="ks-pv-right"><span class="ks-pv-label">次のスライド</span><div class="ks-pv-frame" data-r="next"></div>' +
        '<span class="ks-pv-label">ノート <button type="button" data-a="smaller">A−</button> <button type="button" data-a="larger">A＋</button></span>' +
        '<div class="ks-pv-notes" data-r="notes"></div></div></div>';
      let notesSize = 20;
      const actions = {
        prev, next,
        reset: () => { timerBase = Date.now(); if (timerPaused) timerPaused = 1; tick(); },
        pause: () => {
          if (timerPaused) { timerBase = Date.now() - timerPaused; timerPaused = 0; }
          else timerPaused = Math.max(1, Date.now() - timerBase);
          d.querySelector('[data-a="pause"]').textContent = timerPaused ? '再開' : '一時停止';
        },
        smaller: () => { notesSize = Math.max(12, notesSize - 2); d.body.style.setProperty('--ks-pv-notes-size', notesSize + 'px'); },
        larger: () => { notesSize = Math.min(44, notesSize + 2); d.body.style.setProperty('--ks-pv-notes-size', notesSize + 'px'); },
      };
      d.body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (b && actions[b.dataset.a]) { actions[b.dataset.a](); b.blur(); }
      });
      d.addEventListener('keydown', onKey);
      pv.addEventListener('resize', syncPresenter);
      timerBase = Date.now();
      timerPaused = 0;
      syncPresenter();
      tick();
    }
    const pad = (v) => String(v).padStart(2, '0');
    function tick() {
      if (!pv || pv.closed) return;
      const d = pv.document;
      const ms = timerPaused || Date.now() - timerBase;
      const s = Math.floor(ms / 1000);
      const timer = d.querySelector('[data-r="timer"]');
      if (!timer) return;
      timer.textContent = (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
      const now = new Date();
      d.querySelector('[data-r="clock"]').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
    }
    setInterval(tick, 500);

    function syncPresenter() {
      if (!pv || pv.closed) return;
      const d = pv.document;
      const part = (name) => d.querySelector('[data-r="' + name + '"]');
      if (!part('cur')) return;
      const fill = (box, slide, dimSteps) => {
        box.innerHTML = '';
        if (!slide) { box.appendChild(el('div', 'ks-pv-end', '— 最後のスライドです —', d)); return; }
        const copy = staticDeck(deck, slide, { doc: d, dimSteps });
        copy.style.setProperty('--ks-scale', box.clientWidth / W);
        box.appendChild(copy);
      };
      fill(part('cur'), slides[cur], true);
      fill(part('next'), slides[cur + 1], false);
      const notes = slides[cur].querySelector('.ks-notes');
      part('notes').innerHTML = notes ? notes.innerHTML : '<p class="ks-pv-empty">（このスライドにノートはありません）</p>';
      const total = stepsOf(slides[cur]).length;
      part('count').textContent = cur + 1 + ' / ' + n + (total ? '　ステップ ' + step + ' / ' + total : '');
    }
    window.addEventListener('beforeunload', () => { if (pv && !pv.closed) pv.close(); });

    // ---- 入力 ----
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (/^\d$/.test(k)) { numBuf += k; toast(numBuf + ' ページへ → Enter', 2500); return; }
      if (k === 'Enter' && numBuf) { go(parseInt(numBuf, 10) - 1); numBuf = ''; e.preventDefault(); return; }
      numBuf = '';
      if (k === 'Escape') {
        if (!help.hidden) toggleHelp(false);
        else if (!overview.hidden) toggleOverview(false);
        else blackout.classList.remove('is-on');
        return;
      }
      if (!overview.hidden && k === 'Enter') { toggleOverview(false); e.preventDefault(); return; }
      switch (k.length === 1 ? k.toLowerCase() : k) {
        case ' ':
          if (e.shiftKey) prev(); else next();
          break;
        case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'Enter': case 'n': case 'j': case 'l':
          next();
          break;
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': case 'p': case 'k': case 'h':
          prev();
          break;
        case 'Home': go(0); break;
        case 'End': go(n - 1); break;
        case 'f': toggleFullscreen(); break;
        case 'o': case 'g': toggleOverview(); break;
        case 's': openPresenter(); break;
        case 'b': case '.': blackout.classList.toggle('is-on'); break;
        case '?': toggleHelp(); break;
        default: return;
      }
      e.preventDefault();
    }
    document.addEventListener('keydown', onKey);

    let touch = null;
    document.addEventListener('touchstart', (e) => { touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (!touch || !overview.hidden) return;
      const dx = e.changedTouches[0].clientX - touch.x;
      const dy = e.changedTouches[0].clientY - touch.y;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) { if (dx < 0) next(); else prev(); }
      touch = null;
    }, { passive: true });

    // マウスを止めると操作バーとカーソルを隠す
    let idleTimer = 0;
    function wake() {
      document.documentElement.classList.remove('ks-idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => document.documentElement.classList.add('ks-idle'), 2600);
    }
    document.addEventListener('mousemove', wake);
    document.addEventListener('touchstart', wake, { passive: true });
    wake();

    // ---- 起動 ----
    slides.forEach(enhanceSlide);
    layout();
    window.addEventListener('resize', layout);
    const initial = parseInt((location.hash || '').replace(/^#\/?/, ''), 10);
    go(isNaN(initial) ? 0 : initial - 1);
    const refit = () => slides.forEach(fitSlide);
    slides.forEach((s) => { fitSlide(s); watchImages(s); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
    renderMermaid(stage).then(() => {
      slides.forEach((s) => { if (s.querySelector('.ks-mermaid')) fitSlide(s); });
      document.documentElement.classList.add('ks-ready');
    });

    return { go, next, prev, slides, get index() { return cur; } };
  }

  root.Kamishibai = Object.assign(root.Kamishibai || {}, {
    start,
    enhanceSlide,
    fitSlide,
    watchImages,
    renderMermaid,
    mermaidPlainSvg,
    prepareSlide,
    staticDeck,
    reidSvgs,
  });
})(typeof window !== 'undefined' ? window : this);
