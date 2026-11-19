/*
 * pptx.js — スライドのシーン（editor/export-scene.js）→ PowerPoint（.pptx）の zip の中身。
 *
 *   buildPptx(scenes, opts) → [{ name, data, store? }]
 *     scenes: [{ w, h, bg, items, notes }]（画像は data / mime に読み込み済み）
 *     opts  : { title, author }
 *
 * 文字はテキストボックス、箱は図形、表は PowerPoint の表、図形エディタの図は図形のグループになる（どれも編集できる）。
 * スライドの大きさは論理サイズ（1280×720 など）× 9525 EMU（1px = 1/96 インチ）。
 * Node / ブラウザ両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./office-common'));
  else (root.KS = root.KS || {}).pptx = factory(root.KS.office);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (O) {
  'use strict';
  const { x, hex6 } = O;
  const E = (v) => Math.round((Number(v) || 0) * O.PX_TO_EMU);
  const PT = (pxv) => Math.max(100, Math.round(pxv * 0.75 * 100)); // 文字の大きさ（1/100 pt）
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  const srgb = (c, alpha) => '<a:srgbClr val="' + hex6(c, '000000') + '">' + (alpha != null && alpha < 0.999 ? '<a:alpha val="' + Math.round(alpha * 100000) + '"/>' : '') + '</a:srgbClr>';
  const solidFill = (c, alpha) => (c ? '<a:solidFill>' + srgb(c, alpha) + '</a:solidFill>' : '<a:noFill/>');
  const DASH = { dashed: 'dash', dotted: 'sysDot' };
  const END = { arrow: 'triangle', dot: 'oval' };
  function lineXml(color, width, opts) {
    opts = opts || {};
    if (!color || !width) return '<a:ln><a:noFill/></a:ln>';
    return '<a:ln w="' + E(width) + '"' + (opts.cap ? ' cap="rnd"' : '') + '>' + solidFill(color, opts.alpha) +
      (DASH[opts.dash] ? '<a:prstDash val="' + DASH[opts.dash] + '"/>' : '') + '<a:round/>' +
      (opts.head && END[opts.head] ? '<a:headEnd type="' + END[opts.head] + '" w="med" len="med"/>' : '') +
      (opts.tail && END[opts.tail] ? '<a:tailEnd type="' + END[opts.tail] + '" w="med" len="med"/>' : '') + '</a:ln>';
  }

  function buildPptx(scenes, opts) {
    opts = opts || {};
    const W = (scenes[0] && scenes[0].w) || 1280;
    const H = (scenes[0] && scenes[0].h) || 720;
    const files = [];
    const media = new Map(); // data → 名前
    let mediaN = 0;

    const slides = scenes.map((scene, si) => {
      const rels = [{ id: 'rId1', type: R + 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }];
      let relN = 1;
      const rel = (type, target, external) => {
        const id = 'rId' + ++relN;
        rels.push({ id, type, target, external });
        return id;
      };
      let shapeId = 1;
      const nextId = () => ++shapeId;

      function imageRel(data, mime) {
        let name = media.get(data);
        if (!name) {
          name = 'image' + ++mediaN + '.' + (O.EXT[mime] || 'png');
          media.set(data, name);
          files.push({ name: 'ppt/media/' + name, data, store: true });
        }
        return rel(R + 'image', '../media/' + name);
      }

      // ---- 文字 ----
      function runXml(r) {
        if (r.br) return '<a:br><a:rPr lang="ja-JP" altLang="en-US"' + (r.size ? ' sz="' + PT(r.size) + '"' : '') + '/></a:br>';
        const attrs = ' lang="ja-JP" altLang="en-US" sz="' + PT(r.size || 16) + '"' + (r.bold ? ' b="1"' : ' b="0"') + (r.italic ? ' i="1"' : '') +
          (r.underline ? ' u="sng"' : '') + (r.strike ? ' strike="sngStrike"' : '') + ' dirty="0"';
        let inner = solidFill(r.color || '#000000');
        if (r.highlight) inner += '<a:highlight>' + srgb(r.highlight) + '</a:highlight>';
        if (r.font) inner += '<a:latin typeface="' + x(r.font) + '"/><a:ea typeface="' + x(r.ea || r.font) + '"/><a:cs typeface="' + x(r.font) + '"/>';
        if (r.link) inner += '<a:hlinkClick r:id="' + rel(R + 'hyperlink', r.link, true) + '"/>';
        return '<a:r><a:rPr' + attrs + '>' + inner + '</a:rPr><a:t>' + x(r.text) + '</a:t></a:r>';
      }
      function paraXml(p) {
        const algn = { l: 'l', ctr: 'ctr', r: 'r', just: 'just' }[p.align] || 'l';
        let ppr = ' algn="' + algn + '"';
        if (p.bullet || p.marL) ppr += ' marL="' + E(p.marL || 0) + '" indent="' + (p.bullet ? E(p.indent || -18) : 0) + '"';
        if (p.level) ppr += ' lvl="' + Math.min(8, p.level) + '"';
        // ブラウザの行の高さ（em）→ PowerPoint の行間（1 行 = 文字の約 1.2 倍）
        let inner = '<a:lnSpc><a:spcPct val="' + Math.round(Math.max(0.8, Math.min(3, (p.lineSpacing || 1.2) / 1.2)) * 100000) + '"/></a:lnSpc>';
        inner += '<a:spcBef><a:spcPts val="' + Math.round((p.spaceBefore || 0) * 75) + '"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft>';
        if (p.bullet && p.bullet.num) inner += '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"' + (p.bullet.start > 1 ? ' startAt="' + p.bullet.start + '"' : '') + '/>';
        else if (p.bullet && p.bullet.char) inner += (p.bullet.color ? '<a:buClr>' + srgb(p.bullet.color) + '</a:buClr>' : '') + '<a:buFont typeface="Arial"/><a:buChar char="' + x(p.bullet.char) + '"/>';
        else inner += '<a:buNone/>';
        const first = p.runs.find((r) => r.text) || {};
        return '<a:p><a:pPr' + ppr + '>' + inner + '</a:pPr>' + p.runs.map(runXml).join('') +
          '<a:endParaRPr lang="ja-JP" altLang="en-US" sz="' + PT(first.size || p.size || 16) + '" dirty="0"/></a:p>';
      }
      function txBody(paras, o) {
        o = o || {};
        const ins = o.inset || [0, 0, 0, 0];
        return '<p:txBody><a:bodyPr wrap="' + (o.single ? 'none' : 'square') + '" lIns="' + E(ins[0]) + '" tIns="' + E(ins[1]) + '" rIns="' + E(ins[2]) + '" bIns="' + E(ins[3]) + '" anchor="' + (o.anchor || 't') + '" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>' +
          (paras && paras.length ? paras.map(paraXml).join('') : '<a:p><a:endParaRPr lang="ja-JP"/></a:p>') + '</p:txBody>';
      }
      // rot: 時計回りの角度（度）。PowerPoint は枠の中心を軸に回す（図形エディタの回転と同じ）。単位は 1/60000 度
      const xfrm = (it) => '<a:xfrm' + (it.rot ? ' rot="' + Math.round((((it.rot % 360) + 360) % 360) * 60000) + '"' : '') + '><a:off x="' + E(it.x) + '" y="' + E(it.y) + '"/><a:ext cx="' + Math.max(1, E(it.w)) + '" cy="' + Math.max(1, E(it.h)) + '"/></a:xfrm>';
      function geom(it) {
        if (it.geom === 'roundRect') {
          const adj = Math.min(50000, Math.round(((it.radius || 0) / Math.max(1, Math.min(it.w, it.h))) * 100000));
          return '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ' + adj + '"/></a:avLst></a:prstGeom>';
        }
        return '<a:prstGeom prst="' + (it.geom || 'rect') + '"><a:avLst/></a:prstGeom>';
      }

      function itemXml(it) {
        switch (it.kind) {
          case 'text': {
            // 文字の折り返しがブラウザより早くならないよう、右に少し余裕を持たせる
            const box = O.widen(it);
            return '<p:sp><p:nvSpPr><p:cNvPr id="' + nextId() + '" name="テキスト ' + shapeId + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
              '<p:spPr>' + xfrm(box) + geom({ geom: it.radius ? 'roundRect' : 'rect', radius: it.radius, w: it.w, h: it.h }) + solidFill(it.fill, it.fillAlpha) + lineXml(it.line, it.lineWidth) + '</p:spPr>' +
              txBody(it.paras, { inset: it.inset, anchor: it.anchor, single: it.single }) + '</p:sp>';
          }
          case 'shape':
            return '<p:sp><p:nvSpPr><p:cNvPr id="' + nextId() + '" name="図形 ' + shapeId + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
              '<p:spPr>' + xfrm(it) + geom(it) + solidFill(it.fill, it.fillAlpha) + lineXml(it.line, it.lineWidth, { dash: it.dash, alpha: it.lineAlpha }) + '</p:spPr>' +
              (it.paras ? txBody(it.paras, { inset: it.pptInset || it.inset, anchor: it.anchor }) : txBody(null, { anchor: 'ctr' })) + '</p:sp>';
          case 'image': {
            const rid = imageRel(it.data, it.mime);
            return '<p:pic><p:nvPicPr><p:cNvPr id="' + nextId() + '" name="画像 ' + shapeId + '" descr="' + x(it.alt || '') + '"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
              '<p:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
              '<p:spPr>' + xfrm(it) + geom({ geom: it.radius > 0.5 ? 'roundRect' : 'rect', radius: it.radius, w: it.w, h: it.h }) + '</p:spPr></p:pic>';
          }
          case 'line': {
            const pts = it.points;
            const minX = Math.min(...pts.map((p) => p.x));
            const minY = Math.min(...pts.map((p) => p.y));
            const w = Math.max(...pts.map((p) => p.x)) - minX;
            const h = Math.max(...pts.map((p) => p.y)) - minY;
            const ew = Math.max(1, E(w));
            const eh = Math.max(1, E(h));
            const pt = (p) => '<a:pt x="' + E(p.x - minX) + '" y="' + E(p.y - minY) + '"/>';
            const path = '<a:moveTo>' + pt(pts[0]) + '</a:moveTo>' + pts.slice(1).map((p) => '<a:lnTo>' + pt(p) + '</a:lnTo>').join('');
            return '<p:sp><p:nvSpPr><p:cNvPr id="' + nextId() + '" name="線 ' + shapeId + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>' +
              '<a:xfrm><a:off x="' + E(minX) + '" y="' + E(minY) + '"/><a:ext cx="' + ew + '" cy="' + eh + '"/></a:xfrm>' +
              '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="' + ew + '" h="' + eh + '" fill="none">' + path + '</a:path></a:pathLst></a:custGeom>' +
              '<a:noFill/>' + lineXml(it.color, it.width, { dash: it.dash, head: it.head, tail: it.tail }) + '</p:spPr>' + txBody(null) + '</p:sp>';
          }
          case 'table': return tableXml(it);
          case 'group': {
            const inner = it.items.map(itemXml).join('');
            const xf = '<a:xfrm><a:off x="' + E(it.x) + '" y="' + E(it.y) + '"/><a:ext cx="' + Math.max(1, E(it.w)) + '" cy="' + Math.max(1, E(it.h)) + '"/><a:chOff x="' + E(it.x) + '" y="' + E(it.y) + '"/><a:chExt cx="' + Math.max(1, E(it.w)) + '" cy="' + Math.max(1, E(it.h)) + '"/></a:xfrm>';
            return '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="' + nextId() + '" name="図 ' + shapeId + '"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>' + xf + '</p:grpSpPr>' + inner + '</p:grpSp>';
          }
          default: return '';
        }
      }

      function tableXml(t) {
        const total = t.cols.reduce((a, b) => a + b, 0) || t.w;
        const cols = t.cols.map((c) => Math.max(1, E((c / total) * t.w)));
        const ln = (side, b) => (b ? '<a:' + side + ' w="' + E(b.width || 1) + '">' + solidFill(b.color) + '</a:' + side + '>' : '<a:' + side + ' w="0"><a:noFill/></a:' + side + '>');
        const rows = t.rows.map((row) => '<a:tr h="' + Math.max(1, E(row.h)) + '">' + t.cols.map((c, ci) => {
          const cell = row.cells[ci] || { paras: [] };
          const ins = cell.inset || [6, 4, 6, 4];
          return '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>' + (cell.paras && cell.paras.length ? cell.paras.map(paraXml).join('') : '<a:p><a:endParaRPr lang="ja-JP"/></a:p>') + '</a:txBody>' +
            '<a:tcPr marL="' + E(ins[0]) + '" marR="' + E(ins[2]) + '" marT="' + E(ins[1]) + '" marB="' + E(ins[3]) + '" anchor="ctr">' +
            ln('lnL', null) + ln('lnR', null) + ln('lnT', null) + ln('lnB', cell.border) + solidFill(cell.fill, cell.fillAlpha) + '</a:tcPr></a:tc>';
        }).join('') + '</a:tr>').join('');
        return '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + nextId() + '" name="表 ' + shapeId + '"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
          '<p:xfrm><a:off x="' + E(t.x) + '" y="' + E(t.y) + '"/><a:ext cx="' + Math.max(1, E(t.w)) + '" cy="' + Math.max(1, E(t.h)) + '"/></p:xfrm>' +
          '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>' +
          cols.map((c) => '<a:gridCol w="' + c + '"/>').join('') + '</a:tblGrid>' + rows + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
      }

      const bg = scene.bg || {};
      const bgFill = bg.gradient && bg.gradient.length > 1
        ? '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">' + srgb(bg.gradient[0]) + '</a:gs><a:gs pos="100000">' + srgb(bg.gradient[bg.gradient.length - 1]) + '</a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
        : solidFill(bg.color || '#ffffff');
      const spTree = scene.items.map(itemXml).join('');
      const notesRel = scene.notes ? rel(R + 'notesSlide', '../notesSlides/notesSlide' + (si + 1) + '.xml') : null;
      const xml = XML + '<p:sld ' + NS + '><p:cSld><p:bg><p:bgPr>' + bgFill + '<a:effectLst/></p:bgPr></p:bg><p:spTree>' +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
        spTree + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
      return { xml, rels, notes: scene.notes, notesRel };
    });

    // ---- ノート ----
    const notesFiles = [];
    slides.forEach((s, i) => {
      if (!s.notes) return;
      const paras = String(s.notes).split('\n').map((l) => '<a:p><a:r><a:rPr lang="ja-JP" altLang="en-US" dirty="0"/><a:t>' + x(l) + '</a:t></a:r></a:p>').join('');
      notesFiles.push({ name: 'ppt/notesSlides/notesSlide' + (i + 1) + '.xml', data: XML + '<p:notes ' + NS + '><p:cSld><p:spTree>' +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="スライド イメージ プレースホルダー 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="ノート プレースホルダー 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' + paras + '</p:txBody></p:sp>' +
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>' });
      notesFiles.push({ name: 'ppt/notesSlides/_rels/notesSlide' + (i + 1) + '.xml.rels', data: relsXml([
        { id: 'rId1', type: R + 'notesMaster', target: '../notesMasters/notesMaster1.xml' },
        { id: 'rId2', type: R + 'slide', target: '../slides/slide' + (i + 1) + '.xml' },
      ]) });
    });
    const hasNotes = notesFiles.length > 0;

    // ---- 共通の部品（マスター・レイアウト・テーマ） ----
    const emptyTree = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';
    const clrMap = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
    const master = XML + '<p:sldMaster ' + NS + '><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' + emptyTree + '</p:cSld>' + clrMap +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
      '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
      '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:bodyStyle>' +
      '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';
    const layout = XML + '<p:sldLayout ' + NS + ' type="blank" preserve="1"><p:cSld name="白紙">' + emptyTree + '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
    const notesMaster = XML + '<p:notesMaster ' + NS + '><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="スライド イメージ プレースホルダー 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="ノート プレースホルダー 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:endParaRPr lang="ja-JP"/></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld>' + clrMap + '<p:notesStyle><a:lvl1pPr marL="0" algn="l" rtl="0"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>';
    const font = opts.font || 'Yu Gothic';
    const theme = (name) => XML + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="' + name + '"><a:themeElements>' +
      '<a:clrScheme name="Kamishibai"><a:dk1><a:srgbClr val="1B1E27"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B3040"/></a:dk2><a:lt2><a:srgbClr val="EEF0F5"/></a:lt2>' +
      '<a:accent1><a:srgbClr val="' + hex6(opts.accent, '4F5DFF') + '"/></a:accent1><a:accent2><a:srgbClr val="' + hex6(opts.accent2, '12B5A0') + '"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
      '<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
      '<a:fontScheme name="Kamishibai"><a:majorFont><a:latin typeface="' + x(font) + '"/><a:ea typeface="' + x(font) + '"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="' + x(font) + '"/><a:ea typeface="' + x(font) + '"/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
      '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
      '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
      '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
      '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
      '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

    function relsXml(list) {
      return XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        list.map((r) => '<Relationship Id="' + r.id + '" Type="' + r.type + '" Target="' + x(r.target) + '"' + (r.external ? ' TargetMode="External"' : '') + '/>').join('') + '</Relationships>';
    }

    const presRels = [
      { id: 'rId1', type: R + 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
      { id: 'rId2', type: R + 'theme', target: 'theme/theme1.xml' },
      { id: 'rId3', type: R + 'presProps', target: 'presProps.xml' },
      { id: 'rId4', type: R + 'viewProps', target: 'viewProps.xml' },
      { id: 'rId5', type: R + 'tableStyles', target: 'tableStyles.xml' },
    ];
    if (hasNotes) presRels.push({ id: 'rId6', type: R + 'notesMaster', target: 'notesMasters/notesMaster1.xml' });
    slides.forEach((s, i) => presRels.push({ id: 'rIdS' + (i + 1), type: R + 'slide', target: 'slides/slide' + (i + 1) + '.xml' }));

    const presentation = XML + '<p:presentation ' + NS + ' saveSubsetFonts="1">' +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      (hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst>' : '') +
      '<p:sldIdLst>' + slides.map((s, i) => '<p:sldId id="' + (256 + i) + '" r:id="rIdS' + (i + 1) + '"/>').join('') + '</p:sldIdLst>' +
      '<p:sldSz cx="' + E(W) + '" cy="' + E(H) + '"/><p:notesSz cx="6858000" cy="9144000"/>' +
      '<p:defaultTextStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle>' +
      '</p:presentation>';

    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const PML = 'application/vnd.openxmlformats-officedocument.presentationml.';
    const types = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="' + PML + 'presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="' + PML + 'slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="' + PML + 'slideLayout+xml"/>' +
      slides.map((s, i) => '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="' + PML + 'slide+xml"/>').join('') +
      (hasNotes ? '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="' + PML + 'notesMaster+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' : '') +
      slides.map((s, i) => (s.notes ? '<Override PartName="/ppt/notesSlides/notesSlide' + (i + 1) + '.xml" ContentType="' + PML + 'notesSlide+xml"/>' : '')).join('') +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/ppt/presProps.xml" ContentType="' + PML + 'presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="' + PML + 'viewProps+xml"/>' +
      '<Override PartName="/ppt/tableStyles.xml" ContentType="' + PML + 'tableStyles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';

    const out = [
      { name: '[Content_Types].xml', data: types },
      { name: '_rels/.rels', data: relsXml([
        { id: 'rId1', type: R + 'officeDocument', target: 'ppt/presentation.xml' },
        { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
        { id: 'rId3', type: R + 'extended-properties', target: 'docProps/app.xml' },
      ]) },
      { name: 'docProps/core.xml', data: XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + x(opts.title || '') + '</dc:title><dc:creator>' + x(opts.author || '') + '</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>' },
      { name: 'docProps/app.xml', data: XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Kamishibai</Application><Slides>' + slides.length + '</Slides></Properties>' },
      { name: 'ppt/presentation.xml', data: presentation },
      { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presRels) },
      { name: 'ppt/presProps.xml', data: XML + '<p:presentationPr ' + NS + '/>' },
      { name: 'ppt/viewProps.xml', data: XML + '<p:viewPr ' + NS + '><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>' },
      { name: 'ppt/tableStyles.xml', data: XML + '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>' },
      { name: 'ppt/theme/theme1.xml', data: theme('Kamishibai') },
      { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
      { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: relsXml([
        { id: 'rId1', type: R + 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', type: R + 'theme', target: '../theme/theme1.xml' },
      ]) },
      { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
      { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: relsXml([{ id: 'rId1', type: R + 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]) },
    ];
    if (hasNotes) {
      out.push({ name: 'ppt/notesMasters/notesMaster1.xml', data: notesMaster });
      out.push({ name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: relsXml([{ id: 'rId1', type: R + 'theme', target: '../theme/theme2.xml' }]) });
      out.push({ name: 'ppt/theme/theme2.xml', data: theme('Notes') });
    }
    slides.forEach((s, i) => {
      out.push({ name: 'ppt/slides/slide' + (i + 1) + '.xml', data: s.xml });
      out.push({ name: 'ppt/slides/_rels/slide' + (i + 1) + '.xml.rels', data: relsXml(s.rels) });
    });
    return out.concat(notesFiles, files);
  }

  return { buildPptx };
});
