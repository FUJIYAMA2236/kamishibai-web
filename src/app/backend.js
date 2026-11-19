/*
 * backend.js — Kamishibai の「裏側」（プロジェクト・.kami・テーマ・HTML の組み立て・JSON API）。
 *
 * ファイルの読み書きなど環境ごとに違う部分は host に任せるので、同じこのコードが
 *   ・Node（ブラウザ版のローカルサーバー src/node/server.js・コマンドライン bin/kamishibai.js）… host = src/node/host.js
 *   ・デスクトップアプリ（Tauri。WebView の中で動く）                                        … host = src/app/tauri-host.js
 * の両方で動く。API の一覧は CLAUDE.md にある（変えたら両方を直すこと）。
 *
 * host（すべて非同期）:
 *   readFile(p) → Uint8Array（無ければ例外）/ writeFile(p, Uint8Array|string) / stat(p) → { isDir, isFile, size, mtime } | null
 *   readDir(p) → [{ name, isDir }] / mkdir(p)（途中も作る）/ removeFile(p) / removeDir(p)（無くてもよい）/ rename(a, b)
 *   userDataDir() → 設定の置き場所 / tempDir() → 一時フォルダの親 / absolute(p) → 絶対パス
 *   bundled.read(rel) → Uint8Array | null / bundled.list(rel) → [{ name, isDir }]
 *     （ツールに同梱のファイル。rel は 'themes/…' 'sample/…' 'runtime/…' 'vendor/…'）
 *   zip.write(entries) → Uint8Array / zip.read(bytes) → [{ name, data }]
 *   pdf(htmlFile, pdfFile, { kind, width, height }) … 無ければ PDF は作れない
 *   reveal(p) … エクスプローラー / Finder で表示（任意）
 *
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/schema'), require('../core/parse'), require('../core/render'), require('./pathx'));
  } else {
    (root.KS = root.KS || {}).backend = factory(root.KS.schema, root.KS.parse, root.KS.render, root.KS.pathx);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (schema, parse, render, P) {
  'use strict';

  const VERSION = '0.4.3';
  const KAMI_EXT = '.kami';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const toText = (b) => (typeof b === 'string' ? b : dec.decode(b));
  const lf = (t) => String(t == null ? '' : t).replace(/\r\n?/g, '\n');
  const withFinalNewline = (t) => (t.endsWith('\n') || t === '' ? t : t + '\n');

  class UserError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status || 400;
      this.expose = true;
    }
  }

  const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  };
  const IMAGE_EXT = /^\.(png|jpe?g|gif|svg|webp|avif|bmp)$/;

  function base64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  /** 作業用フォルダの名前に使う短いハッシュ（FNV-1a） */
  function hash(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
  }

  function deckTemplate(title) {
    const today = new Date().toISOString().slice(0, 10);
    return '---\ntitle: ' + title + '\nauthor:\ndate: ' + today + '\n---\n\n# ' + title + '\n\nサブタイトルをここに\n\n???\n' +
      'ここは発表者ノートです。発表画面で S キーを押すと、手元の画面にだけ表示されます。\n\n---\n\n## 最初のスライド\n\n' +
      '- 箇条書きはそのまま書くだけ\n- **強調** や `コード` も使えます\n- スライドは「空行 + --- + 空行」で区切ります\n\n---\n\n## ありがとうございました\n';
  }

  function assertThemeId(id) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) {
      throw new UserError('テーマIDは半角英小文字・数字・ハイフンで指定してください（例: my-theme）');
    }
    return id;
  }

  /**
   * @param {Object} host 上の説明を参照
   * @param {Object} [opts] { workRoot: .kami を展開する場所（既定 <userData>/open）, desktop: アプリから使うか }
   */
  function createBackend(host, opts) {
    opts = opts || {};
    const H = host;
    const exists = async (p) => !!(await H.stat(p));
    const isDir = async (p) => { const s = await H.stat(p); return !!(s && s.isDir); };
    const readText = async (p) => { const s = await H.stat(p); return s && s.isFile ? lf(toText(await H.readFile(p))) : null; };
    const mtime = async (p) => { const s = await H.stat(p); return s ? Math.round(s.mtime) : 0; };
    async function readJson(p, fallback) {
      const t = await readText(p);
      if (t == null) return fallback;
      try { return JSON.parse(t); } catch (e) { throw new UserError(P.basename(p) + ' を JSON として読めません: ' + e.message, 500); }
    }
    const userData = () => H.userDataDir();
    const userThemesDir = () => P.join(userData(), 'themes');
    const isProjectDir = async (dir) => !!dir && !!(await H.stat(P.join(dir, 'slides.md')));

    async function copyDir(from, to, skip) {
      await H.mkdir(to);
      for (const e of await H.readDir(from)) {
        if (skip && skip(e.name)) continue;
        const a = P.join(from, e.name);
        const b = P.join(to, e.name);
        if (e.isDir) await copyDir(a, b, skip);
        else await H.writeFile(b, await H.readFile(a));
      }
    }
    async function isEmptyDir(dir) {
      const s = await H.stat(dir);
      if (!s) return true;
      return s.isDir && !(await H.readDir(dir)).length;
    }

    // ==================================================================
    // テーマ（プロジェクト内 → ユーザー → 同梱 の順に探す）
    // ==================================================================
    function themeLibrary(projectDir) {
      const places = [];
      if (projectDir) places.push({ kind: 'project', dir: P.join(projectDir, 'themes') });
      places.push({ kind: 'user', dir: userThemesDir() });
      places.push({ kind: 'builtin', dir: 'themes' });
      const read = (place, rel) => (place.kind === 'builtin' ? H.bundled.read(place.dir + '/' + rel) : H.stat(P.join(place.dir, rel)).then((s) => (s ? H.readFile(P.join(place.dir, rel)) : null)));
      async function locate(id) {
        for (const place of places) {
          const json = await read(place, id + '/theme.json');
          if (json) return { place, json };
        }
        return null;
      }
      async function readTheme(id) {
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return null;
        const hit = await locate(id);
        if (!hit) return null;
        let theme;
        try { theme = JSON.parse(toText(hit.json)); } catch (e) { throw new UserError(id + '/theme.json を JSON として読めません: ' + e.message, 500); }
        const css = await read(hit.place, id + '/theme.css');
        const builtin = hit.place.kind === 'builtin';
        return {
          id,
          name: theme.name || id,
          description: theme.description || '',
          category: theme.category === 'decorative' ? 'decorative' : 'simple',
          order: Number(theme.order) || 100,
          aspect: theme.aspect,
          tokens: theme.tokens || {},
          animation: theme.animation || {},
          chrome: theme.chrome || {},
          css: css ? lf(toText(css)) : '',
          builtin,
          editable: !builtin,
          place: hit.place.kind,
        };
      }
      async function listThemes() {
        const out = {};
        for (const place of places.slice().reverse()) {
          const list = place.kind === 'builtin' ? await H.bundled.list(place.dir) : (await isDir(place.dir)) ? await H.readDir(place.dir) : [];
          for (const e of list) {
            if (!e.isDir) continue;
            const t = await readTheme(e.name);
            if (t) out[e.name] = t;
          }
        }
        return out;
      }
      /** プロジェクト内に既にあるテーマはそこへ、それ以外はユーザーのテーマとして保存する */
      async function writeTheme(id, data) {
        assertThemeId(id);
        data = data || {};
        const hit = await locate(id);
        const dir = hit && hit.place.kind === 'project' ? P.join(hit.place.dir, id) : P.join(userThemesDir(), id);
        await H.mkdir(dir);
        const json = {
          name: String(data.name || id),
          description: String(data.description || ''),
          category: data.category === 'decorative' ? 'decorative' : 'simple',
          order: Number(data.order) || undefined,
          aspect: data.aspect,
          tokens: data.tokens || {},
          animation: data.animation || {},
          chrome: data.chrome || {},
        };
        await H.writeFile(P.join(dir, 'theme.json'), render.serialize(json));
        const css = lf(data.css || '');
        if (css.trim()) await H.writeFile(P.join(dir, 'theme.css'), withFinalNewline(css));
        else await H.removeFile(P.join(dir, 'theme.css'));
        return readTheme(id);
      }
      /** テーマのファイルがある場所（同梱なら null） */
      async function themeDirOf(id) {
        const hit = await locate(id);
        return hit && hit.place.kind !== 'builtin' ? { kind: hit.place.kind, dir: P.join(hit.place.dir, id) } : null;
      }
      return { readTheme, listThemes, writeTheme, themeDirOf };
    }

    // ==================================================================
    // 自作テーマの読み込み・書き出し（ユーザーのテーマ = <userData>/themes/<ID>/ に入れる）
    // ==================================================================
    const BUILTIN_THEME = async (id) => !!(await H.bundled.read('themes/' + id + '/theme.json'));
    /** フォルダ名などからテーマ ID を作る（英小文字・数字・ハイフン） */
    function themeIdFrom(name) {
      const id = String(name || '').toLowerCase().replace(/\.(zip|json)$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40);
      return /^[a-z0-9][a-z0-9_-]*$/.test(id) ? id : '';
    }
    /** theme.json の中身を調べる（読めないものは UserError、知らない項目などは warnings に） */
    function checkTheme(id, jsonText, warnings) {
      let t;
      try { t = JSON.parse(jsonText); } catch (e) { throw new UserError('「' + id + '」の theme.json を JSON として読めません: ' + e.message); }
      if (!t || typeof t !== 'object' || Array.isArray(t)) throw new UserError('「' + id + '」の theme.json の中身がオブジェクト（{ … }）ではありません');
      const defs = {};
      for (const d of schema.TOKENS) defs[d.key] = d;
      for (const [k, v] of Object.entries(t.tokens || {})) {
        const d = defs[k];
        if (!d) { warnings.push(id + ': 知らないトークン「' + k + '」は使われません'); continue; }
        if (d.type === 'select' && !d.options.some((o) => o[0] === v)) warnings.push(id + ': 「' + k + '」の値「' + v + '」は選べる値（' + d.options.map((o) => o[0]).join(' / ') + '）にありません');
        if (d.type === 'number' && typeof v !== 'number') warnings.push(id + ': 「' + k + '」は数値で書いてください（いまは「' + v + '」）');
      }
      for (const k of Object.keys(t.animation || {})) if (!schema.ANIMATION[k]) warnings.push(id + ': 知らないアニメーションの項目「' + k + '」は使われません');
      if (t.aspect && !schema.ASPECTS[t.aspect]) warnings.push(id + ': 縦横比「' + t.aspect + '」は使えません（' + Object.keys(schema.ASPECTS).join(' / ') + '）');
      return t;
    }
    /**
     * 自作テーマを読み込む。path は次のどれか:
     *   テーマのフォルダ（中に theme.json）/ theme.json そのもの / テーマのフォルダをいくつか入れたフォルダ / それらを zip にしたもの
     * フォルダ名（zip の中のフォルダ名・zip の名前）がテーマ ID になる。
     * @returns {{ imported: [{ id, name }], warnings: string[] }}。既にあるテーマは overwrite が無いと 409（exists に ID）
     */
    async function importThemes(src, o) {
      o = o || {};
      src = H.absolute(String(src || '').trim());
      const st = src && (await H.stat(src));
      if (!st) throw new UserError('ファイルが見つかりません: ' + src, 404);
      const found = []; // { id, json, css }
      const fromDir = async (dir) => {
        const json = await readText(P.join(dir, 'theme.json'));
        if (json != null) { found.push({ id: themeIdFrom(P.basename(dir)), json, css: (await readText(P.join(dir, 'theme.css'))) || '' }); return; }
        for (const e of await H.readDir(dir)) if (e.isDir) {
          const sub = P.join(dir, e.name);
          const j = await readText(P.join(sub, 'theme.json'));
          if (j != null) found.push({ id: themeIdFrom(e.name), json: j, css: (await readText(P.join(sub, 'theme.css'))) || '' });
        }
      };
      if (st.isDir) await fromDir(src);
      else if (/\.json$/i.test(src)) await fromDir(P.dirname(src));
      else if (/\.zip$/i.test(src)) {
        let entries;
        try { entries = await H.zip.read(await H.readFile(src)); } catch (e) { throw new UserError('zip を開けませんでした: ' + e.message); }
        const byName = new Map(entries.map((e) => [e.name.replace(/\\/g, '/'), e]));
        for (const [name, e] of byName) {
          const m = /^(?:(.*)\/)?theme\.json$/.exec(name);
          if (!m) continue;
          const prefix = m[1] ? m[1] + '/' : '';
          const css = byName.get(prefix + 'theme.css');
          found.push({ id: themeIdFrom(m[1] ? m[1].split('/').pop() : P.basename(src)), json: toText(e.data), css: css ? toText(css.data) : '' });
        }
      } else {
        throw new UserError('テーマのフォルダ・theme.json・zip のどれかを選んでください');
      }
      if (!found.length) throw new UserError('theme.json が見つかりません（テーマのフォルダには theme.json が必要です）');
      const warnings = [];
      const exists = [];
      for (const f of found) {
        if (!f.id) throw new UserError('テーマ ID にできるフォルダ名ではありません。フォルダ名を半角英小文字・数字・ハイフンにしてください（例: my-theme）');
        if (await BUILTIN_THEME(f.id)) throw new UserError('「' + f.id + '」は同梱のテーマと同じ ID です。フォルダ名（ID）を変えてから読み込んでください');
        f.theme = checkTheme(f.id, lf(f.json), warnings);
        if (await H.stat(P.join(userThemesDir(), f.id, 'theme.json'))) exists.push(f.id);
      }
      if (exists.length && !o.overwrite) {
        const e = new UserError('同じ ID のテーマが既にあります: ' + exists.join('、'), 409);
        e.exists = exists;
        throw e;
      }
      for (const f of found) {
        const dir = P.join(userThemesDir(), f.id);
        await H.mkdir(dir);
        await H.writeFile(P.join(dir, 'theme.json'), withFinalNewline(lf(f.json)));
        if (f.css.trim()) await H.writeFile(P.join(dir, 'theme.css'), withFinalNewline(lf(f.css)));
        else await H.removeFile(P.join(dir, 'theme.css'));
      }
      return { imported: found.map((f) => ({ id: f.id, name: f.theme.name || f.id })), warnings };
    }
    /** テーマを zip（<ID>/theme.json と theme.css）に書き出す（人に渡す・別の PC で読み込む用） */
    async function exportTheme(id, out) {
      assertThemeId(id);
      const lib = project || themeLibrary(null);
      const t = await lib.readTheme(id);
      if (!t) throw new UserError('テーマ「' + id + '」が見つかりません', 404);
      const json = { name: t.name, description: t.description || undefined, category: t.category, order: t.order === 100 ? undefined : t.order, aspect: t.aspect, tokens: t.tokens, animation: t.animation, chrome: t.chrome };
      const enc = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : s);
      const entries = [{ name: id + '/theme.json', data: enc(render.serialize(json)) }];
      if (t.css && t.css.trim()) entries.push({ name: id + '/theme.css', data: enc(withFinalNewline(t.css)) });
      out = H.absolute(String(out || '').trim());
      if (!out) throw new UserError('書き出す場所を指定してください');
      if (!/\.zip$/i.test(out)) out += '.zip';
      await H.mkdir(P.dirname(out));
      await H.writeFile(out, await H.zip.write(entries));
      exported.add(out);
      return { file: out };
    }

    // ==================================================================
    // プロジェクト（slides.md のあるフォルダ）
    // ==================================================================
    async function initProject(dir, o) {
      o = o || {};
      if (await isProjectDir(dir)) return dir;
      await H.mkdir(P.join(dir, 'assets'));
      await H.writeFile(P.join(dir, 'assets', '.gitkeep'), '');
      await H.writeFile(P.join(dir, 'slides.md'), deckTemplate(o.title || P.basename(dir)));
      await H.writeFile(P.join(dir, 'deck.json'), render.serialize({ theme: o.theme || schema.DEFAULT_THEME }));
      await H.writeFile(P.join(dir, '.gitignore'), 'dist/\n');
      return dir;
    }

    /**
     * @param {Object} o { name, kamiFile, temporary, onWrite() }
     */
    async function createProject(dir, o) {
      o = o || {};
      if (!(await isProjectDir(dir))) throw new UserError('slides.md が見つかりません: ' + dir, 404);
      const themes = themeLibrary(dir);
      const file = (f) => P.join(dir, f);
      const touched = () => { if (o.onWrite) o.onWrite(); };
      const name = o.name || (o.kamiFile ? P.basename(o.kamiFile, P.extname(o.kamiFile)) : P.basename(dir));
      const stat = async () => ({ md: await mtime(file('slides.md')), design: await mtime(file('deck.json')), css: await mtime(file('deck.css')) });
      return {
        dir,
        name,
        kamiFile: o.kamiFile || null,
        temporary: !!o.temporary,
        file,
        stat,
        async read() {
          return { name, dir, md: await readText(file('slides.md')), design: await readJson(file('deck.json'), {}), css: (await readText(file('deck.css'))) || '', mtime: await stat() };
        },
        async writeMd(text) {
          await H.writeFile(file('slides.md'), withFinalNewline(lf(text)));
          touched();
          return stat();
        },
        async writeDesign(design) {
          if (!design || typeof design !== 'object' || Array.isArray(design)) throw new UserError('deck.json の内容が不正です');
          await H.writeFile(file('deck.json'), render.serialize(design));
          touched();
          return stat();
        },
        /** 画像を assets/ に保存し、slides.md から参照する相対パスを返す（同じ名前は連番、同じ内容は使い回す） */
        async saveAsset(filename, bytes) {
          let base = P.basename(String(filename || 'image.png')).replace(/[\\/:*?"<>|\x00-\x1f\s#%&{}()[\]]+/g, '-').replace(/^[.-]+/, '');
          if (!base) base = 'image.png';
          const lower = base.toLowerCase();
          const ext = lower.endsWith('.diagram.svg') ? '.diagram.svg' : P.extname(lower);
          if (!IMAGE_EXT.test(P.extname(lower))) throw new UserError('対応していない画像形式です: ' + (P.extname(base) || base));
          const assets = file('assets');
          await H.mkdir(assets);
          const stem = base.slice(0, base.length - ext.length) || 'image';
          let name2 = stem + ext;
          for (let n = 2; await exists(P.join(assets, name2)); n++) {
            const old = await H.readFile(P.join(assets, name2));
            if (old.length === bytes.length && old.every((v, i) => v === bytes[i])) break; // 同じ内容なら使い回す
            name2 = stem + '-' + n + ext;
          }
          await H.writeFile(P.join(assets, name2), bytes);
          touched();
          return 'assets/' + name2;
        },
        /** assets/ の中の既存の画像（図形の .diagram.svg など）を上書きする */
        async writeAsset(rel, bytes) {
          const clean = String(rel || '').replace(/\\/g, '/');
          const full = clean.startsWith('assets/') ? P.inside(file('assets'), clean.slice(7)) : null;
          if (!full) throw new UserError('assets/ の中のファイルだけを上書きできます: ' + rel);
          if (!IMAGE_EXT.test(P.extname(full).toLowerCase())) throw new UserError('対応していない画像形式です: ' + rel);
          await H.mkdir(P.dirname(full));
          await H.writeFile(full, bytes);
          touched();
          return clean;
        },
        readTheme: themes.readTheme,
        listThemes: themes.listThemes,
        themeDirOf: themes.themeDirOf,
        async writeTheme(id, data) {
          const t = await themes.writeTheme(id, data);
          touched();
          return t;
        },
        /** 書き出しの既定の置き場所（.kami ならその隣、フォルダなら dist/） */
        defaultOutDir() { return o.kamiFile ? P.dirname(o.kamiFile) : P.join(dir, 'dist'); },
      };
    }

    // ==================================================================
    // .kami（プロジェクトのフォルダの zip）
    // ==================================================================
    const SKIP = (n) => n === 'dist' || n === 'node_modules' || n.startsWith('.');
    async function collect(dir, prefix, out) {
      for (const e of await H.readDir(dir)) {
        if (SKIP(e.name)) continue;
        const full = P.join(dir, e.name);
        if (e.isDir) await collect(full, prefix + e.name + '/', out);
        else out.push({ name: prefix + e.name, data: await H.readFile(full) });
      }
      return out;
    }
    /** プロジェクトを .kami に書き出す。使っているユーザーテーマも同梱する */
    async function packProject(project, kamiFile) {
      const entries = await collect(project.dir, '', []);
      const design = (await project.read()).design || {};
      const id = design.theme;
      const loc = id ? await project.themeDirOf(id) : null;
      if (loc && loc.kind === 'user') await collect(loc.dir, 'themes/' + id + '/', entries);
      const tmp = kamiFile + '.saving';
      await H.mkdir(P.dirname(kamiFile));
      await H.writeFile(tmp, await H.zip.write(entries));
      await H.rename(tmp, kamiFile);
      return kamiFile;
    }
    async function unpackKami(kamiFile, dir) {
      let entries;
      try {
        entries = await H.zip.read(await H.readFile(kamiFile));
      } catch (e) {
        throw new UserError('ファイルを開けませんでした（.kami ではないか、壊れています）: ' + e.message);
      }
      if (!entries.some((e) => e.name === 'slides.md')) throw new UserError('Kamishibai のファイルではありません（slides.md がありません）');
      await H.removeDir(dir);
      await H.mkdir(dir);
      for (const e of entries) {
        const target = P.inside(dir, e.name);
        if (!target) continue; // フォルダの外を指す名前は無視する
        await H.mkdir(P.dirname(target));
        await H.writeFile(target, e.data);
      }
      return dir;
    }

    // ==================================================================
    // いま開いているプロジェクト（セッション）
    // ==================================================================
    let project = null;
    let repackTimer = 0;
    let repackPending = false;
    let repacking = Promise.resolve();
    const workRoot = () => opts.workRoot || P.join(userData(), 'open');
    const workDirFor = (k) => P.join(workRoot(), hash(k));
    const recentFile = () => P.join(userData(), 'recent.json');

    async function readRecent() {
      try {
        const list = JSON.parse(toText(await H.readFile(recentFile())));
        const out = [];
        for (const r of list) if (r && (await exists(r.path))) out.push(r);
        return out;
      } catch (e) { return []; }
    }
    async function remember(p, kind) {
      const list = (await readRecent()).filter((r) => !P.same(r.path, p));
      list.unshift({ path: p, kind, name: P.basename(p, kind === 'kami' ? KAMI_EXT : '') });
      await H.mkdir(userData());
      await H.writeFile(recentFile(), JSON.stringify(list.slice(0, 12), null, 2));
    }

    function repackNow() {
      clearTimeout(repackTimer);
      repacking = repacking.then(async () => {
        if (!repackPending || !project || !project.kamiFile) return;
        repackPending = false;
        await packProject(project, project.kamiFile);
      }).catch((e) => { if (typeof console !== 'undefined') console.error('[kamishibai] .kami の保存に失敗:', e && e.message); });
      return repacking;
    }
    function scheduleRepack() {
      repackPending = true;
      clearTimeout(repackTimer);
      repackTimer = setTimeout(repackNow, 800);
    }
    const flush = () => repackNow();

    async function openFolder(dir) {
      if (!(await isProjectDir(dir))) throw new UserError('このフォルダには slides.md がありません。「新規作成」でプロジェクトを作るか、別のフォルダを選んでください: ' + dir);
      await flush();
      project = await createProject(dir);
      await remember(dir, 'folder');
      return project;
    }
    async function openKami(kamiFile) {
      await flush();
      const work = await unpackKami(kamiFile, workDirFor(kamiFile));
      project = await createProject(work, { kamiFile, onWrite: scheduleRepack });
      await remember(kamiFile, 'kami');
      return project;
    }
    /** フォルダ・.kami・slides.md のどれでも開く */
    async function open(p) {
      p = H.absolute(String(p || '').trim().replace(/^"|"$/g, ''));
      const s = await H.stat(p);
      if (!s) throw new UserError('見つかりません: ' + p, 404);
      if (s.isDir) return openFolder(p);
      if (P.basename(p).toLowerCase() === 'slides.md') return openFolder(P.dirname(p));
      return openKami(p);
    }
    async function createFolder(dir, o) {
      dir = H.absolute(dir);
      if (!(await isProjectDir(dir)) && !(await isEmptyDir(dir))) throw new UserError('空ではないフォルダには作れません。新しいフォルダ名を指定してください: ' + dir);
      await initProject(dir, o);
      return openFolder(dir);
    }
    async function createKami(kamiFile, o) {
      kamiFile = H.absolute(kamiFile);
      const work = workDirFor(kamiFile);
      await H.removeDir(work);
      await initProject(work, Object.assign({ title: P.basename(kamiFile, P.extname(kamiFile)) }, o));
      await packProject(await createProject(work), kamiFile);
      return openKami(kamiFile);
    }
    /** サンプルを作業用フォルダに複製して開く（保存先はまだ無い） */
    async function openSample() {
      await flush();
      const work = workDirFor('sample:' + Date.now());
      await H.removeDir(work);
      async function copyBundled(rel, to) {
        await H.mkdir(to);
        for (const e of await H.bundled.list(rel)) {
          if (e.name === 'dist') continue;
          if (e.isDir) await copyBundled(rel + '/' + e.name, P.join(to, e.name));
          else await H.writeFile(P.join(to, e.name), await H.bundled.read(rel + '/' + e.name));
        }
      }
      await copyBundled('sample', work);
      project = await createProject(work, { name: 'サンプル（未保存）', temporary: true });
      return project;
    }
    async function saveAsKami(kamiFile) {
      if (!project) throw new UserError('プロジェクトが開かれていません');
      kamiFile = H.absolute(kamiFile);
      await flush();
      await packProject(project, kamiFile);
      if (project.kamiFile || project.temporary) return openKami(kamiFile);
      await remember(kamiFile, 'kami');
      return project;
    }
    async function saveAsFolder(dir) {
      if (!project) throw new UserError('プロジェクトが開かれていません');
      dir = H.absolute(dir);
      if (!(await isEmptyDir(dir))) throw new UserError('空のフォルダを選んでください: ' + dir);
      await flush();
      await copyDir(project.dir, dir, (n) => n === 'dist');
      return openFolder(dir);
    }
    async function close() {
      await flush();
      project = null;
    }

    // ==================================================================
    // HTML の組み立て（スライド / 資料）
    // ==================================================================
    let md = null;
    const markdown = () => md || (md = render.createMarkdown(opts.markdownit || (typeof window !== 'undefined' && window.markdownit), opts.hljs || (typeof window !== 'undefined' && window.hljs)));
    const bundledText = async (rel) => { const b = await H.bundled.read(rel); if (!b) throw new UserError('ツールのファイルが見つかりません: ' + rel, 500); return toText(b); };
    /**
     * 書き出す HTML のスクリプトの集め役。こちらで入れたインラインのスクリプトだけを覚えておき、
     * CSP（csp()）でそのハッシュだけを許す（原稿に何かが紛れ込んでも、それは動かない）。
     */
    function scriptSet() {
      const codes = [];
      const srcs = [];
      return {
        inline(code) {
          const c = code.replace(/<\/script/gi, '<\\/script');
          codes.push(c);
          return '<script>' + c + '</script>';
        },
        src(url) {
          srcs.push(url);
          return '<script src="' + render.esc(url) + '"></script>';
        },
        /** <meta http-equiv="Content-Security-Policy"> */
        async csp() {
          const hashes = [];
          for (const c of codes) {
            const h = await sha256(c);
            if (h) hashes.push("'sha256-" + h + "'");
          }
          // 外のファイルのスクリプト（mermaid）は、その場所（オリジン）だけを許す。相対パスなら 'self'
          const origins = new Set();
          for (const u of srcs) {
            const m = /^(https?:\/\/[^/]+)/i.exec(u);
            origins.add(m ? m[1] : "'self'");
          }
          const policy = [
            "default-src 'none'",
            'script-src ' + hashes.concat(Array.from(origins)).join(' '),
            "style-src 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-src 'none'",
          ].join('; ');
          return '<meta http-equiv="Content-Security-Policy" content="' + render.esc(policy) + '">';
        },
      };
    }
    async function sha256(text) {
      if (H.sha256) return H.sha256(text);
      const subtle = typeof crypto !== 'undefined' && crypto.subtle;
      if (!subtle) return null;
      return base64(new Uint8Array(await subtle.digest('SHA-256', enc.encode(text))));
    }
    const inlineStyle = (css, label) => '<style' + (label ? ' data-ks="' + render.esc(label) + '"' : '') + '>\n' + css.replace(/<\/style/gi, '<\\/style') + '\n</style>';
    const page = (lines) => lines.filter((l) => l !== '').join('\n') + '\n';
    const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

    /**
     * プロジェクトとテーマを読み、画像の参照先を決める
     * @param {Object} o
     *   assets: 'embed'（data URI。既定）| 'files'（filesDir/… に複製して参照）| 'url'（o.assetUrl(絶対パス) の URL。画面のプレビュー用）
     *   filesDir, assetUrl(fullPath), scriptUrl（mermaid を URL で読むとき）
     */
    async function loadDeck(p, o) {
      o = o || {};
      const deck = await p.read();
      const warnings = [];
      const files = []; // 複製するファイル [{ from, to, bundled }]
      const parsed = parse.parseDeck(deck.md);
      const themeId = deck.design.theme || schema.DEFAULT_THEME;
      let theme = await p.readTheme(themeId);
      if (!theme) {
        warnings.push('テーマ "' + themeId + '" が見つからないため、既定のテーマで書き出しました');
        theme = (await p.readTheme(schema.DEFAULT_THEME)) || {};
      }
      const mode = o.assets || 'embed';
      // 画像を先に読んでおく（render は同期で動くので）
      const resolved = new Map();
      const sources = new Set();
      const collectSrc = (text) => {
        for (const im of parse.findImages(text)) sources.add(im.src);
      };
      collectSrc(deck.md);
      for (const src of sources) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) continue;
        let rel = src.split(/[?#]/)[0];
        try { rel = decodeURIComponent(rel); } catch (e) { /* そのまま */ }
        // プロジェクトの外（../ や絶対パス）は読まない（他人の原稿で、手元の別のファイルを書き出しに入れられないように）
        const full = P.inside(deck.dir, rel);
        if (!full) {
          warnings.push('プロジェクトのフォルダの外にある画像は使えません: ' + rel);
          resolved.set(src, '');
          continue;
        }
        const mime = MIME[P.extname(full).toLowerCase()];
        const s = await H.stat(full);
        let out = src;
        if (!s || !s.isFile) warnings.push('画像が見つかりません: ' + rel);
        else if (!mime) warnings.push('使えない形式の画像です: ' + rel);
        else if (mode === 'embed') out = 'data:' + mime + ';base64,' + base64(await H.readFile(full));
        else if (mode === 'url') out = o.assetUrl(full);
        else {
          const r = P.relative(deck.dir, full) || P.basename(full);
          const to = o.filesDir + '/' + r;
          files.push({ from: full, to });
          out = encodePath(to);
        }
        resolved.set(src, out);
      }
      const resolveAsset = (src) => (resolved.has(src) ? resolved.get(src) : src);
      async function mermaidScript(S) {
        if (o.scriptUrl) return S.src(o.scriptUrl);
        if (mode === 'files') {
          const to = o.filesDir + '/mermaid.min.js';
          files.push({ bundled: 'vendor/mermaid.min.js', to });
          return S.src(encodePath(to));
        }
        return S.inline(await bundledText('vendor/mermaid.min.js'));
      }
      return { deck, parsed, theme, warnings, files, resolveAsset, mermaidScript };
    }

    function head(parsed, title) {
      return [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="generator" content="Kamishibai ' + VERSION + '">',
        parsed.meta.author ? '<meta name="author" content="' + render.esc(parsed.meta.author) + '">' : '',
        '<title>' + render.esc(title) + '</title>',
      ];
    }

    /** スライド（発表用）の HTML */
    async function buildDeck(p, o) {
      o = o || {};
      const L = await loadDeck(p, o);
      const out = render.renderDeck(L.parsed, L.deck.design, L.theme, { md: markdown(), resolveAsset: L.resolveAsset });
      const title = out.title || p.name;
      const config = { title, progress: !!out.resolved.chrome.progress };
      const S = scriptSet();
      // スクリプトを先に組み立てる（CSP のハッシュを head に入れるため）
      const scripts = [
        out.usesMermaid ? await L.mermaidScript(S) : '',
        S.inline(await bundledText('runtime/runtime.js')),
        S.inline('Kamishibai.start(' + JSON.stringify(config).replace(/</g, '\\u003c') + ');'),
        // 図を描き終えたら ks-ready を付ける（PDF 化はこれを待つ）
        out.usesMermaid
          ? S.inline("Kamishibai.renderMermaid(document.body).then(function () { document.documentElement.classList.add('ks-ready'); });")
          : S.inline("document.documentElement.classList.add('ks-ready');"),
      ];
      const html = page([
        '<!doctype html>',
        '<html lang="' + render.esc(L.parsed.meta.lang || 'ja') + '" class="ks-page">',
        '<head>',
        '<meta charset="utf-8">',
        await S.csp(),
        ...head(L.parsed, title).slice(1),
        inlineStyle(await bundledText('runtime/runtime.css'), 'runtime'),
        L.theme.css ? inlineStyle(L.theme.css, 'theme:' + (L.theme.id || '')) : '',
        L.deck.css ? inlineStyle(L.deck.css, 'deck') : '',
        inlineStyle('@page { size: ' + out.width + 'px ' + out.height + 'px; margin: 0; }', 'page'),
        '</head>',
        '<body>',
        render.deckOpenTag(out),
        '<div class="ks-stage">',
        out.slides.map((s) => s.html).join('\n'),
        '</div>',
        '</div>',
        ...scripts,
        '</body>',
        '</html>',
      ]);
      return { html, warnings: L.warnings, files: L.files, slideCount: out.slides.length, title, width: out.width, height: out.height };
    }

    /** 資料（読み物・配布用）の HTML。印刷すると A4 縦になる */
    async function buildDocument(p, o) {
      o = o || {};
      const L = await loadDeck(p, o);
      const out = render.renderDocument(L.parsed, L.deck.design, L.theme, { md: markdown(), resolveAsset: L.resolveAsset, notes: !!o.notes });
      const title = out.title || p.name;
      const S = scriptSet();
      const scripts = [
        out.usesMermaid ? await L.mermaidScript(S) : '',
        out.usesMermaid ? S.inline(await bundledText('runtime/runtime.js')) : '',
        out.usesMermaid
          ? S.inline("Kamishibai.renderMermaid(document.body).then(function () { document.documentElement.classList.add('ks-ready'); });")
          : S.inline("document.documentElement.classList.add('ks-ready');"),
      ];
      const html = page([
        '<!doctype html>',
        '<html lang="' + render.esc(L.parsed.meta.lang || 'ja') + '" class="ks-doc-page">',
        '<head>',
        '<meta charset="utf-8">',
        await S.csp(),
        ...head(L.parsed, title).slice(1),
        inlineStyle(await bundledText('runtime/doc.css'), 'doc'),
        inlineStyle('@page { size: A4; margin: 18mm 16mm; }', 'page'),
        '</head>',
        '<body>',
        '<div style="' + render.esc(render.tokensToStyle(out.resolved.tokens)) + '">',
        '<article class="ks-doc">',
        out.html,
        '</article>',
        '</div>',
        ...scripts,
        '</body>',
        '</html>',
      ]);
      return { html, warnings: L.warnings, files: L.files, title };
    }

    /** 書き出し先（指定が無ければ、フォルダのプロジェクトは dist/、.kami はその隣） */
    // 指定された書き出し先の拡張子が形式と違えば、形式の拡張子を付ける（.hta などの別の種類のファイルとして書かれないように）
    const outPath = (p, out, suffix) => {
      if (!out) return P.join(p.defaultOutDir(), p.name + suffix);
      const want = suffix.slice(suffix.lastIndexOf('.')).toLowerCase();
      const file = H.absolute(out);
      return file.toLowerCase().endsWith(want) ? file : file + want;
    };
    const filesDirFor = (file) => P.basename(file, P.extname(file)) + '_files';

    async function writeOut(file, result) {
      await H.mkdir(P.dirname(file));
      const bytes = enc.encode(result.html);
      await H.writeFile(file, bytes);
      for (const f of result.files || []) {
        const to = P.join(P.dirname(file), ...f.to.split('/'));
        await H.mkdir(P.dirname(to));
        await H.writeFile(to, f.bundled ? await H.bundled.read(f.bundled) : await H.readFile(f.from));
      }
      return Object.assign(result, { file, bytes: bytes.length });
    }

    async function exportDeck(p, o) {
      o = o || {};
      const file = outPath(p, o.out, '.html');
      return writeOut(file, await buildDeck(p, { assets: o.embed === false ? 'files' : 'embed', filesDir: filesDirFor(file) }));
    }
    async function exportDocument(p, o) {
      o = o || {};
      const file = outPath(p, o.out, '-資料.html');
      return writeOut(file, await buildDocument(p, { assets: o.embed === false ? 'files' : 'embed', filesDir: filesDirFor(file), notes: o.notes }));
    }
    /** PDF。HTML を一時フォルダに作り、host.pdf で印刷する */
    async function exportPdf(p, o) {
      o = o || {};
      if (!H.pdf) throw new UserError('この環境では PDF を作れません。HTML を書き出して、ブラウザの印刷（Ctrl+P）→「PDF に保存」をお使いください。', 501);
      const doc = o.kind === 'doc';
      const built = doc ? await buildDocument(p, { notes: o.notes }) : await buildDeck(p);
      const file = outPath(p, o.out, doc ? '-資料.pdf' : '.pdf');
      const tmp = P.join(H.tempDir(), 'kamishibai-print-' + hash(file + Date.now()));
      await H.mkdir(tmp);
      try {
        const html = P.join(tmp, 'print.html');
        await H.writeFile(html, built.html);
        await H.mkdir(P.dirname(file));
        await H.removeFile(file);
        await H.pdf(html, file, { kind: doc ? 'doc' : 'slides', width: built.width, height: built.height });
        const s = await H.stat(file);
        if (!s) throw new UserError('PDF の生成に失敗しました', 500);
        return { file, bytes: s.size, warnings: built.warnings };
      } finally {
        await H.removeDir(tmp);
      }
    }
    /** 画面で組み立てたファイル（Word / ODT / PowerPoint / ODP）を保存する */
    async function saveExportFile(p, kind, format, out, bytes) {
      if (!/^(docx|odt|pptx|odp)$/.test(format)) throw new UserError('対応していない形式です: ' + format);
      const file = outPath(p, out, (kind === 'doc' ? '-資料.' : '.') + format);
      await H.mkdir(P.dirname(file));
      await H.writeFile(file, bytes);
      return { file, bytes: bytes.length, warnings: [] };
    }

    // ==================================================================
    // JSON API（ブラウザ版はこれを HTTP で、アプリは直接呼ぶ）
    // ==================================================================
    const exported = new Set(); // 書き出したファイル（「フォルダを表示」を許可するもの）
    const flag = (v) => v === true || v === '1' || v === 'true';
    const summary = (p) => (p ? { name: p.name, dir: p.dir, kamiFile: p.kamiFile, temporary: p.temporary } : null);
    function current() {
      if (!project) throw new UserError('プロジェクトが開かれていません', 409);
      return project;
    }
    const bodyJson = (b) => {
      if (b == null || b === '') return {};
      if (typeof b === 'object' && !(b instanceof Uint8Array)) return b;
      try { return JSON.parse(toText(b)); } catch (e) { throw new UserError('JSON を解釈できません'); }
    };
    const bodyBytes = (b) => (b instanceof Uint8Array ? b : typeof b === 'string' ? enc.encode(b) : enc.encode(JSON.stringify(b || '')));

    /**
     * @param {string} method GET / POST / PUT
     * @param {string[]} seg  '/api/project/md' → ['api', 'project', 'md']
     * @param {Object} query  { name: value }
     * @param {*} body        Uint8Array / 文字列 / オブジェクト
     * @returns {Promise<{status, json}>}
     */
    async function api(method, seg, query, body) {
      query = query || {};
      const ok = (json, status) => ({ status: status || 200, json });
      if (seg[1] === 'state' && method === 'GET') {
        const lib = project || { listThemes: themeLibrary(null).listThemes };
        return ok({ version: VERSION, desktop: !!opts.desktop, project: summary(project), themes: await lib.listThemes(), recent: await readRecent() });
      }
      if (method === 'POST' && ['open', 'new', 'sample', 'close', 'save-as'].includes(seg[1]) && seg.length === 2) {
        const b = bodyJson(body);
        const target = String(b.path || '').trim();
        if (seg[1] === 'open') await open(target);
        if (seg[1] === 'new') {
          if (!target) throw new UserError('作成する場所を指定してください');
          if (b.kind === 'kami' || target.toLowerCase().endsWith(KAMI_EXT)) await createKami(target, { title: b.title, theme: b.theme });
          else await createFolder(target, { title: b.title, theme: b.theme });
        }
        if (seg[1] === 'sample') await openSample();
        if (seg[1] === 'close') await close();
        if (seg[1] === 'save-as') {
          if (!target) throw new UserError('保存する場所を指定してください');
          if (b.kind === 'kami' || target.toLowerCase().endsWith(KAMI_EXT)) await saveAsKami(target);
          else await saveAsFolder(target);
        }
        return ok({ project: summary(project) });
      }
      if (seg[1] === 'reveal' && method === 'POST') {
        const file = H.absolute(String(bodyJson(body).path || ''));
        const p = project;
        const rel = p ? P.relative(p.dir, file) : null;
        const inProject = p && (P.same(file, p.dir) || (p.kamiFile && P.same(file, p.kamiFile)) || (rel != null && rel !== '..' && !rel.startsWith('../')));
        const allowed = Array.from(exported).some((f) => P.same(f, file)) || inProject;
        if (!allowed || !(await exists(file))) throw new UserError('ファイルが見つかりません', 404);
        if (H.reveal) await H.reveal(file);
        return ok({ ok: true });
      }
      if (seg[1] === 'project') {
        const p = current();
        const action = seg[2];
        if (!action && method === 'GET') return ok(Object.assign(await p.read(), { kamiFile: p.kamiFile, temporary: p.temporary }));
        if (action === 'stat' && method === 'GET') return ok(await p.stat());
        if (action === 'md' && method === 'PUT') return ok({ mtime: await p.writeMd(toText(bodyBytes(body))) });
        if (action === 'design' && method === 'PUT') return ok({ mtime: await p.writeDesign(bodyJson(body)) });
        if (action === 'assets' && method === 'POST') return ok({ path: await p.saveAsset(query.name, bodyBytes(body)) }, 201);
        if (action === 'file' && method === 'PUT') return ok({ path: await p.writeAsset(query.path, bodyBytes(body)) });
        if (action === 'export' && method === 'POST') {
          const b = bodyJson(body);
          const kind = b.kind === 'doc' ? 'doc' : 'slides';
          const o = { out: b.out || null, notes: flag(b.notes), embed: b.embed !== false };
          const r = b.format === 'pdf' ? await exportPdf(p, Object.assign({ kind }, o)) : kind === 'doc' ? await exportDocument(p, o) : await exportDeck(p, o);
          exported.add(r.file);
          return ok({ file: r.file, bytes: r.bytes, warnings: r.warnings, files: (r.files || []).length });
        }
        if (action === 'export-file' && method === 'POST') {
          const r = await saveExportFile(p, query.kind === 'doc' ? 'doc' : 'slides', String(query.format || ''), query.out || null, bodyBytes(body));
          exported.add(r.file);
          return ok(r);
        }
      }
      if (seg[1] === 'themes' && seg.length === 3 && method === 'POST') {
        const b = bodyJson(body);
        if (seg[2] === 'import') {
          try {
            return ok(await importThemes(b.path, { overwrite: !!b.overwrite }));
          } catch (e) {
            if (e.exists) return { status: 409, json: { error: e.message, exists: e.exists } };
            throw e;
          }
        }
        if (seg[2] === 'export') return ok(await exportTheme(String(b.id || ''), b.out));
        if (seg[2] === 'reveal') {
          // ユーザーのテーマのフォルダを開く（自分で theme.json を書いて置く人向け）
          await H.mkdir(userThemesDir());
          if (H.reveal) await H.reveal(userThemesDir());
          return ok({ dir: userThemesDir() });
        }
      }
      if (seg[1] === 'themes' && seg.length === 3 && method === 'PUT') {
        const lib = project || themeLibrary(null);
        return ok(await lib.writeTheme(seg[2], bodyJson(body)));
      }
      return { status: 404, json: { error: 'Not found' } };
    }

    /** プロジェクト内のファイル（プレビューの画像など）を読む。外を指すものは null */
    async function projectFile(rel) {
      const p = current();
      const full = P.inside(p.dir, rel);
      if (!full) return null;
      const s = await H.stat(full);
      if (!s || !s.isFile) return null;
      return { path: full, data: await H.readFile(full), mime: MIME[P.extname(full).toLowerCase()] || 'application/octet-stream', size: s.size, mtime: s.mtime };
    }

    return {
      VERSION, KAMI_EXT, UserError, MIME,
      api, projectFile,
      get project() { return project; },
      open, openFolder, openKami, openSample, createFolder, createKami, saveAsKami, saveAsFolder, flush, close, recent: readRecent,
      createProject, initProject, packProject, unpackKami, themeLibrary,
      buildDeck, buildDocument, exportDeck, exportDocument, exportPdf, saveExportFile, outPath,
      markExported: (f) => exported.add(f),
    };
  }

  return { createBackend, UserError, VERSION, KAMI_EXT, hash, assertThemeId };
});
