/*
 * odp.js — スライドのシーン（editor/export-scene.js）→ OpenDocument プレゼンテーション（.odp）の zip の中身。
 * LibreOffice Impress・PowerPoint・Google スライドで開ける国際標準（ISO/IEC 26300）の形式。
 *
 *   buildOdp(scenes, opts) → [{ name, data, store? }]（引数は pptx.js の buildPptx と同じ）
 *
 * 文字はテキストボックス（draw:frame）、箱は図形、図形エディタの図は多角形・楕円などのグループ（draw:g）になる。
 * 表は、セルごとの四角と文字の箱を並べて表現する（見た目を崩さないため）。
 * 単位は mm（1px = 25.4/96 mm）。Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./office-common'));
  else (root.KS = root.KS || {}).odp = factory(root.KS.office);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (O) {
  'use strict';
  const { x, hex6 } = O;
  const MM = 25.4 / 96;
  const mm = (pxv) => (Math.round((Number(pxv) || 0) * MM * 1000) / 1000) + 'mm';
  const pt = (pxv) => (Math.round(pxv * 0.75 * 10) / 10) + 'pt';
  const col = (c, f) => '#' + hex6(c, f || '000000').toLowerCase();
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
    'xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0" xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0" office:version="1.3"';

  function textNodes(s) {
    return x(s).replace(/\t/g, '<text:tab/>').replace(/ {2,}/g, (m) => ' <text:s text:c="' + (m.length - 1) + '"/>').replace(/^ /, '<text:s/>');
  }

  function buildOdp(scenes, opts) {
    opts = opts || {};
    const W = (scenes[0] && scenes[0].w) || 1280;
    const H = (scenes[0] && scenes[0].h) || 720;
    const files = [];
    const auto = [];
    const keys = new Map();
    const fontsUsed = new Set();
    function style(family, props, prefix) {
      const key = family + '|' + props;
      if (keys.has(key)) return keys.get(key);
      const name = (prefix || family[0].toUpperCase()) + (keys.size + 1);
      keys.set(key, name);
      auto.push('<style:style style:name="' + name + '" style:family="' + family + '">' + props + '</style:style>');
      return name;
    }
    let listN = 0;
    const gradients = []; // グラデーションの定義（styles.xml の office:styles に入れる）

    const media = new Map();
    let mediaN = 0;
    function picture(data, mime) {
      let name = media.get(data);
      if (!name) {
        name = 'Pictures/image' + ++mediaN + '.' + (O.EXT[mime] || 'png');
        media.set(data, name);
        files.push({ name, data, mime });
      }
      return name;
    }

    // ---- 文字 ----
    function spanStyle(r) {
      const p = ['fo:font-size="' + pt(r.size || 16) + '" style:font-size-asian="' + pt(r.size || 16) + '"', 'fo:color="' + col(r.color) + '"'];
      if (r.font) {
        fontsUsed.add(r.font);
        fontsUsed.add(r.ea || r.font);
        p.push('style:font-name="' + x(r.font) + '" style:font-name-asian="' + x(r.ea || r.font) + '"');
      }
      p.push(r.bold ? 'fo:font-weight="bold" style:font-weight-asian="bold"' : 'fo:font-weight="normal" style:font-weight-asian="normal"');
      if (r.italic) p.push('fo:font-style="italic"');
      if (r.underline) p.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
      if (r.strike) p.push('style:text-line-through-style="solid"');
      if (r.highlight) p.push('fo:background-color="' + col(r.highlight) + '"');
      return style('text', '<style:text-properties ' + p.join(' ') + '/>', 'T');
    }
    function runsXml(runs) {
      return (runs || []).map((r) => {
        if (r.br) return '<text:line-break/>';
        let t = '<text:span text:style-name="' + spanStyle(r) + '">' + textNodes(r.text) + '</text:span>';
        if (r.link) t = '<text:a xlink:type="simple" xlink:href="' + x(r.link) + '">' + t + '</text:a>';
        return t;
      }).join('');
    }
    function paraStyle(p, extra) {
      const align = { l: 'start', ctr: 'center', r: 'end', just: 'justify' }[p.align] || 'start';
      return style('paragraph', '<style:paragraph-properties fo:text-align="' + align + '" fo:line-height="' + Math.round(Math.max(80, Math.min(300, ((p.lineSpacing || 1.2) / 1.2) * 100))) + '%" fo:margin-top="' + mm(p.spaceBefore || 0) + '" fo:margin-bottom="0mm"' + (extra || '') + '/>', 'P');
    }
    function parasXml(paras) {
      if (!paras || !paras.length) return '<text:p/>';
      let out = '';
      for (let i = 0; i < paras.length; i++) {
        const p = paras[i];
        if (!p.bullet) { out += '<text:p text:style-name="' + paraStyle(p) + '">' + runsXml(p.runs) + '</text:p>'; continue; }
        // 箇条書き: 続く項目をまとめて 1 つのリストにする（段の深さは入れ子のリスト）
        const group = [];
        while (i < paras.length && paras[i].bullet) group.push(paras[i++]);
        i--;
        out += listXml(group);
      }
      return out;
    }
    function listXml(items) {
      const name = 'L' + ++listN;
      const lvls = [];
      for (let lv = 0; lv < 6; lv++) {
        const sample = items.find((p) => (p.level || 0) === lv) || items[0];
        const marL = sample.marL || 24 * (lv + 1);
        const ind = Math.abs(sample.indent || 18);
        const pos = '<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="' + mm(marL) + '" fo:text-indent="-' + mm(ind) + '" fo:margin-left="' + mm(marL) + '"/></style:list-level-properties>';
        if (sample.bullet && sample.bullet.num) {
          lvls.push('<text:list-level-style-number text:level="' + (lv + 1) + '" style:num-format="1" style:num-suffix="."' + (sample.bullet.start > 1 ? ' text:start-value="' + sample.bullet.start + '"' : '') + '>' + pos + '</text:list-level-style-number>');
        } else {
          const ch = (sample.bullet && sample.bullet.char) || '•';
          const color = sample.bullet && sample.bullet.color ? ' fo:color="' + col(sample.bullet.color) + '"' : '';
          lvls.push('<text:list-level-style-bullet text:level="' + (lv + 1) + '" text:bullet-char="' + x(Array.from(ch)[0]) + '">' + pos + '<style:text-properties' + color + ' fo:font-size="100%"/></text:list-level-style-bullet>');
        }
      }
      auto.push('<text:list-style style:name="' + name + '">' + lvls.join('') + '</text:list-style>');
      let i = 0;
      function level(lv) {
        let out = '<text:list' + (lv === 0 ? ' text:style-name="' + name + '"' : '') + '>';
        while (i < items.length && (items[i].level || 0) >= lv) {
          if ((items[i].level || 0) > lv) { out += '<text:list-item>' + level(lv + 1) + '</text:list-item>'; continue; }
          const p = items[i++];
          out += '<text:list-item><text:p text:style-name="' + paraStyle(p) + '">' + runsXml(p.runs) + '</text:p>';
          if (i < items.length && (items[i].level || 0) > lv) out += level(lv + 1);
          out += '</text:list-item>';
        }
        return out + '</text:list>';
      }
      let out = '';
      while (i < items.length) out += level(0);
      return out;
    }

    // ---- 図形の見た目（graphic スタイル） ----
    const DASH = { dashed: 'Dash', dotted: 'Dot' };
    function graphicStyle(o) {
      const p = [];
      p.push(o.fill ? 'draw:fill="solid" draw:fill-color="' + col(o.fill) + '"' + (o.fillAlpha != null && o.fillAlpha < 0.999 ? ' draw:opacity="' + Math.round(o.fillAlpha * 100) + '%"' : '') : 'draw:fill="none"');
      if (o.line && o.lineWidth) {
        p.push((DASH[o.dash] ? 'draw:stroke="dash" draw:stroke-dash="' + DASH[o.dash] + '"' : 'draw:stroke="solid"') + ' svg:stroke-color="' + col(o.line) + '" svg:stroke-width="' + mm(o.lineWidth) + '"');
      } else p.push('draw:stroke="none"');
      if (o.head === 'arrow') p.push('draw:marker-start="Arrow" draw:marker-start-width="' + mm(Math.max(6, o.lineWidth * 4)) + '"');
      if (o.tail === 'arrow') p.push('draw:marker-end="Arrow" draw:marker-end-width="' + mm(Math.max(6, o.lineWidth * 4)) + '"');
      if (o.head === 'dot') p.push('draw:marker-start="Circle" draw:marker-start-width="' + mm(Math.max(4, o.lineWidth * 3)) + '"');
      if (o.tail === 'dot') p.push('draw:marker-end="Circle" draw:marker-end-width="' + mm(Math.max(4, o.lineWidth * 3)) + '"');
      const ins = o.inset || [0, 0, 0, 0];
      p.push('fo:padding-left="' + mm(ins[0]) + '" fo:padding-top="' + mm(ins[1]) + '" fo:padding-right="' + mm(ins[2]) + '" fo:padding-bottom="' + mm(ins[3]) + '"');
      p.push('draw:textarea-vertical-align="' + ({ t: 'top', ctr: 'middle', b: 'bottom' }[o.anchor] || 'top') + '" draw:auto-grow-height="false" draw:auto-grow-width="false" fo:wrap-option="' + (o.single ? 'no-wrap' : 'wrap') + '" draw:shadow="hidden"');
      return style('graphic', '<style:graphic-properties ' + p.join(' ') + '/>', 'gr');
    }
    const box = (it) => {
      const size = 'svg:width="' + mm(Math.max(0.5, it.w)) + '" svg:height="' + mm(Math.max(0.5, it.h)) + '"';
      if (!it.rot) return 'svg:x="' + mm(it.x) + '" svg:y="' + mm(it.y) + '" ' + size;
      // 回転（時計回りの度）: ODF は「左上を軸に反時計回りへ rotate → translate」なので、中心で回したときの左上の位置へ動かす
      const a = (it.rot * Math.PI) / 180;
      const cx = it.x + it.w / 2;
      const cy = it.y + it.h / 2;
      const tx = cx + (it.x - cx) * Math.cos(a) - (it.y - cy) * Math.sin(a);
      const ty = cy + (it.x - cx) * Math.sin(a) + (it.y - cy) * Math.cos(a);
      return size + ' draw:transform="rotate(' + (-a).toFixed(6) + ') translate(' + mm(tx) + ' ' + mm(ty) + ')"';
    };

    function itemXml(it) {
      switch (it.kind) {
        case 'text':
          return '<draw:frame draw:style-name="' + graphicStyle({ fill: it.fill, fillAlpha: it.fillAlpha, line: it.line, lineWidth: it.lineWidth, inset: it.inset, anchor: it.anchor, single: it.single }) + '" ' +
            box(O.widen(it, true)) + '><draw:text-box>' + parasXml(it.paras) + '</draw:text-box></draw:frame>';
        case 'shape': {
          const gs = graphicStyle(it);
          const text = it.paras ? parasXml(it.paras) : '';
          if (it.poly) {
            // 図形エディタの多角形（座標は図の中の位置。枠の左上を 0 とする viewBox に直す）
            const pts = it.poly;
            const minX = Math.min(...pts.map((p) => p[0]));
            const minY = Math.min(...pts.map((p) => p[1]));
            const vw = Math.max(...pts.map((p) => p[0])) - minX || 1;
            const vh = Math.max(...pts.map((p) => p[1])) - minY || 1;
            const k = 1000;
            return '<draw:polygon draw:style-name="' + gs + '" ' + box(it) + ' svg:viewBox="0 0 ' + Math.round(vw * k) + ' ' + Math.round(vh * k) + '" draw:points="' +
              pts.map((p) => Math.round((p[0] - minX) * k) + ',' + Math.round((p[1] - minY) * k)).join(' ') + '">' + text + '</draw:polygon>';
          }
          if (it.geom === 'ellipse') return '<draw:ellipse draw:style-name="' + gs + '" ' + box(it) + '>' + text + '</draw:ellipse>';
          if (it.geom === 'can' || it.geom === 'flowChartDocument') {
            const d = it.geom === 'can'
              ? 'M0 150 A500 150 0 0 1 1000 150 L1000 850 A500 150 0 0 1 0 850 Z M0 150 A500 150 0 0 0 1000 150'
              : 'M0 0 L1000 0 L1000 880 C750 760 500 1060 250 940 S50 900 0 960 Z';
            return '<draw:path draw:style-name="' + gs + '" ' + box(it) + ' svg:viewBox="0 0 1000 1000" svg:d="' + d + '">' + text + '</draw:path>';
          }
          const r = it.geom === 'roundRect' ? ' draw:corner-radius="' + mm(it.radius || 0) + '"' : '';
          return '<draw:rect draw:style-name="' + gs + '" ' + box(it) + r + '>' + text + '</draw:rect>';
        }
        case 'image': {
          const href = picture(it.data, it.mime);
          return '<draw:frame draw:style-name="' + graphicStyle({}) + '" ' + box(it) + '><draw:image xlink:href="' + href + '" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"><text:p/></draw:image>' +
            (it.alt ? '<svg:desc>' + x(it.alt) + '</svg:desc>' : '') + '</draw:frame>';
        }
        case 'line': {
          const pts = it.points;
          const minX = Math.min(...pts.map((p) => p.x));
          const minY = Math.min(...pts.map((p) => p.y));
          const w = Math.max(...pts.map((p) => p.x)) - minX;
          const h = Math.max(...pts.map((p) => p.y)) - minY;
          const k = 100;
          const gs = graphicStyle({ line: it.color, lineWidth: it.width, dash: it.dash, head: it.head, tail: it.tail });
          return '<draw:polyline draw:style-name="' + gs + '" ' + box({ x: minX, y: minY, w: Math.max(w, 0.5), h: Math.max(h, 0.5) }) +
            ' svg:viewBox="0 0 ' + Math.max(1, Math.round(w * k)) + ' ' + Math.max(1, Math.round(h * k)) + '" draw:points="' + pts.map((p) => Math.round((p.x - minX) * k) + ',' + Math.round((p.y - minY) * k)).join(' ') + '"/>';
        }
        case 'table': {
          // セルごとの四角＋文字
          const total = it.cols.reduce((a, b) => a + b, 0) || it.w;
          let yy = it.y;
          let out = '<draw:g>';
          for (const row of it.rows) {
            let xx = it.x;
            it.cols.forEach((c, ci) => {
              const cw = (c / total) * it.w;
              const cell = row.cells[ci] || {};
              out += '<draw:frame draw:style-name="' + graphicStyle({ fill: cell.fill, fillAlpha: cell.fillAlpha, inset: cell.inset, anchor: 'ctr' }) + '" ' + box({ x: xx, y: yy, w: cw, h: row.h }) + '><draw:text-box>' + parasXml(cell.paras) + '</draw:text-box></draw:frame>';
              if (cell.border) out += '<draw:line draw:style-name="' + graphicStyle({ line: cell.border.color, lineWidth: cell.border.width }) + '" svg:x1="' + mm(xx) + '" svg:y1="' + mm(yy + row.h) + '" svg:x2="' + mm(xx + cw) + '" svg:y2="' + mm(yy + row.h) + '"/>';
              xx += cw;
            });
            yy += row.h;
          }
          return out + '</draw:g>';
        }
        case 'group': return '<draw:g>' + it.items.map(itemXml).join('') + '</draw:g>';
        default: return '';
      }
    }

    const pages = scenes.map((scene, i) => {
      const bg = scene.bg || {};
      const g = bg.gradient && bg.gradient.length > 1;
      const dp = style('drawing-page', '<style:drawing-page-properties presentation:background-visible="true" presentation:background-objects-visible="true" draw:background-size="full" ' +
        (g ? 'draw:fill="gradient" draw:fill-gradient-name="' + gradient(bg.gradient[0], bg.gradient[bg.gradient.length - 1]) + '"' : 'draw:fill="solid" draw:fill-color="' + col(bg.color, 'ffffff') + '"') + '/>', 'dp');
      const notes = scene.notes
        ? '<presentation:notes><draw:page-thumbnail presentation:class="page" draw:page-number="' + (i + 1) + '" svg:x="20mm" svg:y="25mm" svg:width="170mm" svg:height="' + Math.round((170 * H) / W) + 'mm"/>' +
          '<draw:frame presentation:class="notes" svg:x="20mm" svg:y="130mm" svg:width="170mm" svg:height="140mm"><draw:text-box>' +
          String(scene.notes).split('\n').map((l) => '<text:p>' + textNodes(l) + '</text:p>').join('') + '</draw:text-box></draw:frame></presentation:notes>'
        : '';
      // ページの背景を読まないソフト（PowerPoint など）もあるので、全面の四角も敷く（位置・大きさは固定）
      const bgStyle = g
        ? style('graphic', '<style:graphic-properties draw:fill="gradient" draw:fill-gradient-name="' + gradient(bg.gradient[0], bg.gradient[bg.gradient.length - 1]) + '" draw:stroke="none" draw:shadow="hidden"/>', 'gr')
        : graphicStyle({ fill: bg.color || '#ffffff' });
      const bgRect = '<draw:rect draw:name="背景" draw:style-name="' + bgStyle + '" draw:protect="position size" svg:x="0mm" svg:y="0mm" svg:width="' + mm(W) + '" svg:height="' + mm(H) + '"/>';
      return '<draw:page draw:name="スライド' + (i + 1) + '" draw:style-name="' + dp + '" draw:master-page-name="Default">' + bgRect + scene.items.map(itemXml).join('') + notes + '</draw:page>';
    });

    function gradient(a, b) {
      const name = 'Grad' + (gradients.length + 1);
      gradients.push('<draw:gradient draw:name="' + name + '" draw:style="linear" draw:start-color="' + col(a) + '" draw:end-color="' + col(b) + '" draw:start-intensity="100%" draw:end-intensity="100%" draw:angle="0deg" draw:border="0%"/>');
      return name;
    }

    const fontDecls = '<office:font-face-decls>' + Array.from(fontsUsed).map((f) => '<style:font-face style:name="' + x(f) + '" svg:font-family="' + x("'" + f + "'") + '"/>').join('') + '</office:font-face-decls>';
    const content = '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ' + NS + '>' + fontDecls +
      '<office:automatic-styles>' + auto.join('') + '</office:automatic-styles><office:body><office:presentation>' + pages.join('') + '</office:presentation></office:body></office:document-content>';
    const styles = '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ' + NS + '>' + fontDecls + '<office:styles>' +
      '<draw:marker draw:name="Arrow" svg:viewBox="0 0 20 30" svg:d="M10 0l-10 30h20z"/>' +
      '<draw:marker draw:name="Circle" svg:viewBox="0 0 1131 1131" svg:d="M462 1118l-102-29-102-51-93-72-72-93-51-102-29-102-13-105 13-102 29-106 51-102 72-89 93-72 102-50 102-34 106-9 101 9 106 34 98 50 93 72 72 89 51 102 29 106 13 102-13 105-29 102-51 102-72 93-93 72-98 51-106 29-101 13z"/>' +
      gradients.join('') +
      '<style:default-style style:family="graphic"><style:graphic-properties draw:shadow="hidden"/><style:paragraph-properties fo:line-height="100%"/><style:text-properties fo:language="ja" fo:country="JP" style:language-asian="ja" style:country-asian="JP"/></style:default-style>' +
      '</office:styles><office:automatic-styles>' +
      '<style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0mm" fo:margin-bottom="0mm" fo:margin-left="0mm" fo:margin-right="0mm" fo:page-width="' + mm(W) + '" fo:page-height="' + mm(H) + '" style:print-orientation="landscape"/></style:page-layout>' +
      '<style:style style:name="Mdp1" style:family="drawing-page"><style:drawing-page-properties draw:background-size="full" draw:fill="solid" draw:fill-color="#ffffff"/></style:style>' +
      '</office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1" draw:style-name="Mdp1"/></office:master-styles></office:document-styles>';
    const meta = '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ' + NS + '><office:meta><meta:generator>Kamishibai</meta:generator><dc:title>' + x(opts.title || '') + '</dc:title>' +
      (opts.author ? '<meta:initial-creator>' + x(opts.author) + '</meta:initial-creator>' : '') + '</office:meta></office:document-meta>';
    const MIME = 'application/vnd.oasis.opendocument.presentation';
    const manifest = '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
      '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="' + MIME + '"/>' +
      ['content.xml', 'styles.xml', 'meta.xml'].map((f) => '<manifest:file-entry manifest:full-path="' + f + '" manifest:media-type="text/xml"/>').join('') +
      files.map((f) => '<manifest:file-entry manifest:full-path="' + f.name + '" manifest:media-type="' + f.mime + '"/>').join('') + '</manifest:manifest>';
    return [
      { name: 'mimetype', data: MIME, store: true },
      { name: 'META-INF/manifest.xml', data: manifest },
      { name: 'content.xml', data: content },
      { name: 'styles.xml', data: styles },
      { name: 'meta.xml', data: meta },
    ].concat(files.map((f) => ({ name: f.name, data: f.data, store: true })));
  }

  return { buildOdp };
});
