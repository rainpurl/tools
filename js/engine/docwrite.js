// Word and RTF writers. Both take the document model, so fonts, sizes, colours,
// alignment, spacing, lists, tables, images and links survive either way.

import { zipWrite } from "./containers.js";
import { htmlToModel } from "./docmodel.js";
import { enc, xmlEsc } from "./util.js";

const tw = pt => Math.round(pt * 20);                 // points to twentieths of a point
const emu = pt => Math.round(pt * 12700);
const HEAD_SIZE = [20, 16, 14, 12, 11, 11];
const LETTER = { w: 612, h: 792, top: 72, right: 72, bottom: 72, left: 72 };
const clean = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
const IMG_EXT = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif" };

// "Single" line spacing in Word is the font's own line height, which differs by
// font. CSS line heights are multiples of the font size, so they are converted.
const NATURAL = {
  "arial": 1.149, "times new roman": 1.149, "courier new": 1.133, "calibri": 1.221, "cambria": 1.172,
  "georgia": 1.136, "verdana": 1.215, "tahoma": 1.207, "trebuchet ms": 1.161, "garamond": 1.125,
  "segoe ui": 1.33, "open sans": 1.362, "roboto": 1.172, "lato": 1.2, "consolas": 1.171,
  "palatino linotype": 1.35, "book antiqua": 1.24, "century gothic": 1.2, "inter": 1.21, "montserrat": 1.219,
  "source sans pro": 1.257, "dejavu sans": 1.164, "dejavu serif": 1.164, "noto sans": 1.362, "noto serif": 1.362,
  "candara": 1.221, "constantia": 1.221, "corbel": 1.221, "comic sans ms": 1.394, "century schoolbook": 1.2
};
function lineMultiple(p, m){
  const run = p.runs.find(r => r.text && r.text.trim());
  const font = ((run && run.font) || m.font || "").toLowerCase();
  return Math.max(200, Math.round(p.line / (NATURAL[font] || 1.17) * 240));
}

function colWidths(t, avail){
  const n = Math.max(1, ...t.rows.map(r => r.reduce((a, c) => a + c.span, 0)));
  let cols = (t.cols || []).slice(0, n);
  if (cols.length < n || cols.some(c => !c)){
    // take widths from the first row that states them, else share the space evenly
    const fromCells = t.rows.find(r => r.length === n && r.every(c => c.width));
    cols = fromCells ? fromCells.map(c => c.width) : Array(n).fill((t.width || avail) / n);
  }
  const total = cols.reduce((a, b) => a + b, 0);
  const max = avail - (t.left || 0);
  if (total > max && max > 0) cols = cols.map(c => c * max / total);
  return cols;
}

/* ==========================================================================
   DOCX
   ========================================================================== */

function docxStyles(m){
  const font = xmlEsc(m.font || "Calibri");
  const size = Math.round((m.size || 11) * 2);
  const tight = !!m.page;
  const normal = tight ? `<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>` : `<w:spacing w:after="160" w:line="276" w:lineRule="auto"/>`;
  const heads = [1, 2, 3, 4, 5, 6].map(n =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="${tight ? 0 : 320 - n * 30}" w:after="${tight ? 0 : 120}"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${HEAD_SIZE[n - 1] * 2}"/><w:szCs w:val="${HEAD_SIZE[n - 1] * 2}"/></w:rPr></w:style>`).join("");
  const border = `w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr>${normal}</w:pPr></w:style>
${heads}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>${tight ? "" : `<w:spacing w:after="60"/>`}<w:ind w:left="720"/>${tight ? "" : "<w:contextualSpacing/>"}</w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="HTML Preformatted"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top ${border}/><w:left ${border}/><w:bottom ${border}/><w:right ${border}/><w:insideH ${border}/><w:insideV ${border}/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;
}

function docxNumbering(extra){
  const lvl = (i, ordered) => {
    const fmt = ordered ? ["decimal", "lowerLetter", "lowerRoman"][i % 3] : "bullet";
    const text = ordered ? `%${i + 1}.` : (i % 3 === 0 ? "\uF0B7" : i % 3 === 1 ? "o" : "\uF0A7");
    const font = ordered ? "" : (i % 3 === 1
      ? `<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New" w:hint="default"/></w:rPr>`
      : `<w:rPr><w:rFonts w:ascii="${i % 3 === 0 ? "Symbol" : "Wingdings"}" w:hAnsi="${i % 3 === 0 ? "Symbol" : "Wingdings"}" w:hint="default"/></w:rPr>`);
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${xmlEsc(text)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>${font}</w:lvl>`;
  };
  const levels = ord => [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => lvl(i, ord)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
${extra.join("\n")}
</w:numbering>`;
}

export async function modelToDocx(m){
  const page = m.page || LETTER;
  const avail = page.w - page.left - page.right;
  const tight = !!m.page;
  const pending = [];       // section breaks waiting for their header and footer references
  const rels = [];          // { id, type, target, external }
  const media = [];         // { name, bytes }
  const nums = [];          // extra numbering instances
  const numAt = [];         // current ordered list instance per level
  let picId = 0;

  const rel = (type, target, external) => {
    const id = "rId" + (rels.length + 10);
    rels.push({ id, type, target, external });
    return id;
  };

  const text = s => {
    const parts = clean(s).split("\t");
    return parts.map((p, i) => (i ? "<w:tab/>" : "") + (p ? `<w:t xml:space="preserve">${xmlEsc(p)}</w:t>` : "")).join("");
  };

  const rPr = (r, p) => {
    const a = [];
    const font = r.font;
    if (font) a.push(`<w:rFonts w:ascii="${xmlEsc(font)}" w:hAnsi="${xmlEsc(font)}" w:cs="${xmlEsc(font)}" w:eastAsia="${xmlEsc(font)}"/>`);
    if (r.b) a.push("<w:b/>");
    else if (p && p.heading) a.push(`<w:b w:val="0"/>`);     // the heading style is bold; this run is not
    if (r.i) a.push("<w:i/>");
    if (r.strike) a.push("<w:strike/>");
    const color = r.color || (r.link ? "0563C1" : null);
    if (color) a.push(`<w:color w:val="${color.toUpperCase()}"/>`);
    if (r.size) a.push(`<w:sz w:val="${Math.round(r.size * 2)}"/><w:szCs w:val="${Math.round(r.size * 2)}"/>`);
    if (r.u || r.link) a.push(`<w:u w:val="single"/>`);
    if (r.bg) a.push(`<w:shd w:val="clear" w:color="auto" w:fill="${r.bg.toUpperCase()}"/>`);
    if (r.va) a.push(`<w:vertAlign w:val="${r.va === "super" ? "superscript" : "subscript"}"/>`);
    return a.length ? `<w:rPr>${a.join("")}</w:rPr>` : "";
  };

  const drawing = (img, maxW) => {
    let w = img.w, h = img.h;
    if (w > maxW){ h = h * maxW / w; w = maxW; }
    const ext = IMG_EXT[img.mime] || "png";
    const name = `image${media.length + 1}.${ext}`;
    media.push({ name, bytes: img.bytes });
    const rid = rel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", "media/" + name);
    const id = ++picId;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${xmlEsc(clean(img.alt || ""))}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };

  const runs = (p, maxW) => {
    let out = "", link = null, buf = "";
    const flush = () => {
      if (!buf) return;
      if (link && !link.startsWith("#")){
        const rid = rel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", link, true);
        out += `<w:hyperlink r:id="${rid}" w:history="1">${buf}</w:hyperlink>`;
      } else out += buf;
      buf = "";
    };
    for (const r of p.runs){
      const l = r.link || null;
      if (l !== link){ flush(); link = l; }
      if (r.br) buf += "<w:r><w:br/></w:r>";
      else if (r.img) buf += drawing(r.img, maxW);
      else if (r.field === "page") buf += `<w:r>${rPr(r, p)}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr(r, p)}<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r>${rPr(r, p)}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr(r, p)}<w:t>1</w:t></w:r><w:r>${rPr(r, p)}<w:fldChar w:fldCharType="end"/></w:r>`;
      else if (r.text) buf += `<w:r>${rPr(r, p)}${text(r.text)}</w:r>`;
    }
    flush();
    return out;
  };

  const para = (p, inCell, maxW, style) => {
    const pr = [];
    if (style) pr.push(`<w:pStyle w:val="${style}"/>`);
    else if (p.heading) pr.push(`<w:pStyle w:val="Heading${Math.min(6, p.heading)}"/>`);
    else if (p.code) pr.push(`<w:pStyle w:val="Code"/>`);
    else if (p.list) pr.push(`<w:pStyle w:val="ListParagraph"/>`);
    if (p.breakBefore) pr.push("<w:pageBreakBefore/>");
    if (p.list){
      const lvl = Math.min(8, p.list.level || 0);
      let numId = 1;
      if (p.list.ordered){
        if (p.list.restart || !numAt[lvl]){
          numId = nums.length + 3;
          nums.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${lvl}"><w:startOverride w:val="${p.list.start || 1}"/></w:lvlOverride></w:num>`);
          numAt[lvl] = numId;
        }
        numId = numAt[lvl];
      }
      pr.push(`<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
    }
    if (p.rule) pr.push(`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>`);
    if (p.shade) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${p.shade.toUpperCase()}"/>`);
    const sp = [];
    if (p.before !== undefined) sp.push(`w:before="${tw(p.before)}"`);
    else if (tight && !inCell) sp.push(`w:before="0"`);
    if (p.after !== undefined) sp.push(`w:after="${tw(p.after)}"`);
    else if (inCell || tight) sp.push(`w:after="0"`);
    if (p.line) sp.push(`w:line="${lineMultiple(p, m)}" w:lineRule="auto"`);
    else if (p.lineExact) sp.push(`w:line="${tw(p.lineExact)}" w:lineRule="atLeast"`);
    if (sp.length) pr.push(`<w:spacing ${sp.join(" ")}/>`);
    if (!p.list){
      const ind = [];
      if (p.left) ind.push(`w:left="${tw(p.left)}"`);
      if (p.right) ind.push(`w:right="${tw(p.right)}"`);
      if (p.first > 0) ind.push(`w:firstLine="${tw(p.first)}"`);
      if (p.first < 0) ind.push(`w:hanging="${tw(-p.first)}"`);
      if (ind.length) pr.push(`<w:ind ${ind.join(" ")}/>`);
    }
    if (p.align) pr.push(`<w:jc w:val="${p.align === "justify" ? "both" : p.align}"/>`);
    let body = runs(p, maxW);
    if (p.breakAfter) body += `<w:r><w:br w:type="page"/></w:r>`;
    return `<w:p>${pr.length ? "<w:pPr>" + pr.join("") + "</w:pPr>" : ""}${body}</w:p>`;
  };

  const table = (t, room) => {
    const cols = colWidths(t, room);
    const total = cols.reduce((a, b) => a + b, 0);
    const b = t.borders ? `w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"` : `w:val="nil"`;
    const rows = t.rows.map(row => {
      let ci = 0;
      const cells = row.map(c => {
        const span = Math.min(c.span, cols.length - ci) || 1;
        const w = cols.slice(ci, ci + span).reduce((a, x) => a + x, 0);
        ci += span;
        const pr = [`<w:tcW w:w="${tw(w)}" w:type="dxa"/>`];
        if (span > 1) pr.push(`<w:gridSpan w:val="${span}"/>`);
        if (c.shade) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${c.shade.toUpperCase()}"/>`);
        if (c.valign === "middle" || c.valign === "bottom") pr.push(`<w:vAlign w:val="${c.valign === "middle" ? "center" : "bottom"}"/>`);
        const inner = c.blocks.map(p => para(p, true, w - 10)).join("") || "<w:p/>";
        return `<w:tc><w:tcPr>${pr.join("")}</w:tcPr>${inner}</w:tc>`;
      });
      // every row must fill the grid
      while (ci < cols.length){ cells.push(`<w:tc><w:tcPr><w:tcW w:w="${tw(cols[ci])}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`); ci++; }
      return `<w:tr>${cells.join("")}</w:tr>`;
    });
    return `<w:tbl><w:tblPr><w:tblW w:w="${tw(total)}" w:type="dxa"/>${t.left ? `<w:tblInd w:w="${tw(t.left)}" w:type="dxa"/>` : ""}` +
      `<w:tblBorders><w:top ${b}/><w:left ${b}/><w:bottom ${b}/><w:right ${b}/><w:insideH ${b}/><w:insideV ${b}/></w:tblBorders>` +
      `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="${t.borders ? 100 : 0}" w:type="dxa"/><w:right w:w="${t.borders ? 100 : 60}" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
      `<w:tblGrid>${cols.map(c => `<w:gridCol w:w="${tw(c)}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;
  };

  const body = [];
  let prev = null;
  let cols = { n: 1, gap: 0 }, sections = 0, filled = false, width = avail;
  const sectPr = (c, refs, follows) => `<w:sectPr>${refs || ""}${follows ? `<w:type w:val="continuous"/>` : ""}` +
    `<w:pgSz w:w="${tw(page.w)}" w:h="${tw(page.h)}"${page.w > page.h ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="${tw(page.top)}" w:right="${tw(page.right)}" w:bottom="${tw(page.bottom)}" w:left="${tw(page.left)}" w:header="${tw(Math.min(36, page.top / 2))}" w:footer="${tw(Math.min(36, page.bottom / 2))}" w:gutter="0"/>` +
    (c.n > 1 ? `<w:cols w:num="${c.n}" w:space="${tw(c.gap)}"/>` : "") + `</w:sectPr>`;
  for (const blk of m.blocks){
    if (blk.type === "cols"){
      if (blk.n === cols.n) continue;
      // a section's settings ride on its last paragraph
      if (filled){
        body.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>@@SECT${body.length}@@</w:pPr></w:p>`);
        pending.push({ at: body.length - 1, cols });
        sections++;
      }
      cols = { n: blk.n, gap: blk.gap };
      width = (avail - cols.gap * (cols.n - 1)) / cols.n;
      filled = false;
      prev = null;
      continue;
    }
    filled = true;
    if (blk.type === "table"){
      if (prev === "table") body.push(`<w:p><w:pPr><w:spacing w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>`);
      body.push(table(blk, width));
    } else if (blk.type === "space"){
      body.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${tw(blk.h)}" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:sz w:val="2"/></w:rPr></w:r></w:p>`);
    } else if (blk.type === "hr"){
      body.push(blk.before !== undefined
        ? `<w:p><w:pPr>${blk.breakBefore ? "<w:pageBreakBefore/>" : ""}<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="0" w:color="404040"/></w:pBdr><w:spacing w:before="${tw(blk.before)}" w:after="0" w:line="40" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`
        : `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>`);
    } else body.push(para(blk, false, width - (blk.left || 0)));
    prev = blk.type;
  }
  if (!body.length || prev === "table") body.push("<w:p/>");

  const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`;
  const files = [];
  const overrides = [];
  let sectRefs = "";
  for (const kind of ["header", "footer"]){
    const paras = m.running && m.running[kind];
    if (!paras || !paras.length) continue;
    const tag = kind === "header" ? "hdr" : "ftr";
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${tag} ${NS}>${paras.map(p => para(p, false, avail, kind === "header" ? "Header" : "Footer")).join("")}</w:${tag}>`;
    files.push({ name: `word/${kind}1.xml`, bytes: enc.encode(xml) });
    overrides.push(`<Override PartName="/word/${kind}1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`);
    const rid = rel(`http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`, `${kind}1.xml`);
    sectRefs += `<w:${kind}Reference w:type="default" r:id="${rid}"/>`;
  }

  // earlier sections were written before the header and footer parts had ids
  // the first section starts the document; later ones carry on down the same page
  pending.forEach((pnd, k) => {
    body[pnd.at] = body[pnd.at].replace(`@@SECT${pnd.at}@@`, sectPr(pnd.cols, sectRefs, k > 0));
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}>
<w:body>
${body.join("\n")}
${sectPr(cols, sectRefs, sections > 0)}
</w:body>
</w:document>`;

  const relXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${rels.map(r => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlEsc(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("\n")}
</Relationships>`;

  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="gif" ContentType="image/gif"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
${overrides.join("\n")}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return zipWrite([
    { name: "[Content_Types].xml", bytes: enc.encode(types) },
    { name: "_rels/.rels", bytes: enc.encode(rootRels) },
    { name: "word/document.xml", bytes: enc.encode(documentXml) },
    { name: "word/_rels/document.xml.rels", bytes: enc.encode(relXml) },
    { name: "word/styles.xml", bytes: enc.encode(docxStyles(m)) },
    { name: "word/numbering.xml", bytes: enc.encode(docxNumbering(nums)) },
    ...files,
    ...media.map(f => ({ name: "word/media/" + f.name, bytes: f.bytes }))
  ]);
}

export async function htmlToDocx(html){
  return modelToDocx(htmlToModel(html));
}

/* ==========================================================================
   RTF. Word, Pages and LibreOffice all open it, and Word treats a .doc file
   that holds RTF as a normal document.
   ========================================================================== */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function rtfText(s){
  let out = "";
  for (const ch of clean(s)){
    const c = ch.codePointAt(0);
    if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
    else if (ch === "\t") out += "\\tab ";
    else if (c < 128) out += ch;
    else if (c < 0x10000) out += "\\u" + (c > 32767 ? c - 65536 : c) + "?";
    else {
      const v = c - 0x10000;
      const hi = 0xd800 + (v >> 10), lo = 0xdc00 + (v & 0x3ff);
      out += "\\u" + (hi - 65536) + "?\\u" + (lo - 65536) + "?";
    }
  }
  return out;
}

export function modelToRtf(m){
  const page = m.page || LETTER;
  const avail = page.w - page.left - page.right;
  const tight = !!m.page;
  const baseSize = m.size || 11;
  const fonts = [m.font || "Calibri"];
  const colors = [];
  const font = name => { let i = fonts.indexOf(name); if (i < 0){ fonts.push(name); i = fonts.length - 1; } return i; };
  const color = hex => { hex = hex.toLowerCase(); let i = colors.indexOf(hex); if (i < 0){ colors.push(hex); i = colors.length - 1; } return i + 1; };
  const counters = [];
  const out = [];

  const picture = (img, maxW) => {
    if (img.mime === "image/gif") return `{\\i [image]}`;
    let w = img.w, h = img.h;
    if (w > maxW){ h = h * maxW / w; w = maxW; }
    const hex = [];
    const b = img.bytes;
    for (let i = 0; i < b.length; i += 64){
      let line = "";
      for (let k = i; k < Math.min(b.length, i + 64); k++) line += HEX[b[k]];
      hex.push(line);
    }
    return `{\\pict\\${img.mime === "image/jpeg" ? "jpegblip" : "pngblip"}\\picw${Math.round(w / 0.75)}\\pich${Math.round(h / 0.75)}\\picwgoal${tw(w)}\\pichgoal${tw(h)}\n${hex.join("\n")}}`;
  };

  const run = (r, p, maxW) => {
    if (r.br) return "\\line ";
    if (r.img) return picture(r.img, maxW);
    const size = r.size || (p.heading ? HEAD_SIZE[Math.min(6, p.heading) - 1] : (p.code ? 9.5 : baseSize));
    let c = `\\f${font(r.font || (p.code ? "Consolas" : fonts[0]))}\\fs${Math.round(size * 2)}`;
    const col = r.color || (r.link ? "0563c1" : null);
    if (col) c += `\\cf${color(col)}`;
    if (r.b || (p.heading && r.b !== false && !tight)) c += "\\b";
    if (r.i) c += "\\i";
    if (r.u || r.link) c += "\\ul";
    if (r.strike) c += "\\strike";
    if (r.va === "super") c += "\\super";
    if (r.va === "sub") c += "\\sub";
    if (r.bg) c += `\\chshdng0\\chcbpat${color(r.bg)}`;
    if (r.field === "page") return `{${c} {\\field{\\*\\fldinst{PAGE}}{\\fldrslt 1}}}`;
    return `{${c} ${rtfText(r.text || "")}}`;
  };

  const runs = (p, maxW) => {
    let s = "", link = null, buf = "";
    const flush = () => {
      if (!buf) return;
      s += link && !link.startsWith("#")
        ? `{\\field{\\*\\fldinst{HYPERLINK "${rtfText(link).replace(/"/g, "%22")}"}}{\\fldrslt{${buf}}}}` : buf;
      buf = "";
    };
    for (const r of p.runs){
      const l = r.link || null;
      if (l !== link){ flush(); link = l; }
      buf += run(r, p, maxW);
    }
    flush();
    return s;
  };

  const para = (p, inCell, maxW) => {
    let c = "\\pard\\plain" + (inCell ? "\\intbl" : "");
    c += p.align === "center" ? "\\qc" : p.align === "right" ? "\\qr" : p.align === "justify" ? "\\qj" : "\\ql";
    let left = p.left || 0, first = p.first || 0, lead = "";
    if (p.list){
      const lvl = Math.min(8, p.list.level || 0);
      left = 36 * (lvl + 1); first = -18;
      if (p.list.ordered){
        if (p.list.restart) counters[lvl] = (p.list.start || 1) - 1;
        counters[lvl] = (counters[lvl] || 0) + 1;
        counters.length = lvl + 1;
        lead = `{\\f${font(fonts[0])}\\fs${Math.round(baseSize * 2)} ${counters[lvl]}.\\tab}`;
      } else lead = `{\\f${font(fonts[0])}\\fs${Math.round(baseSize * 2)} \\u8226?\\tab}`;
    }
    if (left) c += `\\li${tw(left)}`;
    if (p.right) c += `\\ri${tw(p.right)}`;
    if (first) c += `\\fi${tw(first)}`;
    const before = p.before !== undefined ? p.before : (p.heading && !tight ? 12 : 0);
    const after = p.after !== undefined ? p.after : (inCell || tight ? 0 : (p.list ? 3 : p.code ? 6 : 8));
    if (before) c += `\\sb${tw(before)}`;
    if (after) c += `\\sa${tw(after)}`;
    if (p.line) c += `\\sl${lineMultiple(p, m)}\\slmult1`;
    else if (p.lineExact) c += `\\sl${tw(p.lineExact)}\\slmult0`;
    else if (!tight && !inCell && !p.code) c += "\\sl276\\slmult1";
    if (p.breakBefore) c += "\\pagebb";
    if (p.heading) c += `\\keepn\\outlinelevel${Math.min(6, p.heading) - 1}`;
    if (p.shade) c += `\\cbpat${color(p.shade)}`;
    if (p.rule) c += "\\brdrb\\brdrs\\brdrw10\\brsp20";
    return `${c} ${lead}${runs(p, maxW)}${p.breakAfter ? "\\page " : ""}`;
  };

  const table = (t, room) => {
    const cols = colWidths(t, room);
    for (const row of t.rows){
      let def = `\\trowd\\trgaph${t.borders ? 100 : 30}${t.left ? `\\trleft${tw(t.left)}` : ""}`;
      let x = t.left || 0, ci = 0;
      const widths = [];
      for (const c of row){
        const span = Math.min(c.span, cols.length - ci) || 1;
        const w = cols.slice(ci, ci + span).reduce((a, v) => a + v, 0);
        ci += span;
        x += w;
        widths.push(w);
        if (t.borders) def += "\\clbrdrt\\brdrs\\brdrw10\\brdrcf" + color("bfbfbf") + "\\clbrdrl\\brdrs\\brdrw10\\brdrcf" + color("bfbfbf") +
          "\\clbrdrb\\brdrs\\brdrw10\\brdrcf" + color("bfbfbf") + "\\clbrdrr\\brdrs\\brdrw10\\brdrcf" + color("bfbfbf");
        if (c.shade) def += `\\clcbpat${color(c.shade)}`;
        if (c.valign === "middle") def += "\\clvertalc";
        def += `\\cellx${tw(x)}`;
      }
      let cells = "";
      row.forEach((c, i) => {
        const ps = c.blocks.length ? c.blocks : [{ type: "p", runs: [] }];
        cells += ps.map(p => para(p, true, widths[i] - 10)).join("\\par\n") + "\\cell\n";
      });
      out.push(def + "\n" + cells + "\\row");
    }
    out.push("\\pard");
  };

  let ncols = 1, width = avail, any = false;
  for (const blk of m.blocks){
    if (blk.type === "cols"){
      if (blk.n === ncols) continue;
      ncols = blk.n;
      width = (avail - blk.gap * (ncols - 1)) / ncols;
      out.push(`${any ? "\\sect" : ""}\\sectd\\sbknone\\cols${ncols}${ncols > 1 ? `\\colsx${tw(blk.gap)}` : ""}`);
      continue;
    }
    any = true;
    if (blk.type === "table") table(blk, width);
    else if (blk.type === "hr" && blk.before !== undefined) out.push(`\\pard\\plain${blk.breakBefore ? "\\pagebb" : ""}\\sb${tw(blk.before)}\\sl-40\\slmult0\\brdrb\\brdrs\\brdrw15\\fs2 \\par`);
    else if (blk.type === "space") out.push(`\\pard\\plain\\sl-${tw(blk.h)}\\slmult0\\fs2 \\par`);
    else if (blk.type === "hr") out.push("\\pard\\plain\\brdrb\\brdrs\\brdrw10\\brsp20 \\par");
    else out.push(para(blk, false, width - (blk.left || 0)) + "\\par");
  }

  let running = "";
  for (const kind of ["header", "footer"]){
    const paras = m.running && m.running[kind];
    if (paras && paras.length) running += `{\\${kind} ${paras.map(p => para(p, false, avail) + "\\par").join("\n")}}\n`;
  }

  const fonttbl = fonts.map((f, i) => `{\\f${i}\\fnil ${rtfText(f).replace(/;/g, "")};}`).join("");
  const colortbl = ";" + colors.map(h => `\\red${parseInt(h.slice(0, 2), 16)}\\green${parseInt(h.slice(2, 4), 16)}\\blue${parseInt(h.slice(4, 6), 16)};`).join("");
  return `{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0{\\fonttbl${fonttbl}}{\\colortbl${colortbl}}\n` +
    `\\paperw${tw(page.w)}\\paperh${tw(page.h)}${page.w > page.h ? "\\landscape" : ""}\\margl${tw(page.left)}\\margr${tw(page.right)}\\margt${tw(page.top)}\\margb${tw(page.bottom)}\\widowctrl\n` +
    running + out.join("\n") + "\n}";
}

export function htmlToRtf(html){
  return modelToRtf(htmlToModel(html));
}
