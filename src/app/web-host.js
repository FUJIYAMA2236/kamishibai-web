/*
 * web-host.js — Web 版（Cloudflare Pages などの静的ホスティング）のときだけ働く。
 * デスクトップアプリ（tauri-host.js）と同じように、バックエンド（backend.js）をこの画面の中で動かす。
 * ファイル操作はブラウザの中の仮想ファイル（メモリ + IndexedDB）で行う。
 *
 *   ・File System Access API のあるブラウザ（Chrome / Edge）… 選んだ .kami・フォルダに直接書き戻す（デスクトップ版とほぼ同じ）
 *   ・無いブラウザ（Firefox / Safari）… 開く = アップロード、保存・書き出し = ダウンロード。作業中の内容はブラウザ内に自動保存
 *
 * 画面（editor.js）から見える窓口は tauri-host.js と同じ: window.KSDesktop / window.kamishibaiApp。
 * Web 版のビルド（scripts/build-web.js）でだけ index.html に入る。
 */
(function () {
  'use strict';
  if (window.__TAURI__ || window.KSDesktop) return;
  const KS = window.KS;
  const P = KS.pathx;
  const enc = new TextEncoder();
  window.KSWeb = true;

  const FSA = typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function' && typeof window.showDirectoryPicker === 'function';
  const SKIP = (n) => n === 'dist' || n === 'node_modules' || n.startsWith('.');
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.html': 'text/html', '.json': 'application/json', '.zip': 'application/zip', '.kami': 'application/octet-stream', '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.odt': 'application/vnd.oasis.opendocument.text', '.odp': 'application/vnd.oasis.opendocument.presentation' };
  const mimeOf = (p) => MIME[P.extname(p).toLowerCase()] || 'application/octet-stream';
  const rid = () => Math.random().toString(36).slice(2, 10);
  const toast = (m, err) => { if (window.KSE && window.KSE.toast) window.KSE.toast(m, err); else if (err) alert(m); };
  const isAbort = (e) => e && (e.name === 'AbortError' || e.name === 'NotAllowedError' && /user/i.test(e.message || ''));

  // ==================================================================
  // 仮想ファイル（パスは「/」区切り。全部メモリに持ち、IndexedDB に書き写す）
  // ==================================================================
  const files = new Map(); // path → { data: Uint8Array, mtime, v }
  const dirs = new Map(); // path → mtime
  let db = null;
  let version = 0;
  const norm = (p) => P.resolve('/', String(p || '').replace(/\\/g, '/'));
  const parentsOf = (p) => { const out = []; let d = P.dirname(p); while (d && d !== '/' && !dirs.has(d)) { out.push(d); d = P.dirname(d); } return out; };
  const under = (base, p) => p === base || p.startsWith(base === '/' ? '/' : base + '/');

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('kamishibai-web', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('files'); d.createObjectStore('dirs'); d.createObjectStore('mounts'); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  /** IndexedDB への書き込み（ops: [[store, 'put'|'delete', key, value]]） */
  function persist(ops) {
    if (!db || !ops.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['files', 'dirs', 'mounts'], 'readwrite');
      for (const [store, op, key, value] of ops) {
        if (op === 'put') t.objectStore(store).put(value, key);
        else t.objectStore(store).delete(key);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('ブラウザ内への保存に失敗しました（容量が足りない可能性があります）'));
    });
  }
  function idbAll(store) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readonly');
      const s = t.objectStore(store);
      const keys = s.getAllKeys();
      const vals = s.getAll();
      t.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
      t.onerror = () => reject(t.error);
    });
  }

  const vfs = {
    stat(p) {
      p = norm(p);
      const f = files.get(p);
      if (f) return { isDir: false, isFile: true, size: f.data.length, mtime: f.mtime };
      if (p === '/' || dirs.has(p)) return { isDir: true, isFile: false, size: 0, mtime: dirs.get(p) || 0 };
      return null;
    },
    read(p) {
      const f = files.get(norm(p));
      if (!f) throw new Error('見つかりません: ' + p);
      return f.data;
    },
    async write(p, data) {
      p = norm(p);
      if (dirs.has(p)) throw new Error('フォルダです: ' + p);
      const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
      const now = Date.now();
      const ops = [];
      for (const d of parentsOf(p)) { dirs.set(d, now); ops.push(['dirs', 'put', d, now]); }
      const rec = { data: bytes, mtime: now, v: ++version };
      files.set(p, rec);
      ops.push(['files', 'put', p, { data: bytes, mtime: now }]);
      await persist(ops);
    },
    async mkdir(p) {
      p = norm(p);
      if (p === '/' || dirs.has(p)) return;
      if (files.has(p)) throw new Error('同じ名前のファイルがあります: ' + p);
      const now = Date.now();
      const ops = [];
      for (const d of [p].concat(parentsOf(p))) { dirs.set(d, now); ops.push(['dirs', 'put', d, now]); }
      await persist(ops);
    },
    list(p) {
      p = norm(p);
      if (!this.stat(p) || !this.stat(p).isDir) throw new Error('フォルダが見つかりません: ' + p);
      const out = new Map();
      const prefix = p === '/' ? '/' : p + '/';
      const add = (q, isDir) => {
        if (!q.startsWith(prefix)) return;
        const rest = q.slice(prefix.length);
        if (!rest || rest.indexOf('/') >= 0) return;
        out.set(rest, isDir);
      };
      for (const q of dirs.keys()) add(q, true);
      for (const q of files.keys()) add(q, false);
      return Array.from(out, ([name, isDir]) => ({ name, isDir }));
    },
    async removeFile(p) {
      p = norm(p);
      if (!files.delete(p)) return;
      await persist([['files', 'delete', p]]);
    },
    async removeDir(p) {
      p = norm(p);
      const ops = [];
      for (const q of Array.from(files.keys())) if (under(p, q)) { files.delete(q); ops.push(['files', 'delete', q]); }
      for (const q of Array.from(dirs.keys())) if (under(p, q)) { dirs.delete(q); ops.push(['dirs', 'delete', q]); }
      await persist(ops);
    },
    async rename(a, b) {
      a = norm(a); b = norm(b);
      if (a === b) return;
      const ops = [];
      const now = Date.now();
      for (const d of parentsOf(b)) { dirs.set(d, now); ops.push(['dirs', 'put', d, now]); }
      if (files.has(a)) {
        const f = files.get(a);
        files.delete(a);
        ops.push(['files', 'delete', a]);
        files.set(b, { data: f.data, mtime: now, v: ++version });
        ops.push(['files', 'put', b, { data: f.data, mtime: now }]);
      } else if (dirs.has(a)) {
        for (const q of Array.from(dirs.keys())) if (under(a, q)) { const t = b + q.slice(a.length); dirs.delete(q); dirs.set(t, now); ops.push(['dirs', 'delete', q], ['dirs', 'put', t, now]); }
        for (const q of Array.from(files.keys())) if (under(a, q)) {
          const t = b + q.slice(a.length);
          const f = files.get(q);
          files.delete(q);
          files.set(t, { data: f.data, mtime: f.mtime, v: ++version });
          ops.push(['files', 'delete', q], ['files', 'put', t, { data: f.data, mtime: f.mtime }]);
        }
      } else {
        throw new Error('見つかりません: ' + a);
      }
      await persist(ops);
    },
  };

  // ==================================================================
  // 手元の .kami とのつながり（File System Access API のハンドル）
  //   mounts: 仮想ファイルのパス → { kind: 'file', handle }
  //   そのパスに書いたもの（.kami の保存）は、手元のファイルにも書き戻す
  // ==================================================================
  const mounts = new Map();
  async function addMount(path, handle) {
    mounts.set(path, { kind: 'file', handle });
    await persist([['mounts', 'put', path, { kind: 'file', handle }]]);
  }
  async function dropMount(path) {
    mounts.delete(path);
    await persist([['mounts', 'delete', path]]);
  }
  /** p が手元のファイルにつながっていれば、その中身を書き戻す */
  async function mirror(p) {
    const m = mounts.get(p);
    if (!m || !files.has(p)) return;
    try {
      const w = await m.handle.createWritable();
      await w.write(files.get(p).data);
      await w.close();
    } catch (e) {
      throw new Error('手元のファイルに書き込めませんでした（' + (e.message || e.name) + '）。ファイルメニューから保存し直してください');
    }
  }

  // ==================================================================
  // バックエンドに渡す host
  // ==================================================================
  let manifest = null;
  const bundleList = async () => manifest || (manifest = await (await fetch('/bundle.json')).json());
  const host = {
    platform: 'web',
    async readFile(p) { return vfs.read(p); },
    async writeFile(p, data) { p = norm(p); await vfs.write(p, data); await mirror(p); },
    async stat(p) { return vfs.stat(p); },
    async readDir(p) { return vfs.list(p); },
    async mkdir(p) { await vfs.mkdir(p); },
    async removeFile(p) { await vfs.removeFile(p); },
    async removeDir(p) { await vfs.removeDir(p); },
    async rename(a, b) {
      a = norm(a); b = norm(b);
      await vfs.rename(a, b);
      await mirror(b); // .kami の保存は「.saving に書いてから名前を変える」なので、ここで書き戻す
    },
    userDataDir: () => '/userdata',
    tempDir: () => '/tmp',
    absolute: (p) => norm(p),
    bundled: {
      async read(rel) {
        const parts = rel.split('/');
        if (parts[0] === 'themes' || parts[0] === 'sample') {
          let node = await bundleList();
          for (const part of parts) { node = node && Object.prototype.hasOwnProperty.call(node, part) ? node[part] : undefined; }
          if (node !== null) return null;
        }
        const res = await fetch('/' + parts.map(encodeURIComponent).join('/'));
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      },
      async list(rel) {
        let node = await bundleList();
        for (const part of rel.split('/')) { node = node && node[part]; }
        return node ? Object.keys(node).map((name) => ({ name, isDir: node[name] !== null })) : [];
      },
    },
    zip: { write: (entries) => KS.zip.writeZipAsync(entries), read: (bytes) => KS.zip.readZipAsync(bytes) },
    // pdf は無い（印刷ダイアログを使う。下の api() を参照）
  };

  const backend = KS.backend.createBackend(host, { desktop: true });

  // ==================================================================
  // ダウンロード（File System Access API の無いブラウザで保存・書き出しするとき）
  // ==================================================================
  const pendingDownloads = new Set();
  function downloadBytes(name, bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function flushDownloads() {
    for (const p of Array.from(pendingDownloads)) {
      if (files.has(p)) { pendingDownloads.delete(p); downloadBytes(P.basename(p), files.get(p).data, mimeOf(p)); }
    }
  }
  // ==================================================================
  // ファイル・フォルダを選ぶ
  // ==================================================================
  const slot = () => '/local/' + rid();
  const safeName = (s, def) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || def;

  /** <input type="file"> で選ぶ（キャンセルなら []） */
  function pickInput(o) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (o.accept) input.accept = o.accept;
      if (o.multiple) input.multiple = true;
      if (o.directory) input.webkitdirectory = true;
      input.style.display = 'none';
      document.body.appendChild(input);
      const done = (list) => { input.remove(); resolve(list); };
      input.addEventListener('change', () => done(Array.from(input.files || [])));
      input.addEventListener('cancel', () => done([]));
      input.click();
    });
  }
  async function importFileList(list, to) {
    await vfs.mkdir(to);
    for (const f of list) {
      const parts = (f.webkitRelativePath || f.name).split('/');
      if (f.webkitRelativePath) parts.shift(); // 先頭は選んだフォルダの名前
      if (parts.some(SKIP)) continue;
      await vfs.write(P.join(to, ...parts), new Uint8Array(await f.arrayBuffer()));
    }
  }
  async function importDirHandle(dh, to) {
    await vfs.mkdir(to);
    for await (const [name, h] of dh.entries()) {
      if (SKIP(name)) continue;
      if (h.kind === 'directory') await importDirHandle(h, P.join(to, name));
      else await vfs.write(P.join(to, name), new Uint8Array(await (await h.getFile()).arrayBuffer()));
    }
  }
  const fsaTypes = (desc, ext) => [{ description: desc, accept: { [ext === '.html' ? 'text/html' : 'application/octet-stream']: [ext] } }];

  /** .kami を開く → 仮想ファイルのパス */
  async function pickOpenKami() {
    if (FSA) {
      let h;
      try { [h] = await window.showOpenFilePicker({ types: fsaTypes('Kamishibai ファイル', '.kami'), excludeAcceptAllOption: false }); } catch (e) { if (isAbort(e)) return null; throw e; }
      const file = await h.getFile();
      const p = P.join(slot(), file.name);
      await vfs.write(p, new Uint8Array(await file.arrayBuffer()));
      await addMount(p, h);
      return p;
    }
    const [f] = await pickInput({ accept: '.kami' });
    if (!f) return null;
    const p = P.join(slot(), f.name);
    await vfs.write(p, new Uint8Array(await f.arrayBuffer()));
    return p;
  }
  /** 保存するファイルを選ぶ → 仮想ファイルのパス（ダウンロードになるときは pendingDownloads に入れる） */
  async function pickSaveFile(name, ext, desc) {
    if (!name.toLowerCase().endsWith(ext)) name += ext;
    if (FSA) {
      let h;
      try { h = await window.showSaveFilePicker({ suggestedName: name, types: fsaTypes(desc, ext) }); } catch (e) { if (isAbort(e)) return null; throw e; }
      const p = P.join(slot(), h.name.toLowerCase().endsWith(ext) ? h.name : h.name + ext);
      await addMount(p, h);
      return p;
    }
    const p = P.join(slot(), safeName(name, 'untitled' + ext));
    pendingDownloads.add(p);
    return p;
  }
  /** 手元のファイルとつながっているなら、使ってよいか確かめ、最新の中身を読み直す。使えなければ切り離す */
  async function refreshMount(p, ask) {
    const m = mounts.get(p);
    if (!m) return true;
    try {
      let perm = await m.handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && ask) perm = await m.handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return false;
      await vfs.write(p, new Uint8Array(await (await m.handle.getFile()).arrayBuffer()));
      return true;
    } catch (e) {
      console.warn('[kamishibai] 手元のファイルを読めません:', e);
      return false;
    }
  }

  // ==================================================================
  // API（ブラウザ版の /api/… と同じ）
  // ==================================================================
  let unsavedEdits = false;
  /** .kami の置き場所を人に見せる形に（中のパス /local/… は見せない） */
  const describe = (p) => P.basename(p || '') + (mounts.has(p) ? '（手元のファイルに自動保存）' : '（このブラウザの中に自動保存）');
  async function api(method, url, body) {
    await ready;
    const u = new URL(url, 'http://app');
    const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let data = body;
    if (body instanceof Blob) data = new Uint8Array(await body.arrayBuffer());
    // 書き出しの HTML は画像を埋め込む（隣の _files フォルダはダウンロードできないため）
    if (seg[1] === 'project' && seg[2] === 'export' && data && typeof data === 'object' && !(data instanceof Uint8Array)) {
      data = Object.assign({}, data, { embed: true });
      if (data.format === 'pdf') return printPdf(data);
    }
    const r = await backend.api(method, seg, Object.fromEntries(u.searchParams), data);
    if (r.status >= 400) throw new Error((r.json && r.json.error) || String(r.status));
    // 最近使ったもの: .kami だけ。中のパス（/local/…）は見せず、どこに保存されているかを書く
    if (seg[1] === 'state' && r.json && Array.isArray(r.json.recent)) {
      r.json.recent = r.json.recent.filter((x) => x.kind === 'kami').map((x) => Object.assign({}, x, {
        label: describe(x.path),
      }));
    }
    if (method !== 'GET' && seg[1] === 'project' && seg[2] !== 'export' && seg[2] !== 'export-file' && backend.project && backend.project.temporary) unsavedEdits = true;
    if (pendingDownloads.size) {
      const n = pendingDownloads.size;
      await flushDownloads();
      if (r.json && r.json.file && n !== pendingDownloads.size) r.json.downloaded = true;
    }
    return r.json;
  }

  /** PDF: HTML を別ウィンドウで開いて印刷ダイアログを出す（「PDF に保存」を選んでもらう） */
  async function printPdf(b) {
    const p = backend.project;
    if (!p) throw new Error('プロジェクトが開かれていません');
    const w = window.open('', '_blank');
    if (!w) throw new Error('ポップアップがブロックされました。このサイトのポップアップを許可してから、もう一度お試しください');
    const doc = b.kind === 'doc';
    const o = { assets: 'embed', scriptUrl: location.origin + '/vendor/mermaid.min.js', notes: !!b.notes };
    const built = doc ? await backend.buildDocument(p, o) : await backend.buildDeck(p, o);
    showPage(w, 'print', built.html);
    const start = Date.now();
    await new Promise((resolve) => {
      const tick = () => {
        let ready = false;
        try { ready = w.location.pathname.indexOf('/viewer') === 0 && w.document.documentElement.classList.contains('ks-ready'); } catch (e) { /* 読み込み中 */ }
        if (ready || w.closed || Date.now() - start > 20000) return resolve();
        setTimeout(tick, 150);
      };
      tick();
    });
    if (!w.closed) setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* ウィンドウが閉じられた */ } }, 300);
    return { file: '', print: true, bytes: built.html.length, warnings: built.warnings || [], files: 0 };
  }

  // ---- 画面で表示する URL（仮想ファイル → blob: URL）----
  const urlCache = new Map(); // path → { v, url }
  function blobUrlOf(full) {
    const f = files.get(full);
    if (!f) return '';
    const c = urlCache.get(full);
    if (c && c.v === f.v) return c.url;
    if (c) URL.revokeObjectURL(c.url);
    const url = URL.createObjectURL(new Blob([f.data], { type: mimeOf(full) }));
    urlCache.set(full, { v: f.v, url });
    return url;
  }
  /** プロジェクト内のファイル（画像）を画面で表示する URL。末尾の「#」は、エディタが付ける「?v=…」を URL の外に出すため */
  function fileUrl(rel) {
    const p = backend.project;
    if (!p) return rel;
    let clean = String(rel).split(/[?#]/)[0];
    try { clean = decodeURI(clean); } catch (e) { /* そのまま */ }
    const full = P.inside(p.dir, clean);
    const url = full ? blobUrlOf(norm(full)) : '';
    return url ? url + '#' : '';
  }

  // ---- 発表・資料のプレビュー（別ウィンドウ） ----
  //   組み立てた HTML は /viewer/ のページが受け取って書き込む（app/viewer.js）。
  //   blob: の URL で開くと、エディタの CSP（インラインのスクリプトを動かさない）を引き継いでしまい、発表画面が動かないため。
  const pages = {};
  function showPage(w, kind, html, hash) {
    pages[kind] = html;
    w.location.href = '/viewer/?k=' + encodeURIComponent(kind) + '&n=' + rid() + (hash || '');
  }
  async function openPage(kind, hash, notes) {
    await ready;
    const p = backend.project;
    if (!p) return;
    // 先にウィンドウを開く（組み立てを待つとポップアップブロックに掛かることがある）
    const w = window.open('', 'ks-' + kind);
    if (!w) { toast('ポップアップがブロックされました。このサイトのポップアップを許可してから、もう一度お試しください', true); return; }
    try {
      const o = { assets: 'embed', scriptUrl: location.origin + '/vendor/mermaid.min.js', notes };
      const built = kind === 'present' ? await backend.buildDeck(p, o) : await backend.buildDocument(p, o);
      showPage(w, kind, built.html, hash);
      w.focus();
    } catch (e) {
      w.close();
      throw e;
    }
  }

  // ---- 起動 ----
  const ready = (async () => {
    try {
      db = await idbOpen();
      for (const [k, v] of await idbAll('dirs')) dirs.set(k, v);
      for (const [k, v] of await idbAll('files')) files.set(k, { data: v.data, mtime: v.mtime, v: ++version });
      for (const [k, v] of await idbAll('mounts')) mounts.set(k, v);
    } catch (e) {
      db = null;
      console.warn('[kamishibai] IndexedDB を使えません。閉じると内容は消えます:', e);
    }
    // 一時ファイル・前回の書き出しは片付ける
    await vfs.removeDir('/tmp');
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 任意 */ }
  })();

  window.KSDesktop = {
    api,
    fileUrl,
    present: (index) => openPage('present', '#' + (index + 1)),
    /** /viewer/ のページが、表示する HTML を受け取る */
    describe: (p) => describe(p),
    page: (kind) => (Object.prototype.hasOwnProperty.call(pages, kind) ? pages[kind] : null),
    docPreview: (notes) => openPage('doc', '', notes),
    backend,
    ready,
    web: true,
    fsa: FSA,
  };

  // ==================================================================
  // ファイルメニュー
  // ==================================================================
  const restart = () => window.KSE && window.KSE.restart();
  async function run(fn) {
    try {
      await ready;
      const before = backend.project;
      await fn();
      if (backend.project !== before || !(backend.project && backend.project.temporary)) unsavedEdits = false;
      await restart();
    } catch (e) {
      if (isAbort(e)) return;
      toast(e.message || String(e), true);
    }
  }
  const browserOnlyNote = () => {
    if (!FSA) toast('ダウンロードしました。以降の変更はこのブラウザの中に自動保存されます（ダウンロードしたファイルは変わりません）');
  };

  async function saveAsKamiDialog() {
    const p = backend.project;
    const file = await pickSaveFile((p ? p.name.replace(/（.*）/, '') : '発表'), '.kami', 'Kamishibai ファイル');
    if (!file) return false;
    await backend.saveAsKami(file);
    await flushDownloads();
    browserOnlyNote();
    unsavedEdits = false;
    return true;
  }

  let asking = false;
  async function confirmLeave(what) {
    await ready;
    const p = backend.project;
    if (!p || !p.temporary || !unsavedEdits) return true;
    if (asking) return false;
    asking = true;
    try {
      if (window.KSE && window.KSE.flushSave) await window.KSE.flushSave();
      const name = p.name.replace(/（.*）/, '');
      if (confirm('「' + name + '」はまだ保存していません。' + what + '前に保存しますか？\n\n［OK］保存する　［キャンセル］保存しない・やめる')) {
        try { return await saveAsKamiDialog(); } catch (e) { toast(e.message || String(e), true); return false; }
      }
      return confirm('保存しないで続けますか？　加えた変更は失われます。');
    } finally { asking = false; }
  }
  const leave = (what, fn) => async () => { if (await confirmLeave(what)) await run(fn); };

  window.kamishibaiApp = {
    desktop: true,
    web: true,
    // Web 版は .kami だけを扱う（フォルダの形のプロジェクトは作らない・開かない）
    newProject: () => leave('新しく作る', async () => {
      const target = await pickSaveFile('新しい発表', '.kami', 'Kamishibai ファイル');
      if (!target) return;
      const download = pendingDownloads.has(target);
      pendingDownloads.delete(target); // 新規作成ではダウンロードしない（保存するときに）
      await backend.createKami(target);
      if (download) toast('このブラウザの中に作りました。手元に残すときは、ファイルメニューの「1 ファイル（.kami）として保存」でダウンロードしてください');
    })(),
    openFile: leave('別のものを開く', async () => {
      const file = await pickOpenKami();
      if (file) await backend.open(file);
    }),
    openPath: (p) => leave('別のものを開く', async () => {
      if (!files.has(norm(p)) || !/\.kami$/i.test(p)) throw new Error('Web 版で開けるのは .kami ファイルだけです');
      if (mounts.has(p) && !(await refreshMount(p, true))) {
        await dropMount(p);
        toast('手元のファイルを使う許可が得られなかったため、このブラウザの中のコピーを開きます');
      }
      await backend.open(p);
    })(),
    openSample: leave('サンプルを開く', () => backend.openSample()),
    saveAsKami: () => run(saveAsKamiDialog),
    close: leave('閉じる', () => backend.close()),
    reveal: async () => {},
    async openExported(file) {
      const f = files.get(norm(file));
      if (!f) return;
      const w = window.open('', '_blank');
      if (w) showPage(w, 'exported', new TextDecoder().decode(f.data));
    },
    async pickThemeSource(kind) {
      await ready;
      const to = P.join('/tmp', 'theme-' + rid());
      if (kind === 'folder') {
        if (FSA) {
          let dh;
          try { dh = await window.showDirectoryPicker({ mode: 'read' }); } catch (e) { if (isAbort(e)) return null; throw e; }
          const p = P.join(to, dh.name);
          await importDirHandle(dh, p);
          return p;
        }
        const list = await pickInput({ directory: true });
        if (!list.length) return null;
        const p = P.join(to, (list[0].webkitRelativePath || 'theme').split('/')[0]);
        await importFileList(list, p);
        return p;
      }
      // theme.json（と theme.css）か zip
      const list = await pickInput({ accept: '.json,.css,.zip', multiple: true });
      if (!list.length) return null;
      const zip = list.find((f) => /\.zip$/i.test(f.name));
      const json = list.find((f) => /\.json$/i.test(f.name));
      const dir = P.join(to, zip ? 'zip' : 'theme');
      await importFileList(zip ? [zip] : list, dir);
      if (zip) return P.join(dir, zip.name);
      return json ? P.join(dir, json.name) : P.join(dir, list[0].name);
    },
    async pickThemeExport(id) {
      await ready;
      return pickSaveFile(id, '.zip', 'zip');
    },
    async chooseExportPath(o) {
      await ready;
      if (o.format === 'pdf') return 'print';
      const p = backend.project;
      const names = { html: 'HTML', docx: 'Word', odt: 'OpenDocument テキスト', pptx: 'PowerPoint', odp: 'OpenDocument プレゼンテーション' };
      const base = (p ? p.name.replace(/（.*）/, '') : '発表') + (o.kind === 'doc' ? '-資料' : '');
      return pickSaveFile(base, '.' + o.format, names[o.format] || o.format);
    },
  };

  // ---- 起動時: 前回開いていたものを開く（手元のファイルで、許可が切れているものは開かない）----
  window.KSDesktop.startup = (async () => {
    await ready;
    let openLast = true;
    try { openLast = localStorage.getItem('ks.openLast') !== '0'; } catch (e) { /* 既定のまま */ }
    if (!openLast) return;
    try {
      const list = await backend.recent();
      const last = list[0];
      if (!last || last.kind !== 'kami') return;
      if (mounts.has(last.path) && !(await refreshMount(last.path, false))) return; // スタート画面の「最近使ったもの」から開く
      await backend.open(last.path);
    } catch (e) { /* スタート画面を出す */ }
  })();

  // 保存していないサンプルなどを閉じようとしたら、ブラウザの確認を出す
  window.addEventListener('beforeunload', (e) => {
    const p = backend.project;
    if (p && p.temporary && unsavedEdits) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => { backend.flush(); });
})();
