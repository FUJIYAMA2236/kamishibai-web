/*
 * parse.js — slides.md のテキストを「スライドの配列」に分解する（Markdown → HTML 変換はしない）。
 *
 * 記法（docs/MARKDOWN.md と同期させること）:
 *   - 先頭の --- ... --- は front matter（key: value のみの簡易 YAML）
 *   - 前の行が空行の `---` だけの行でスライドを区切る
 *   - `???` または `Note:` だけの行以降は発表者ノート
 *   - `|||` だけの行でカラムを区切る
 *   - `::: columns` 〜 `:::` で囲むと、カラムをスライドの一部分にできる（前後の文章は全幅）。
 *     囲みが無いときは、`|||` があるとスライド全体がカラムになる（従来の書き方）
 *   - `<!-- id: xxx -->` でスライドに固定 ID を付ける（デザイン設定の紐付けキー）
 *   - これらはコードフェンス（``` / ~~~）の中では無効
 *
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.KS = root.KS || {}).parse = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RE_SEPARATOR = /^---\s*$/;
  const RE_NOTES = /^(\?\?\?|notes?:)\s*$/i;
  const RE_COLUMN = /^\|\|\|\s*$/;
  // ::: columns（横に並べる）/ ::: rows（縦に並べる）/ ::: grid（格子・2 列）
  const RE_COLS_OPEN = /^:::\s*(columns|cols|カラム|rows|縦|grid|格子)\s*$/i;
  const COL_DIR = { columns: 'row', cols: 'row', 'カラム': 'row', rows: 'column', '縦': 'column', grid: 'grid', '格子': 'grid' };
  const RE_COLS_CLOSE = /^:::\s*$/;
  const RE_ID = /^\s*<!--\s*id\s*:\s*(\S+?)\s*-->\s*$/;
  const RE_HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
  const RE_META = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

  // 行がコードフェンスの一部（開始・終了行を含む）かどうかを順に判定する関数を返す
  function fenceTracker() {
    let open = null;
    return function (line) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (m) {
        if (!open) {
          open = { ch: m[1][0], len: m[1].length };
          return true;
        }
        if (m[1][0] === open.ch && m[1].length >= open.len && !m[2].trim()) {
          open = null;
          return true;
        }
      }
      return !!open;
    };
  }

  function plainText(markdownInline) {
    return String(markdownInline)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[*_`~]/g, '')
      .trim();
  }

  function slugify(text) {
    return plainText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '');
  }

  function parseFrontMatter(lines) {
    const meta = {};
    if (!lines.length || lines[0].trim() !== '---') return { meta, next: 0 };
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === '---') { end = j; break; }
    }
    if (end < 0) return { meta, next: 0 };
    const body = lines.slice(1, end);
    const isMetaLine = (l) => RE_META.test(l);
    const ok = body.every((l) => !l.trim() || /^\s*#/.test(l) || isMetaLine(l));
    if (!ok || !body.some(isMetaLine)) return { meta, next: 0 };
    for (const l of body) {
      const m = RE_META.exec(l);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      meta[m[1]] = v;
    }
    return { meta, next: end + 1 };
  }

  /**
   * @param {string} text slides.md の全文
   * @returns {{meta: Object, slides: Array, lineCount: number}}
   *   slides[i] = { index, id, explicitId, title, pre: string, columns: string[], post: string, notes: string,
   *                 fenced, colDir?, startLine, endLine, contentStartLine }  （行番号は 0 始まり・全文基準）
   *   colDir は囲みの書き方で決まるカラムの並べ方（::: columns → row / ::: rows → column / ::: grid → grid）。囲みが無ければ無し
   *   pre / post は「::: columns」の囲みの前後の本文（囲みが無ければ空で、本文はすべて columns に入る）
   */
  function parseDeck(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const fm = parseFrontMatter(lines);
    const slides = [];
    const inFence = fenceTracker();

    let cur = null;
    const begin = (line) => {
      cur = { startLine: line, endLine: line, contentStartLine: -1, notesLine: -1, explicitId: null, title: '', pre: [], columns: [[]], post: [], region: 'body', notes: null };
    };
    const finish = (lastLine) => {
      cur.endLine = Math.max(cur.startLine, lastLine);
      slides.push(cur);
    };

    begin(fm.next);
    for (let i = fm.next; i < lines.length; i++) {
      const line = lines[i];
      const fenced = inFence(line);
      if (!fenced) {
        if (RE_SEPARATOR.test(line) && (i === cur.startLine || !lines[i - 1].trim())) {
          finish(i - 1);
          begin(i + 1);
          continue;
        }
        if (cur.notes === null) {
          if (RE_NOTES.test(line)) { cur.notes = []; cur.notesLine = i; continue; }
          const idm = RE_ID.exec(line);
          if (idm) {
            if (!cur.explicitId) cur.explicitId = idm[1];
            if (cur.contentStartLine < 0) cur.contentStartLine = i;
            continue;
          }
          const om = RE_COLS_OPEN.exec(line);
          if (om && cur.region === 'body') {
            // ここまでの本文は囲みの前（全幅）。||| が先にあっても 1 つにまとめる
            cur.pre = [].concat.apply([], cur.columns.map((c, k) => (k ? [''].concat(c) : c)));
            cur.columns = [[]];
            cur.region = 'cols';
            cur.colDir = COL_DIR[om[1].toLowerCase()] || 'row';
            continue;
          }
          if (RE_COLS_CLOSE.test(line) && cur.region === 'cols') { cur.region = 'post'; continue; }
          if (RE_COLUMN.test(line) && cur.region !== 'post') { cur.columns.push([]); continue; }
          if (!cur.title) {
            const hm = RE_HEADING.exec(line);
            if (hm) cur.title = plainText(hm[2]);
          }
        }
      }
      if (cur.notes !== null) cur.notes.push(line);
      else {
        if (cur.contentStartLine < 0 && line.trim()) cur.contentStartLine = i;
        if (cur.region === 'post') cur.post.push(line);
        else cur.columns[cur.columns.length - 1].push(line);
      }
    }
    finish(lines.length - 1);

    // ID の割り当て: 明示 ID を先に確保し、残りは見出しから自動生成（重複は -2, -3 …）
    const used = new Set();
    for (const s of slides) {
      if (s.explicitId && !used.has(s.explicitId)) { s.id = s.explicitId; used.add(s.id); }
    }
    slides.forEach((s, index) => {
      s.index = index;
      const tidy = (c) => c.join('\n').replace(/^\n+|\s+$/g, '');
      s.fenced = s.region !== 'body';
      s.columns = s.columns.map(tidy);
      s.pre = tidy(s.pre);
      s.post = tidy(s.post);
      delete s.region;
      s.notes = s.notes ? s.notes.join('\n').trim() : '';
      if (s.contentStartLine < 0) s.contentStartLine = s.startLine;
      if (s.id) return;
      const base = slugify(s.title) || 'slide';
      let id = base;
      for (let n = 2; used.has(id); n++) id = base + '-' + n;
      s.id = id;
      used.add(id);
      s.explicitId = null; // 重複していた明示 ID は自動 ID 扱いにする
    });

    const meta = fm.meta;
    if (!meta.title && slides.length && slides[0].title) meta.title = slides[0].title;
    return { meta, slides, lineCount: lines.length };
  }

  /** 行番号（0 始まり）を含むスライドの index を返す */
  function slideIndexAtLine(parsed, line) {
    const s = parsed.slides;
    for (let i = s.length - 1; i >= 0; i--) if (line >= s[i].startLine) return i;
    return 0;
  }

  /**
   * スライドに `<!-- id: xxx -->` を書き込んで ID を固定する。
   * デザイン設定（deck.json）は ID で紐付くので、見出しを書き換えても設定が外れなくなる。
   * @returns {{text: string, offset: number, length: number}} 挿入後の全文と、挿入位置・文字数
   */
  function pinSlideId(text, slide) {
    const src = String(text).replace(/\r\n?/g, '\n');
    if (slide.explicitId) return { text: src, offset: 0, length: 0 };
    const lines = src.split('\n');
    const at = Math.min(slide.contentStartLine, lines.length);
    let offset = 0;
    for (let i = 0; i < at; i++) offset += lines[i].length + 1;
    let insert = '<!-- id: ' + slide.id + ' -->\n';
    if (offset > src.length) { offset = src.length; insert = '\n' + insert; } // 末尾の空スライド
    return { text: src.slice(0, offset) + insert + src.slice(offset), offset, length: insert.length };
  }

  // ------------------------------------------------------------------
  // 画像記法の位置特定と書き換え（GUI で画像サイズ等を変えるときに使う）
  //   ![alt](src "title"){width=40% .shadow}
  // ------------------------------------------------------------------
  const RE_IMAGE = /!\[((?:[^\]\\\n]|\\.)*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+("[^"\n]*"|'[^'\n]*'))?\s*\)(\{[^}\n]*\})?/g;

  /** "{width=40% .shadow}" の中身 → { width: '40%', height: undefined, classes: ['shadow'] }（値は書かれたまま） */
  function parseAttrs(text) {
    const out = { classes: [] };
    for (const part of String(text || '').trim().split(/\s+/)) {
      if (!part) continue;
      if (part[0] === '.') { const c = part.slice(1).replace(/[^\w-]/g, ''); if (c) out.classes.push(c); continue; }
      const m = /^(\w+)=(.+)$/.exec(part);
      if (!m) continue;
      const v = m[2].replace(/[^\w.%-]/g, '');
      if (m[1] === 'width' || m[1] === 'w') out.width = v;
      else if (m[1] === 'height' || m[1] === 'h') out.height = v;
    }
    return out;
  }

  /** parseAttrs の逆。空なら '' */
  function formatAttrs(attrs) {
    attrs = attrs || {};
    const parts = [];
    if (attrs.width) parts.push('width=' + attrs.width);
    if (attrs.height) parts.push('height=' + attrs.height);
    for (const c of attrs.classes || []) parts.push('.' + c);
    return parts.length ? '{' + parts.join(' ') + '}' : '';
  }

  /**
   * 指定した行範囲 [fromLine, toLine) にある画像記法を、出てくる順に返す。
   * コードフェンスとインラインコードの中は除く（markdown-it が画像として扱う順番と揃えるため）。
   * @returns {Array<{start, end, head, line, alt, src, title, attrs}>} start/end は全文での文字位置。
   *          head は {…} を除いた「![…](…)」部分の長さ
   */
  function findImages(text, fromLine, toLine) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const inFence = fenceTracker();
    const out = [];
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fenced = inFence(line);
      if (!fenced && i >= (fromLine || 0) && (toLine == null || i < toLine)) {
        const masked = line.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length));
        RE_IMAGE.lastIndex = 0;
        let m;
        while ((m = RE_IMAGE.exec(masked))) {
          let src = m[2];
          if (src[0] === '<') src = src.slice(1, -1);
          out.push({
            start: off + m.index,
            end: off + m.index + m[0].length,
            head: m[0].length - (m[4] || '').length,
            line: i,
            alt: m[1],
            src,
            title: m[3] ? m[3].slice(1, -1) : '',
            attrs: parseAttrs(m[4] ? m[4].slice(1, -1) : ''),
          });
        }
      }
      off += line.length + 1;
    }
    return out;
  }

  /** findImages で得た画像の {…} 部分を差し替える */
  function setImageAttrs(text, image, attrs) {
    const src = String(text).replace(/\r\n?/g, '\n');
    return src.slice(0, image.start + image.head) + formatAttrs(attrs) + src.slice(image.end);
  }

  /** スライドの本文（ノートより前）の行範囲 [start, end) */
  function slideBodyRange(slide) {
    return { start: slide.startLine, end: slide.notesLine >= 0 ? slide.notesLine : slide.endLine + 1 };
  }

  /**
   * line 行目の位置にブロック（複数行可）を挿入する。前後が空行で区切られるように調整し、
   * 直前に続く空行は飛ばして詰める（スライド末尾に足したとき、区切りの --- の前に空行が残るように）。
   * @returns {{text: string, line: number, count: number}} line = 挿入したブロックの先頭行
   */
  function insertBlockAt(text, line, block) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    let at = Math.max(0, Math.min(line, lines.length));
    while (at > 0 && !lines[at - 1].trim()) at--;
    const body = String(block).replace(/\r\n?/g, '\n').split('\n');
    const pre = at > 0 ? [''] : [];
    const post = at < lines.length && lines[at].trim() ? [''] : at < lines.length ? [] : [''];
    const next = lines.slice(0, at).concat(pre, body, post, lines.slice(at));
    return { text: next.join('\n'), line: at + pre.length, count: body.length };
  }

  return {
    RE: { separator: RE_SEPARATOR, notes: RE_NOTES, column: RE_COLUMN, id: RE_ID, colsOpen: RE_COLS_OPEN, colsClose: RE_COLS_CLOSE },
    parseDeck, slideIndexAtLine, pinSlideId, slugify, plainText, fenceTracker,
    parseAttrs, formatAttrs, findImages, setImageAttrs, slideBodyRange, insertBlockAt,
  };
});
