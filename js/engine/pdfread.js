// PDF reading through pdf.js. A PDF stores glyphs at positions, not paragraphs,
// so turning one into a document means working the structure back out: lines,
// columns, tables, lists, headings, and the font, size and colour of each run.

import { MODULES } from "./modules.js";
import { bytesToB64, escHtml } from "./util.js";

export async function loadPdfDoc(blob){
  const lib = await MODULES.pdfjs.load();
  const data = new Uint8Array(await blob.arrayBuffer());
  return lib.getDocument({ data, isEvalSupported: false }).promise;
}

export async function pdfToCanvases(doc, scale){
  const out = [];
  for (let n = 1; n <= doc.numPages; n++){
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: scale || 2 });
    const canvas = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(canvas);
  }
  return out;
}

/* ---- small helpers ------------------------------------------------------ */

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
];
const at = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const r1 = v => Math.round(v * 10) / 10;
const half = v => Math.round(v * 2) / 2;
const hex2 = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

const KNOWN_FONTS = [
  [/times|tinos|nimbusrom|liberationserif|thorndale/, "Times New Roman"],
  [/arial|helvetica|nimbussan|liberationsans|arimo|albany/, "Arial"],
  [/courier|cousine|nimbusmono|liberationmono|cumberland/, "Courier New"],
  [/calibri|carlito/, "Calibri"], [/cambria|caladea/, "Cambria"], [/georgia/, "Georgia"], [/verdana/, "Verdana"],
  [/tahoma/, "Tahoma"], [/trebuchet/, "Trebuchet MS"], [/garamond/, "Garamond"], [/palatino|pallad/, "Palatino Linotype"],
  [/bookantiqua/, "Book Antiqua"], [/centuryschool/, "Century Schoolbook"], [/centurygothic/, "Century Gothic"],
  [/segoeui/, "Segoe UI"], [/opensans/, "Open Sans"], [/roboto/, "Roboto"], [/lato/, "Lato"],
  [/sourcesans/, "Source Sans Pro"], [/montserrat/, "Montserrat"], [/dejavusans/, "DejaVu Sans"],
  [/dejavuserif/, "DejaVu Serif"], [/consolas/, "Consolas"], [/comicsans/, "Comic Sans MS"], [/impact/, "Impact"],
  [/gillsans/, "Gill Sans MT"], [/franklingothic/, "Franklin Gothic Book"], [/candara/, "Candara"], [/constantia/, "Constantia"],
  [/corbel/, "Corbel"], [/notosans/, "Noto Sans"], [/notoserif/, "Noto Serif"], [/inter\b|^inter/, "Inter"],
  [/symbol/, "Symbol"], [/wingdings/, "Wingdings"], [/zapfdingbats|dingbats/, "Wingdings"],
  [/^cmtt|^lmmono/, "Courier New"], [/^cmss|^lmsans/, "Arial"], [/^cm[a-z]{1,4}\d|^lmroman|^sfr[mbt]/, "Times New Roman"]
];

// Work out a family name Word will recognise, plus weight and slant, from a PDF font.
function describeFont(raw, flags, generic){
  const name = String(raw || "").replace(/^[A-Z]{6}\+/, "");
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const bold = !!(flags && (flags.bold || flags.black)) || /bold|black|heavy|semibold|demi|^cmbx|^cmb\d|^sfbx/i.test(name);
  const italic = !!(flags && flags.italic) || /italic|oblique|^cmti|^cmsl|^cmbxti|^sfti/i.test(name);
  let family = null;
  for (const [re, fam] of KNOWN_FONTS) if (re.test(key)){ family = fam; break; }
  if (!family){
    const base = name.split(/[-,]/)[0]
      .replace(/(PS|MT|PSMT|Std|Pro|LT|Regular|Roman|Book|Medium|Light|Bold|Italic|Oblique|Semibold|Black)+$/g, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2").trim();
    if (/^[A-Za-z][A-Za-z ]{2,40}$/.test(base) && !/^(f|t|g|font|cid|type)\s?\d*$/i.test(base)) family = base;
  }
  if (!family) family = generic === "monospace" ? "Courier New" : generic === "serif" ? "Times New Roman" : "Arial";
  return { family, bold, italic };
}

const BULLET = /^\s*([•◦▪▫‣⁃∙●○■□➢➤►▸–—·-])\s+(?=\S)/;
const NUMBER = /^\s*(\(?(\d{1,3})[.)]|\(([a-z])\)|([a-z])\))\s+(?=\S)/;
const PAGE_NO = /^\s*(page\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?(\s*(of|\/)\s*\d{1,4})?\s*$/i;

// Merge boxes that touch or overlap into groups. `n` counts the boxes in each.
function cluster(boxes, pad){
  const groups = boxes.map(b => ({ ...b, n: 1 }));
  for (let merged = true; merged;){
    merged = false;
    outer: for (let i = 0; i < groups.length; i++){
      for (let j = i + 1; j < groups.length; j++){
        const a = groups[i], b = groups[j];
        if (a.x0 - pad <= b.x1 && b.x0 - pad <= a.x1 && a.y0 - pad <= b.y1 && b.y0 - pad <= a.y1){
          groups[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), n: a.n + b.n };
          groups.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return groups;
}

// Ruled lines that cross to form a grid mark a table: the lines give its columns and rows.
function findGrids(rules){
  if (rules.length < 4 || rules.length > 4000) return [];
  const distinct = vals => {
    const out = [];
    for (const v of vals.sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > 2.5) out.push(v);
    return out;
  };
  const grids = [];
  for (const g of cluster(rules, 2)){
    if (g.n < 4) continue;
    const inside = rules.filter(r => r.x1 >= g.x0 - 1 && r.x0 <= g.x1 + 1 && r.y1 >= g.y0 - 1 && r.y0 <= g.y1 + 1);
    const xs = distinct(inside.filter(r => !r.horizontal).map(r => (r.x0 + r.x1) / 2));
    const ys = distinct(inside.filter(r => r.horizontal).map(r => (r.y0 + r.y1) / 2));
    if (xs.length >= 3 && ys.length >= 2) grids.push({ xs, ys });
  }
  return grids;
}

/* ---- one page: spans, pictures and ruled lines -------------------------- */

async function readPage(lib, page, want){
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const OPS = lib.OPS;
  const out = { W, H, spans: [], pictures: [], rules: [], grids: [], dots: [], hrs: [] };

  const ops = await page.getOperatorList();            // also loads the fonts
  const tc = await page.getTextContent();

  // 1. where images and drawings sit
  const imgBoxes = [], pathBoxes = [];
  if (want.styled){
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    let pending = null;
    const boxOf = (m, x0, y0, x1, y1) => {
      const full = mul(vp.transform, m);
      const pts = [at(full, x0, y0), at(full, x1, y0), at(full, x0, y1), at(full, x1, y1)];
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    };
    const CURVES = new Set([OPS.curveTo, OPS.curveTo2, OPS.curveTo3]);
    for (let i = 0; i < ops.fnArray.length; i++){
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.save || fn === OPS.beginGroup) stack.push(ctm);
      else if (fn === OPS.restore || fn === OPS.endGroup || fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin){ stack.push(ctm); if (Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0]); }
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject){
        imgBoxes.push(boxOf(ctm, 0, 0, 1, 1));
      }
      else if (fn === OPS.constructPath){
        const sub = args[0], co = args[1];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, k = 0, curved = false, slanted = false, px = null, py = null;
        const see = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
        for (const op of sub){
          if (op === OPS.rectangle){ see(co[k], co[k + 1]); see(co[k] + co[k + 2], co[k + 1] + co[k + 3]); k += 4; }
          else if (op === OPS.moveTo){ px = co[k]; py = co[k + 1]; see(px, py); k += 2; }
          else if (op === OPS.lineTo){
            if (px !== null && Math.abs(co[k] - px) > 0.5 && Math.abs(co[k + 1] - py) > 0.5) slanted = true;
            px = co[k]; py = co[k + 1]; see(px, py); k += 2;
          }
          else if (op === OPS.curveTo){ curved = true; for (let j = 0; j < 6; j += 2) see(co[k + j], co[k + j + 1]); px = co[k + 4]; py = co[k + 5]; k += 6; }
          else if (CURVES.has(op)){ curved = true; for (let j = 0; j < 4; j += 2) see(co[k + j], co[k + j + 1]); px = co[k + 2]; py = co[k + 3]; k += 4; }
        }
        pending = x1 >= x0 ? { m: ctm, x0, y0, x1, y1, shaped: curved || slanted } : null;
      }
      else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.stroke || fn === OPS.fillStroke || fn === OPS.eoFillStroke ||
               fn === OPS.closeStroke || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke){
        if (pending){
          const b = boxOf(pending.m, pending.x0, pending.y0, pending.x1, pending.y1);
          b.shaped = pending.shaped;
          pathBoxes.push(b);
          pending = null;
        }
      }
      else if (fn === OPS.endPath) pending = null;
    }
  }

  // 2. text
  const fontCache = new Map();
  const fontOf = id => {
    if (fontCache.has(id)) return fontCache.get(id);
    let obj = null;
    try { if (page.commonObjs.has(id)) obj = page.commonObjs.get(id); } catch (e){ /* not loaded */ }
    const st = (tc.styles && tc.styles[id]) || {};
    const d = describeFont(obj && obj.name, obj, st.fontFamily);
    fontCache.set(id, d);
    return d;
  };
  for (const it of tc.items){
    if (!it.str || !it.str.trim() && !it.str.includes(" ")) continue;
    const m = mul(vp.transform, it.transform);
    if (Math.abs(Math.atan2(m[1], m[0])) > 0.06) continue;        // turned text: watermarks, axis labels
    const size = Math.hypot(m[2], m[3]);
    if (size < 2) continue;
    const f = fontOf(it.fontName);
    out.spans.push({ str: it.str, x: m[4], y: m[5], w: it.width, x1: m[4] + it.width, size,
      font: f.family, b: f.bold, i: f.italic, u: false, strike: false, color: null, bg: null, link: null });
  }

  // 3. links
  try {
    for (const a of await page.getAnnotations()){
      if (a.subtype !== "Link" || !a.url || !a.rect) continue;
      const r = vp.convertToViewportRectangle(a.rect);
      const x0 = Math.min(r[0], r[2]), x1 = Math.max(r[0], r[2]), y0 = Math.min(r[1], r[3]), y1 = Math.max(r[1], r[3]);
      for (const s of out.spans){
        const cx = s.x + s.w / 2, cy = s.y - s.size * 0.3;
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) s.link = a.url;
      }
    }
  } catch (e){ /* links are a nicety */ }

  if (!want.styled) return out;

  // 4. ruled lines: table borders, underlines, strike-through, and rules across the page
  for (const b of pathBoxes){
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (Math.min(w, h) < 2.5 && Math.max(w, h) > 8) out.rules.push({ ...b, horizontal: w > h });
    // small round or square marks are bullets when a line of text starts beside them
    else if (w >= 1.5 && w <= 9 && h >= 1.5 && h <= 9 && Math.abs(w - h) <= 2.5) out.dots.push(b);
  }
  out.grids = findGrids(out.rules);

  // Cut a span in three at two x positions, so part of it can carry its own style.
  const cut = (s, xa, xb) => {
    const n = s.str.length;
    const near = (x, wantStart) => {
      const i = Math.max(0, Math.min(n, Math.round((x - s.x) / s.w * n)));
      for (let d = 0; d <= 3; d++) for (const k of [i - d, i + d]){
        if (k <= 0 || k >= n) continue;
        if (wantStart ? s.str[k - 1] === " " && s.str[k] !== " " : s.str[k] === " " && s.str[k - 1] !== " ") return k;
      }
      return i;
    };
    const i0 = xa <= s.x + 1 ? 0 : near(xa, true), i1 = xb >= s.x1 - 1 ? n : near(xb, false);
    if (i1 <= i0 || (i0 === 0 && i1 === n)) return null;
    const piece = (a, b) => ({ ...s, str: s.str.slice(a, b), x: s.x + s.w * a / n, x1: s.x + s.w * b / n, w: s.w * (b - a) / n });
    return [i0 > 0 ? piece(0, i0) : null, piece(i0, i1), i1 < n ? piece(i1, n) : null];
  };
  const partial = (x0, x1, test, mark) => {
    for (let k = 0; k < out.spans.length; k++){
      const s = out.spans[k];
      if (!s.str.trim() || !test(s)) continue;
      const over = Math.min(s.x1, x1) - Math.max(s.x, x0);
      if (over < 4) continue;
      if (over >= s.w * 0.8){ mark(s); continue; }
      const parts = cut(s, x0, x1);
      if (!parts) continue;
      mark(parts[1]);
      const kept = parts.filter(Boolean);
      out.spans.splice(k, 1, ...kept);
      k += kept.length - 1;
    }
  };
  for (const r of out.rules){
    if (!r.horizontal || r.x1 - r.x0 > W * 0.9) continue;
    const y = (r.y0 + r.y1) / 2;
    let used = false;
    partial(r.x0, r.x1, s => y > s.y + s.size * 0.02 && y < s.y + s.size * 0.28, s => { s.u = true; used = true; });
    partial(r.x0, r.x1, s => y < s.y - s.size * 0.18 && y > s.y - s.size * 0.42, s => { s.strike = true; used = true; });
    r.used = used;
  }
  // a filled box behind part of a line is a highlight; splitting there lets the colour be read per piece
  for (const b of pathBoxes){
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (b.shaped || h < 6 || h > 40 || w < 8 || w > W * 0.5) continue;
    partial(b.x0, b.x1, s => s.y - s.size * 0.3 > b.y0 && s.y - s.size * 0.3 < b.y1 && s.w > w + 6, () => {});
  }
  // rules across the text that belong to no table and underline nothing
  const inGridBox = r => out.grids.some(g => r.y0 >= g.ys[0] - 3 && r.y1 <= g.ys[g.ys.length - 1] + 3 && r.x0 >= g.xs[0] - 3 && r.x1 <= g.xs[g.xs.length - 1] + 3);
  for (const r of out.rules){
    if (r.horizontal && !r.used && r.x1 - r.x0 > W * 0.25 && !inGridBox(r)) out.hrs.push({ x0: r.x0, x1: r.x1, y: (r.y0 + r.y1) / 2 });
  }

  // 5. draw the page once: colours are read from it, and pictures are cut out of it
  const S = 2;
  const rvp = page.getViewport({ scale: S });
  const canvas = new OffscreenCanvas(Math.ceil(rvp.width), Math.ceil(rvp.height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: rvp }).promise;
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const CW = canvas.width, CH = canvas.height;

  for (const s of out.spans){
    if (!s.str.trim()) continue;
    const x0 = Math.max(0, Math.floor(s.x * S)), x1 = Math.min(CW - 1, Math.ceil(s.x1 * S));
    const y0 = Math.max(0, Math.floor((s.y - s.size * 0.75) * S)), y1 = Math.min(CH - 1, Math.ceil((s.y + s.size * 0.2) * S));
    if (x1 <= x0 || y1 <= y0) continue;
    const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 500)));
    const counts = new Map();
    const samples = [];
    for (let y = y0; y <= y1; y += step){
      for (let x = x0; x <= x1; x += step){
        const i = (y * CW + x) * 4;
        const key = (px[i] >> 3 << 10) | (px[i + 1] >> 3 << 5) | (px[i + 2] >> 3);
        const c = counts.get(key);
        if (c) c.n++; else counts.set(key, { n: 1, r: px[i], g: px[i + 1], b: px[i + 2] });
        samples.push(i);
      }
    }
    let bg = null;
    for (const c of counts.values()) if (!bg || c.n > bg.n) bg = c;
    let far = 0;
    const dist = samples.map(i => {
      const d = Math.abs(px[i] - bg.r) + Math.abs(px[i + 1] - bg.g) + Math.abs(px[i + 2] - bg.b);
      if (d > far) far = d;
      return d;
    });
    if (far >= 90){
      let r = 0, g = 0, b = 0, n = 0;
      samples.forEach((i, k) => { if (dist[k] >= far * 0.8){ r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; } });
      r /= n; g /= n; b /= n;
      if (Math.max(r, g, b) > 60 || Math.min(bg.r, bg.g, bg.b) < 128) s.color = hex2(r) + hex2(g) + hex2(b);
    }
    if (Math.min(bg.r, bg.g, bg.b) < 248) s.bg = hex2(bg.r) + hex2(bg.g) + hex2(bg.b);
  }

  // 6. pictures: placed images, and clusters of drawn shapes such as logos and charts
  const clip = b => ({ ...b, x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(W, b.x1), y1: Math.min(H, b.y1) });
  const area = b => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const hasText = out.spans.some(s => s.str.trim());
  const found = [];
  for (const g of cluster(imgBoxes.map(clip).filter(b => b.x1 - b.x0 > 6 && b.y1 - b.y0 > 6), 1)){
    if (hasText && area(g) > W * H * 0.8) continue;                 // a scan behind its own text layer
    found.push(g);
  }
  const shaped = pathBoxes.map(clip).filter(b => b.shaped && area(b) < W * H * 0.6 && Math.max(b.x1 - b.x0, b.y1 - b.y0) > 3);
  if (shaped.length <= 1500){
    const totalChars = out.spans.reduce((a, s) => a + s.str.length, 0);
    for (const g of cluster(shaped, 6)){
      if (g.n < 3 || g.x1 - g.x0 < 20 || g.y1 - g.y0 < 20) continue;
      const inside = out.spans.filter(s => s.x + s.w / 2 > g.x0 && s.x + s.w / 2 < g.x1 && s.y > g.y0 && s.y - s.size * 0.5 < g.y1);
      const chars = inside.reduce((a, s) => a + s.str.length, 0);
      if (chars > 400 || (totalChars > 200 && chars > totalChars * 0.35)) continue;   // decoration behind body text
      g.figure = true;
      found.push(g);
    }
  }
  for (const g of cluster(found, 0)){
    const x = Math.floor(g.x0 * S), y = Math.floor(g.y0 * S);
    const w = Math.min(CW - x, Math.ceil((g.x1 - g.x0) * S)), h = Math.min(CH - y, Math.ceil((g.y1 - g.y0) * S));
    if (w < 8 || h < 8) continue;
    const cut = new OffscreenCanvas(w, h);
    cut.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
    const jpeg = w * h > 260000;
    const blob = await cut.convertToBlob(jpeg ? { type: "image/jpeg", quality: 0.9 } : { type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    out.pictures.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, uri: `data:${jpeg ? "image/jpeg" : "image/png"};base64,${bytesToB64(bytes)}` });
    // words inside a picture are already in it
    out.spans = out.spans.filter(s => !(s.x + s.w / 2 > g.x0 && s.x + s.w / 2 < g.x1 && s.y - s.size * 0.3 > g.y0 && s.y - s.size * 0.3 < g.y1));
  }
  return out;
}

/* ---- lines and columns -------------------------------------------------- */

function buildLines(pg){
  const spans = pg.spans.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const s of spans){
    let row = null;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 6; k--){
      const r = rows[k];
      if (Math.abs(r.y - s.y) <= 0.42 * Math.max(r.size, s.size)){ row = r; break; }
    }
    if (!row){ row = { y: s.y, size: s.size, spans: [] }; rows.push(row); }
    row.spans.push(s);
    if (s.str.trim().length > 1 && s.size > row.size){ row.size = s.size; row.y = s.y; }
  }
  const lines = [];
  for (const row of rows){
    row.spans.sort((a, b) => a.x - b.x);
    // the size and baseline most of the text on this row uses
    const bySize = new Map();
    for (const s of row.spans){ const k = half(s.size); bySize.set(k, (bySize.get(k) || 0) + s.str.trim().length); }
    let size = row.size, most = -1;
    for (const [k, n] of bySize) if (n > most){ most = n; size = k; }
    const main = row.spans.filter(s => half(s.size) === size);
    const y = main.length ? median(main.map(s => s.y)) : row.y;
    const segs = [];
    let seg = null;
    for (const s of row.spans){
      const blank = !s.str.trim();
      if (blank){ if (seg) seg.spans.push(s); continue; }
      const gap = seg ? s.x - seg.x1 : 0;
      const walled = seg && pg.rules.some(r => !r.horizontal && r.x0 > seg.x1 - 1 && r.x1 < s.x + 1 && r.y0 < y && r.y1 > y - size * 0.5);
      if (!seg || gap > Math.max(1.6 * size, 14) || walled){
        seg = { x0: s.x, x1: s.x1, spans: [] };
        segs.push(seg);
      } else if (gap > 0.18 * size && seg.spans.length){
        const last = seg.spans[seg.spans.length - 1];
        if (!/\s$/.test(last.str) && !/^\s/.test(s.str)) last.str += " ";
      }
      seg.spans.push(s);
      seg.x1 = Math.max(seg.x1, s.x1);
    }
    for (const g of segs){
      while (g.spans.length && !g.spans[g.spans.length - 1].str.trim()) g.spans.pop();
      if (!g.spans.length) continue;
      g.text = g.spans.map(s => s.str).join("").replace(/\s+/g, " ").trim();
      // two columns can share a row yet sit on slightly different baselines
      const tally = new Map();
      for (const s of g.spans){ const k = half(s.size); tally.set(k, (tally.get(k) || 0) + s.str.trim().length); }
      let gs = size, top = -1;
      for (const [k, n] of tally) if (n > top){ top = n; gs = k; }
      g.size = gs;
      g.y = median(g.spans.filter(s => s.str.trim() && half(s.size) === gs).map(s => s.y)) || y;
    }
    const good = segs.filter(g => g.spans.length && g.text);
    if (good.length) lines.push({ y, size, segs: good });
  }
  lines.sort((a, b) => a.y - b.y);
  return lines;
}

// Find gutters that split the page into columns of prose, and put the lines in reading order.
function orderByColumns(lines, pg){
  if (lines.length < 12) return [{ lines, col: false }];
  const L = Math.floor(Math.min(...lines.map(l => l.segs[0].x0)));
  const R = Math.ceil(Math.max(...lines.map(l => l.segs[l.segs.length - 1].x1)));
  const width = R - L;
  if (width < 200) return [{ lines, col: false }];
  const cover = new Uint16Array(width + 2);
  for (const l of lines) for (const g of l.segs){
    for (let x = Math.max(0, Math.floor(g.x0) - L); x <= Math.min(width, Math.ceil(g.x1) - L); x++) cover[x]++;
  }
  const gutters = [];
  const quiet = Math.max(1, Math.floor(lines.length * 0.06));
  for (let x = Math.floor(width * 0.2), start = -1; x <= Math.ceil(width * 0.8) + 1; x++){
    const empty = x <= Math.ceil(width * 0.8) && cover[x] <= quiet;
    if (empty && start < 0) start = x;
    if (!empty && start >= 0){
      if (x - start >= 9) gutters.push({ x0: L + start, x1: L + x });
      start = -1;
    }
  }
  if (!gutters.length) return [{ lines, col: false }];
  const edges = [L, ...gutters.flatMap(g => [g.x0, g.x1]), R];
  const cols = [];
  for (let i = 0; i < edges.length; i += 2) cols.push({ x0: edges[i], x1: edges[i + 1], fill: [] });
  const colOf = g => {
    const m = (g.x0 + g.x1) / 2;
    let best = 0, d = Infinity;
    cols.forEach((c, k) => { const dk = m < c.x0 ? c.x0 - m : m > c.x1 ? m - c.x1 : 0; if (dk < d){ d = dk; best = k; } });
    return best;
  };
  for (const l of lines) for (const g of l.segs){
    const c = cols[colOf(g)];
    if (c) c.fill.push((g.x1 - g.x0) / Math.max(1, c.x1 - c.x0));
  }
  // prose fills its column; the cells of a table mostly do not
  if (cols.some(c => c.fill.length < 6 || median(c.fill) < 0.6)) return [{ lines, col: false }];

  const bands = [];
  let buckets = cols.map(() => []);
  const gapW = gutters.reduce((a, g) => a + (g.x1 - g.x0), 0) / gutters.length;
  const flush = () => {
    cols.forEach((c, i) => {
      if (buckets[i].length) bands.push({ lines: buckets[i].sort((a, b) => a.y - b.y), L: c.x0, R: c.x1, col: true, n: cols.length, gapW });
    });
    buckets = cols.map(() => []);
  };
  for (const l of lines){
    const crosses = l.segs.some(g => gutters.some(gt => g.x0 < gt.x0 - 2 && g.x1 > gt.x1 + 2));
    if (crosses){
      flush();
      const last = bands[bands.length - 1];
      if (last && !last.col) last.lines.push(l); else bands.push({ lines: [l], col: false });
      continue;
    }
    const per = cols.map(() => []);
    for (const g of l.segs) per[colOf(g)].push(g);
    per.forEach((segs, i) => { if (segs.length) buckets[i].push({ y: median(segs.map(g => g.y)), size: Math.max(...segs.map(g => g.size)), segs }); });
  }
  flush();
  return bands;
}

/* ---- blocks: tables, lists, paragraphs ---------------------------------- */

const styleOf = s => `${s.font}|${half(s.size)}|${s.b ? 1 : 0}${s.i ? 1 : 0}${s.u ? 1 : 0}${s.strike ? 1 : 0}|${s.color || ""}|${s.bg || ""}|${s.link || ""}|${s.va || ""}`;

// Turn the spans of some lines into runs, joining neighbours that look the same.
function runsOf(lineSegs, lead){
  let runs = [];
  lineSegs.forEach((ls, li) => {
    const seg = ls.seg, size = seg.size || ls.size, y = seg.y !== undefined ? seg.y : ls.y;
    if (li){
      // a word broken across lines keeps its hyphen and gets no space
      const last = runs[runs.length - 1];
      if (last && !/[\s-]$/.test(last.text)) last.text += " ";
    }
    for (const s of seg.spans){
      const str = s.str;
      const small = s.size < size * 0.8;
      const va = small && y - s.y > size * 0.18 ? "super" : small && s.y - y > size * 0.1 ? "sub" : "";
      const r = { text: str, font: s.font, size: half(va ? size : s.size), b: s.b, i: s.i, u: s.u, strike: s.strike, color: s.color, bg: s.bg, link: s.link, va };
      const last = runs[runs.length - 1];
      if (last && styleOf(last) === styleOf(r)) last.text += str;
      else runs.push(r);
    }
  });
  for (const r of runs) r.text = r.text.replace(/\s+/g, " ");
  if (lead){
    // take the bullet or number off the front; the list supplies its own
    const m = lead.exec(runs.map(r => r.text).join(""));
    let n = m ? m[0].length : 0;
    while (n > 0 && runs.length){
      if (runs[0].text.length <= n){ n -= runs[0].text.length; runs.shift(); }
      else { runs[0].text = runs[0].text.slice(n); n = 0; }
    }
  }
  runs = runs.filter(r => r.text);
  if (runs.length){
    runs[0].text = runs[0].text.replace(/^\s+/, "");
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, "");
  }
  return runs.filter(r => r.text);
}

const allBold = l => l.segs.every(g => g.spans.every(s => s.b || !s.str.trim()));

function buildBlocks(band, pg, lead, box){
  const lines = band.lines;
  const blocks = [];
  if (!lines.length) return blocks;
  const colSet = band.col ? { n: band.n, gap: band.gapW } : null;
  const FL = Math.min(band.col ? band.L : box.L, ...lines.map(l => l.segs[0].x0));
  const FR = Math.max(band.col ? band.R : box.R, ...lines.map(l => l.segs[l.segs.length - 1].x1));
  const flowW = Math.max(1, FR - FL);
  const gapOf = i => i > 0 ? lines[i].y - lines[i - 1].y : 0;
  const dotFor = l => pg.dots.find(d => d.x1 <= l.segs[0].x0 + 0.5 && l.segs[0].x0 - d.x1 < 24 &&
    (d.y0 + d.y1) / 2 > l.y - l.size * 0.8 && (d.y0 + d.y1) / 2 < l.y + l.size * 0.1);
  const marker = l => {
    if (l.segs.length !== 1 || l.size > lead.body * 1.15) return null;
    const m = BULLET.exec(l.segs[0].text) || NUMBER.exec(l.segs[0].text);
    if (m) return m;
    const dot = dotFor(l);
    return dot ? { dot } : null;
  };

  let i = 0;
  while (i < lines.length){
    const l = lines[i];

    /* ---- table drawn with ruled lines ---- */
    const inGrid = (g, ln) => ln.y - ln.size * 0.3 > g.ys[0] && ln.y - ln.size * 0.3 < g.ys[g.ys.length - 1] &&
      ln.segs[0].x0 > g.xs[0] - 3 && ln.segs[ln.segs.length - 1].x1 < g.xs[g.xs.length - 1] + 3;
    const grid = pg.grids.find(g => inGrid(g, l));
    if (grid){
      const nc = grid.xs.length - 1, nr = grid.ys.length - 1;
      const cells = Array.from({ length: nr }, () => Array.from({ length: nc }, () => []));
      let j = i;
      while (j < lines.length && inGrid(grid, lines[j])){
        const ln = lines[j], mid = ln.y - ln.size * 0.3;
        let r = 0;
        while (r < nr - 1 && mid > grid.ys[r + 1]) r++;
        for (const g of ln.segs){
          const m = (g.x0 + g.x1) / 2;
          let c = 0;
          while (c < nc - 1 && m > grid.xs[c + 1]) c++;
          cells[r][c].push({ seg: g, size: ln.size, y: ln.y });
        }
        j++;
      }
      const rows = cells.filter(r => r.some(c => c.length)).map(r => r.map((cell, c) => {
        const L = grid.xs[c], R = grid.xs[c + 1];
        let align = "left";
        if (cell.length){
          const dl = Math.min(...cell.map(x => x.seg.x0)) - L, dr = R - Math.max(...cell.map(x => x.seg.x1));
          if (dr < 9 && dl > dr + 8) align = "right";
          else if (Math.abs(dl - dr) < 4 && dl > 9) align = "center";
        }
        const bgs = cell.flatMap(x => x.seg.spans.map(sp => sp.bg)).filter(Boolean);
        return { runs: runsOf(cell), align, shade: bgs.length ? bgs[0] : null };
      }));
      if (rows.length){
        blocks.push({
          type: "table", y0: l.y, y: lines[j - 1].y, size: l.size, borders: true, left: grid.xs[0] - FL,
          widths: grid.xs.slice(1).map((x, k) => x - grid.xs[k]), rows
        });
        i = j;
        continue;
      }
    }

    /* ---- table set out with space alone ---- */
    if (l.segs.length >= 2){
      let rows = [i], j = i + 1;
      const ink = k => lines[k].segs.map(g => [g.x0, g.x1]);
      const columnsFor = idx => {
        const spansX = idx.flatMap(ink).sort((a, b) => a[0] - b[0]);
        const cols = [];
        for (const [a, b] of spansX){
          const last = cols[cols.length - 1];
          if (last && a <= last[1] + 3) last[1] = Math.max(last[1], b); else cols.push([a, b]);
        }
        return cols;
      };
      while (j < lines.length){
        const n = lines[j], gap = gapOf(j);
        if (gap > Math.max(n.size, lines[j - 1].size) * 2.8) break;
        const trial = columnsFor([...rows, j]);
        if (trial.length < 2) break;
        if (n.segs.length === 1){
          // one piece: only a wrapped cell if it sits tight under the row and inside one column
          const cur = columnsFor(rows);
          const fits = cur.some(c => n.segs[0].x0 >= c[0] - 3 && n.segs[0].x1 <= c[1] + 3);
          if (!fits || gap > n.size * 1.45 || marker(n)) break;
        }
        rows.push(j);
        j++;
      }
      const starts = rows.filter(k => lines[k].segs.length >= 2);
      let cols = columnsFor(rows);
      // Left set headings over right set figures leave gaps inside one column.
      // Rows that have every cell show how many columns there are.
      const most = Math.max(...rows.map(k => lines[k].segs.length));
      const full = rows.filter(k => lines[k].segs.length === most);
      if (most >= 2 && cols.length > most && full.length >= 2){
        const byIndex = Array.from({ length: most }, (_, c) => [Math.min(...full.map(k => lines[k].segs[c].x0)), Math.max(...full.map(k => lines[k].segs[c].x1))]);
        if (byIndex.every((c, k) => !k || c[0] > byIndex[k - 1][1])) cols = byIndex;
      }
      const wideGap = l.segs.some((g, k) => k && g.x0 - l.segs[k - 1].x1 >= 28);
      if (cols.length >= 2 && (starts.length >= 2 || wideGap)){
        const colOf = g => {
          const m = (g.x0 + g.x1) / 2;
          let best = 0, d = Infinity;
          cols.forEach((c, k) => { const dk = m < c[0] ? c[0] - m : m > c[1] ? m - c[1] : 0; if (dk < d){ d = dk; best = k; } });
          return best;
        };
        const grid = [];
        for (const k of rows){
          const ln = lines[k];
          const firstCol = colOf(ln.segs[0]);
          const tight = k > rows[0] && gapOf(k) <= ln.size * 1.3;
          const cont = grid.length && (ln.segs.length === 1 || (tight && firstCol > 0 && ln.segs.length < cols.length));
          if (!cont) grid.push(cols.map(() => []));
          const row = grid[grid.length - 1];
          for (const g of ln.segs) row[colOf(g)].push({ seg: g, size: ln.size, y: ln.y });
        }
        const x0 = cols[0][0], x1 = cols[cols.length - 1][1];
        const y0 = lines[rows[0]].y - lines[rows[0]].size, y1 = lines[rows[rows.length - 1]].y + 4;
        const ruled = pg.rules.filter(r => r.x1 > x0 - 6 && r.x0 < x1 + 6 && r.y1 > y0 - 8 && r.y0 < y1 + 8).length;
        const lastCells = grid.map(r => r[cols.length - 1]).filter(c => c.length).map(c => c[0].seg);
        const flushRight = lastCells.length > 0 && lastCells.every(g => FR - g.x1 < 3) && cols[cols.length - 1][0] - FL > flowW * 0.4;
        const bounds = cols.map((c, k) => k === 0 ? x0 : (cols[k - 1][1] + c[0]) / 2);
        bounds.push(flushRight ? FR : x1);
        const align = cols.map((c, k) => {
          if (flushRight && k === cols.length - 1) return "right";
          const cells = grid.map(r => r[k]).filter(c2 => c2.length).map(c2 => c2[0].seg);
          if (cells.length < 2) return "left";
          if (cells.every(g => g.x0 - c[0] < 2.5)) return "left";
          if (cells.every(g => c[1] - g.x1 < 2.5)) return "right";
          if (cells.every(g => Math.abs((g.x0 - c[0]) - (c[1] - g.x1)) < 4)) return "center";
          return "left";
        });
        blocks.push({
          type: "table", y0: l.y, y: lines[rows[rows.length - 1]].y, size: l.size, borders: ruled >= 2,
          left: x0 - FL, widths: cols.map((c, k) => bounds[k + 1] - bounds[k] + (k === cols.length - 1 && !flushRight ? 6 : 0)),
          bottom: grid.length === 1,
          rows: grid.map(r => r.map((cell, k) => {
            const bgs = cell.flatMap(c => c.seg.spans.map(s => s.bg)).filter(Boolean);
            return { runs: runsOf(cell), align: align[k], shade: bgs.length ? bgs[0] : null };
          }))
        });
        i = j;
        continue;
      }
      // not a table after all: read the pieces as one line
      l.segs = [{ x0: l.segs[0].x0, x1: l.segs[l.segs.length - 1].x1,
        spans: l.segs.flatMap((g, k) => k ? [{ ...g.spans[0], str: "   " + g.spans[0].str }, ...g.spans.slice(1)] : g.spans),
        text: l.segs.map(g => g.text).join("   ") }];
    }

    /* ---- list item ---- */
    const mk = marker(l);
    if (mk){
      const seg = l.segs[0];
      // where the words start, after the bullet or number
      let acc = 0, textX = mk.dot ? seg.x0 : null;
      if (!mk.dot){
        for (const sp of seg.spans){
          if (acc >= mk[0].trim().length && sp.str.trim()){ textX = sp.x; break; }
          acc += sp.str.length;
        }
        if (textX === null) textX = seg.x0 + (seg.x1 - seg.x0) * mk[0].length / Math.max(1, seg.text.length);
      }
      const itemX = mk.dot ? mk.dot.x0 : seg.x0;
      const group = [{ seg, size: l.size, y: l.y }];
      let j = i + 1;
      while (j < lines.length){
        const n = lines[j];
        if (n.segs.length !== 1 || marker(n)) break;
        if (gapOf(j) > Math.max(lead.pt * (n.size / lead.body) * 1.35, n.size * 1.25)) break;
        if (n.segs[0].x0 < itemX + 3 || Math.abs(n.segs[0].x0 - textX) > 6) break;
        group.push({ seg: n.segs[0], size: n.size, y: n.y });
        j++;
      }
      blocks.push({
        type: "li", y0: l.y, y: lines[j - 1].y, x: itemX, ordered: !mk.dot && !!NUMBER.exec(seg.text),
        start: mk.dot ? null : mk[2] ? +mk[2] : (mk[3] || mk[4] ? (mk[3] || mk[4]).charCodeAt(0) - 96 : null),
        runs: runsOf(group, mk.dot ? null : NUMBER.exec(seg.text) ? NUMBER : BULLET), size: l.size, gap: gapOf(i), lines: group.length
      });
      i = j;
      continue;
    }

    /* ---- paragraph ---- */
    const group = [l];
    let j = i + 1;
    const bold0 = allBold(l);
    while (j < lines.length){
      const n = lines[j], p = lines[j - 1];
      if (n.segs.length !== 1 || marker(n)) break;
      const gap = gapOf(j);
      const normal = lead.pt * (Math.max(n.size, p.size) / lead.body);
      if (gap > Math.max(normal * 1.22 + 0.6, p.size * 1.05) || gap < p.size * 0.5) break;
      if (Math.abs(n.size - p.size) > Math.max(0.7, p.size * 0.08)) break;
      if (allBold(n) !== bold0) break;
      const a = p.segs[0], b = n.segs[0];
      const sameLeft = Math.abs(b.x0 - a.x0) <= 3;
      const sameMid = Math.abs((b.x0 + b.x1) - (a.x0 + a.x1)) / 2 <= 3;
      const sameRight = Math.abs(b.x1 - a.x1) <= 3;
      if (group.length >= 2 && !sameLeft && !sameMid && !sameRight) break;
      if (group.length === 1 && !sameMid && !sameRight && b.x0 - a.x0 > flowW * 0.5) break;
      // the line above stopped well short although more would have fit: it ended a paragraph
      const firstWord = (b.text.split(" ")[0] || "").length * n.size * 0.5;
      if (!sameMid && !sameRight && FR - a.x1 > Math.max(flowW * 0.3, firstWord + n.size * 2)) break;
      group.push(n);
      j++;
    }
    const xs0 = group.map(g => g.segs[0].x0), xs1 = group.map(g => g.segs[0].x1);
    const mids = group.map(g => (g.segs[0].x0 + g.segs[0].x1) / 2);
    const mid = (FL + FR) / 2;
    const leftFlush = xs0.every(x => Math.abs(x - xs0[xs0.length - 1]) <= 3) || (group.length > 1 && xs0.slice(1).every(x => Math.abs(x - xs0[1]) <= 3));
    let align = "left";
    const short = Math.max(...xs1) - Math.min(...xs0) < flowW * 0.92;
    if (mids.every(m => Math.abs(m - mid) <= 4) && (group.length > 1 ? !xs0.every(x => Math.abs(x - xs0[0]) <= 2) : (xs0[0] - FL > 12 && short))) align = "center";
    else if (xs1.every(x => FR - x <= 3) && (group.length > 1 ? !xs0.every(x => Math.abs(x - xs0[0]) <= 2) : xs0[0] - FL > flowW * 0.4)) align = "right";
    else if (group.length >= 3 && leftFlush && xs1.slice(0, -1).every(x => FR - x <= 3.5)) align = "justify";
    else if (group.length === 2 && leftFlush && FR - xs1[0] <= 2 && lead.justified) align = "justify";
    const body = group.length > 1 ? Math.min(...xs0.slice(1)) : xs0[0];
    const gaps = group.slice(1).map((g, k) => g.y - group[k].y);
    blocks.push({
      type: "p", y0: l.y, y: group[group.length - 1].y, align,
      left: align === "left" || align === "justify" ? Math.max(0, body - FL) : 0,
      first: (align === "left" || align === "justify") && group.length > 1 ? xs0[0] - body : 0,
      runs: runsOf(group.map(g => ({ seg: g.segs[0], size: g.size, y: g.y }))),
      size: Math.max(...group.map(g => g.size)), bold: bold0, lines: group.length, gap: gapOf(i),
      pitch: gaps.length ? median(gaps) : 0, text: group.map(g => g.segs[0].text).join(" ")
    });
    i = j;
  }
  for (const blk of blocks){ blk.cols = colSet; if (colSet){ blk.bandL = band.L; blk.bandR = band.R; } }
  return blocks;
}

/* ---- the whole document ------------------------------------------------- */

export async function pdfToHtml(doc, opts){
  opts = opts || {};
  const lib = await MODULES.pdfjs.load();
  const want = { styled: opts.styled !== false };
  const notify = typeof opts.notify === "function" ? opts.notify : null;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++){
    const pg = await readPage(lib, await doc.getPage(n), want);
    pg.lines = buildLines(pg);
    pages.push(pg);
    if (notify && doc.numPages > 8 && n % 10 === 0) notify(`      read ${n} of ${doc.numPages} pages`);
  }

  // running heads, feet and page numbers: found once, kept out of the body
  const running = { header: null, footer: null };
  if (pages.length > 1){
    const seen = new Map();
    const zone = (pg, l) => l.y < pg.H * 0.085 ? "header" : l.y > pg.H * 0.915 ? "footer" : null;
    const textOf = l => l.segs.map(g => g.text).join(" ");
    for (const pg of pages) for (const l of pg.lines){
      const z = zone(pg, l);
      if (!z) continue;
      const key = z + "|" + textOf(l).replace(/\d+/g, "#");
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const need = Math.max(2, Math.ceil(pages.length * 0.5));
    pages.forEach((pg, pi) => {
      pg.lines = pg.lines.filter(l => {
        const z = zone(pg, l);
        if (!z) return true;
        const text = textOf(l);
        const repeated = seen.get(z + "|" + text.replace(/\d+/g, "#")) >= need;
        const numbered = PAGE_NO.test(text) || (repeated && new RegExp(`(^|\\D)${pi + 1}(\\D|$)`).test(text) && /\d/.test(text));
        if (!repeated && !PAGE_NO.test(text)) return true;
        if (!running[z] || (numbered && !running[z].numbered)) running[z] = { line: l, pageNo: pi + 1, numbered, W: pg.W };
        return false;
      });
    });
  }

  // the size, font and line pitch most of the text uses
  const sizeCount = new Map(), fontCount = new Map(), pitches = [];
  for (const pg of pages){
    pg.lines.forEach((l, k) => {
      const n = l.segs.reduce((a, g) => a + g.text.length, 0);
      sizeCount.set(half(l.size), (sizeCount.get(half(l.size)) || 0) + n);
      for (const g of l.segs) for (const sp of g.spans) fontCount.set(sp.font, (fontCount.get(sp.font) || 0) + sp.str.length);
      const p = pg.lines[k - 1];
      if (p && p.segs.length === 1 && l.segs.length === 1 && Math.abs(p.size - l.size) < 0.6){
        const gap = l.y - p.y;
        if (gap > l.size * 0.8 && gap < l.size * 2.6) pitches.push(gap / l.size);
      }
    });
  }
  const most = m => { let best = null, n = -1; for (const [k, v] of m) if (v > n){ n = v; best = k; } return best; };
  const bodySize = most(sizeCount) || 11;
  const bodyFont = most(fontCount) || "Arial";
  pitches.sort((a, b) => a - b);
  // the tightest common pitch is the line spacing; larger ones are gaps between paragraphs
  const ratio = pitches.length ? pitches[Math.floor(pitches.length * 0.3)] : 1.2;

  // page box and margins
  const first = pages[0] || { W: 612, H: 792 };
  const textL = [], textR = [], textT = [], textB = [];
  for (const pg of pages){
    if (!pg.lines.length) continue;
    textL.push(Math.min(...pg.lines.map(l => l.segs[0].x0)));
    textR.push(pg.W - Math.max(...pg.lines.map(l => l.segs[l.segs.length - 1].x1)));
    textT.push(pg.lines[0].y - pg.lines[0].size);
    textB.push(pg.H - pg.lines[pg.lines.length - 1].y);
  }
  const clampM = (v, d) => Math.max(18, Math.min(144, Number.isFinite(v) ? v : d));
  const margin = {
    left: clampM(Math.min(...textL), 72), right: clampM(Math.min(...textR), 72),
    top: clampM(median(textT) - 2, 72),
    bottom: clampM(median(textB) - 24, 54)        // a little slack, so a page that fit in the PDF still fits in Word
  };
  const box = { L: margin.left, R: first.W - margin.right };

  // is the body text set flush on both sides?
  let prose = 0, flush = 0;
  for (const pg of pages) for (const l of pg.lines){
    if (l.segs.length !== 1 || l.segs[0].x1 - l.segs[0].x0 < (box.R - box.L) * 0.6) continue;
    prose++;
    if (box.R - l.segs[0].x1 < 2.5) flush++;
  }
  const lead = { body: bodySize, pt: ratio * bodySize, ratio, justified: prose > 12 && flush > prose * 0.55 };

  // blocks, page by page, with pictures placed where they sit in reading order
  const runsOn = (a, b) => a && b && a.type === "p" && b.type === "p" && Math.abs(a.size - b.size) < 0.6 &&
    /[a-z,\u2013-]$/.test(a.text) && /^[a-z(]/.test(b.text);
  const pageBlocks = pages.map(pg => {
    const blocks = [];
    for (const band of orderByColumns(pg.lines, pg)){
      const part = buildBlocks(band, pg, lead, box);
      const last = blocks[blocks.length - 1];
      // a paragraph that runs from the foot of one column to the head of the next is one paragraph
      if (band.col && last && last.cols && part.length && runsOn(last, part[0])){
        const first = part.shift();
        last.runs = [...last.runs, { ...first.runs[0], text: (last.text.endsWith("-") ? "" : " ") + first.runs[0].text }, ...first.runs.slice(1)];
        last.text += " " + first.text;
        last.lines += first.lines;
        last.pitch = last.pitch || first.pitch;
        last.y = first.y;
        last.wrapped = true;
      }
      blocks.push(...part);
    }
    for (const r of pg.hrs){
      if (blocks.some(x => x.type === "table" && r.y > x.y0 - x.size * 1.5 && r.y < x.y + x.size)) continue;
      // it goes above the run of blocks that all sit below it
      let k = blocks.length;
      while (k > 0 && blocks[k - 1].y0 > r.y) k--;
      const next = blocks[k], prior = blocks[k - 1];
      blocks.splice(k, 0, { type: "hr", y0: r.y, y: r.y, size: 0, cols: next && prior && next.cols && prior.cols ? next.cols : null });
    }
    for (const pic of pg.pictures){
      // a picture in a column goes among that column's blocks
      const midX = (pic.x0 + pic.x1) / 2;
      const inCol = blocks.filter(x => x.cols && x.bandL !== undefined && midX >= x.bandL - 4 && midX <= x.bandR + 4 && pic.x1 - pic.x0 < (x.bandR - x.bandL) * 1.15);
      const pool = inCol.length ? inCol : blocks;
      const after = pool.find(x => (x.type === "img" || x.type === "hr" ? x.y0 : x.y0 - x.size * 0.8) > pic.y0 + 2);
      const blk = { type: "img", y0: pic.y0, y: pic.y1, pic, W: pg.W, size: 0, cols: inCol.length ? inCol[0].cols : null,
        colL: inCol.length ? inCol[0].bandL : null, colR: inCol.length ? inCol[0].bandR : null };
      let k = after ? blocks.indexOf(after) : (inCol.length ? blocks.indexOf(inCol[inCol.length - 1]) + 1 : blocks.length);
      blocks.splice(k, 0, blk);
    }
    return blocks;
  });

  // heading levels from the sizes that stand above the body text
  const bigSizes = new Set();
  for (const blocks of pageBlocks) for (const b of blocks){
    if (b.type === "p" && b.lines <= 3 && b.size >= bodySize * 1.18 && b.text.length < 200) bigSizes.add(half(b.size));
  }
  const levels = [...bigSizes].sort((a, b) => b - a);
  const levelOf = b => {
    if (b.type !== "p" || b.lines > 3 || b.text.length >= 200) return 0;
    const k = levels.indexOf(half(b.size));
    if (k >= 0) return Math.min(4, k + 1);
    if (b.bold && b.lines <= 2 && b.text.length < 90 && !/[.,;:]$/.test(b.text) && b.gap > lead.pt * 1.4 && b.align !== "justify") return Math.min(5, levels.length + 1);
    return 0;
  };

  /* ---- write HTML ---- */
  const pt = v => r1(v) + "pt";
  const runHtml = (r, sized) => {
    const css = [];
    if (r.font && r.font !== bodyFont) css.push(`font-family:'${r.font}'`);
    if (r.size && (sized || r.size !== bodySize)) css.push(`font-size:${r.size}pt`);
    if (r.color) css.push(`color:#${r.color}`);
    if (r.bg) css.push(`background-color:#${r.bg}`);
    let h = escHtml(r.text);
    if (css.length) h = `<span style="${css.join(";")}">${h}</span>`;
    if (r.va) h = r.va === "super" ? `<sup>${h}</sup>` : `<sub>${h}</sub>`;
    if (r.b) h = `<b>${h}</b>`;
    if (r.i) h = `<i>${h}</i>`;
    if (r.u && !r.link) h = `<u>${h}</u>`;
    if (r.strike) h = `<s>${h}</s>`;
    if (r.link) h = `<a href="${escHtml(r.link)}">${h}</a>`;
    return h;
  };
  const inner = (runs, sized) => runs.map(r => runHtml(r, sized)).join("");
  // a fill behind every run of a block belongs to the block
  const sharedBg = runs => runs.length && runs[0].bg && runs.every(r => r.bg === runs[0].bg) ? runs[0].bg : null;
  const without = (runs, bg) => bg ? runs.map(r => r.bg === bg ? { ...r, bg: null } : r) : runs;
  const pitchOf = b => b.pitch || lead.ratio * (b.size || bodySize);

  const parts = [];
  let list = null;                           // { x, stack of open tags }
  const closeList = () => { if (list){ while (list.stack.length) parts.push(`</${list.stack.pop()}>`); list = null; } };
  let lastP = null;                          // the last paragraph written, for joining across pages
  let colsOpen = 1;

  pageBlocks.forEach((blocks, pi) => {
    let prev = null;
    blocks.forEach(b => {
      let breakCss = "";
      let before = 0;
      if (!prev){
        if (pi > 0){
          // a sentence that runs over the page end carries on in the same paragraph
          if (b.type === "p" && lastP && !levelOf(b) && Math.abs(lastP.size - b.size) < 0.6 && /[a-z,–-]$/.test(lastP.text) && /^[a-z(]/.test(b.text)){
            const at = parts.lastIndexOf(lastP.html);
            if (at >= 0){
              const joined = lastP.html.replace(/<\/p>$/, (lastP.text.endsWith("-") ? "" : " ") + inner(without(b.runs, sharedBg(b.runs))) + "</p>");
              parts[at] = joined;
              lastP = { html: joined, text: lastP.text + " " + b.text, size: lastP.size };
              prev = b;
              return;
            }
          }
          if (opts.pageBreaks !== false) breakCss = "page-break-before:always;";
          else before = lead.pt;
        }
      } else if (b.type === "img" || b.type === "hr") before = b.y0 - prev.y - (prev.type === "img" || prev.type === "hr" ? 0 : 3);
      else if (prev.type === "img" || prev.type === "hr") before = b.y0 - prev.y - b.size * 0.95;
      else before = b.y0 - prev.y - pitchOf(b);
      before = before > 1.5 ? r1(before) : 0;
      prev = b;

      // text set in columns stays in columns
      const want = b.cols ? b.cols.n : 1;
      if (want !== colsOpen){
        closeList();
        if (colsOpen > 1) parts.push("</div>");
        if (want > 1) parts.push(`<div data-cols="${want}" style="column-count:${want};column-gap:${pt(b.cols.gap)}">`);
        colsOpen = want;
      }
      if (b.type === "hr"){
        closeList();
        parts.push(`<hr style="${breakCss}margin-top:${pt(before)};margin-bottom:0">`);
        lastP = null;
        return;
      }

      if (b.type === "li"){
        const tag = b.ordered ? "ol" : "ul";
        if (!list || breakCss){ closeList(); list = { x: b.x, stack: [] }; }
        const level = Math.max(0, Math.min(4, Math.round((b.x - list.x) / 16)));
        while (list.stack.length > level + 1) parts.push(`</${list.stack.pop()}>`);
        if (list.stack.length === level + 1 && list.stack[level] !== tag) parts.push(`</${list.stack.pop()}>`);
        while (list.stack.length < level + 1){
          parts.push(`<${tag}${b.ordered && b.start > 1 ? ` start="${b.start}"` : ""}${breakCss ? ` style="${breakCss}"` : ""}>`);
          list.stack.push(tag);
          breakCss = "";
        }
        parts.push(`<li style="margin-top:${pt(before)};margin-bottom:0;line-height:${Math.max(1, Math.round(pitchOf(b) / b.size * 20) / 20)}">${inner(b.runs)}</li>`);
        lastP = null;
        return;
      }
      closeList();

      if (b.type === "img"){
        const w = b.pic.x1 - b.pic.x0, h = b.pic.y1 - b.pic.y0;
        const midX = (b.pic.x0 + b.pic.x1) / 2;
        const boxL = b.colL !== null ? b.colL : margin.left, boxR = b.colL !== null ? b.colR : b.W - margin.right;
        const al = Math.abs(midX - (boxL + boxR) / 2) < (boxR - boxL) * 0.08 ? "center" : b.pic.x0 - boxL > (boxR - boxL) * 0.5 ? "right" : "left";
        const ml = al === "left" && b.pic.x0 - boxL > 4 ? `margin-left:${pt(b.pic.x0 - boxL)};` : "";
        parts.push(`<p style="${breakCss}text-align:${al};${ml}margin-top:${pt(before)};margin-bottom:0"><img src="${b.pic.uri}" alt="" style="width:${pt(w)};height:${pt(h)}"></p>`);
        lastP = null;
        return;
      }

      if (b.type === "table"){
        // a table takes no space above itself in Word, so a thin empty paragraph holds the gap
        const room = pi > 0 && !before && breakCss ? 0 : before + pitchOf(b) - b.size * 1.2;
        if (room > 2 && !breakCss) parts.push(`<p data-spacer="${r1(room)}" style="margin:0;font-size:1pt;line-height:${pt(room)}"></p>`);
        const rows = b.rows.map(row => "<tr>" + row.map(c => {
          const css = [];
          if (c.align !== "left") css.push(`text-align:${c.align}`);
          if (c.shade) css.push(`background-color:#${c.shade}`);
          if (b.bottom) css.push("vertical-align:bottom");
          return `<td${css.length ? ` style="${css.join(";")}"` : ""}>${inner(without(c.runs, c.shade))}</td>`;
        }).join("") + "</tr>").join("\n");
        parts.push(`<table data-borders="${b.borders ? 1 : 0}" style="${breakCss}border-collapse:collapse;margin-left:${pt(Math.max(0, b.left))};width:${pt(b.widths.reduce((a, c) => a + c, 0))}">` +
          `<colgroup>${b.widths.map(w => `<col style="width:${pt(w)}">`).join("")}</colgroup>\n${rows}\n</table>`);
        lastP = null;
        return;
      }

      const level = levelOf(b);
      const tag = level ? "h" + level : "p";
      const bg = sharedBg(b.runs);
      const css = [breakCss];
      if (b.align !== "left") css.push(`text-align:${b.align};`);
      if (b.left > 2) css.push(`margin-left:${pt(b.left)};`);
      if (Math.abs(b.first) > 2) css.push(`text-indent:${pt(b.first)};`);
      css.push(`margin-top:${pt(before)};margin-bottom:0;`);
      css.push(`line-height:${Math.max(1, Math.round(pitchOf(b) / b.size * 20) / 20)};`);
      if (bg) css.push(`background-color:#${bg};`);
      const html = `<${tag} style="${css.join("")}">${inner(without(b.runs, bg), !!level)}</${tag}>`;
      parts.push(html);
      lastP = level ? null : { html, text: b.text, size: b.size };
    });
    closeList();
  });
  if (colsOpen > 1) parts.push("</div>");

  // running head and foot, with the page number as a live field
  const runningHtml = z => {
    const r = running[z];
    if (!r) return "";
    const l = r.line;
    const x0 = l.segs[0].x0, x1 = l.segs[l.segs.length - 1].x1;
    const al = l.segs.length > 1 ? "left" : Math.abs((x0 + x1) / 2 - r.W / 2) < r.W * 0.06 ? "center" : x0 > r.W * 0.5 ? "right" : "left";
    const runs = runsOf(l.segs.map((g, k) => ({ seg: k ? { ...g, spans: [{ ...g.spans[0], str: "  " + g.spans[0].str }, ...g.spans.slice(1)] } : g, size: l.size, y: l.y })));
    let done = false;
    const html = runs.map(run => {
      if (done || !r.numbered) return runHtml(run, true);
      const m = new RegExp(`(^|\\D)(${r.pageNo})(\\D|$)`).exec(run.text);
      if (!m) return runHtml(run, true);
      done = true;
      const i = m.index + m[1].length;
      const a = run.text.slice(0, i), c = run.text.slice(i + m[2].length);
      return (a ? runHtml({ ...run, text: a }, true) : "") +
        `<span data-field="page" style="font-size:${run.size}pt${run.font !== bodyFont ? `;font-family:'${run.font}'` : ""}${run.color ? `;color:#${run.color}` : ""}">${r.pageNo}</span>` +
        (c ? runHtml({ ...run, text: c }, true) : "");
    }).join("");
    return `<${z} data-running="${z}"><p style="text-align:${al};margin:0">${html}</p></${z}>\n`;
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(opts.docTitle || "Document")}</title>
<meta name="doc-page" content="${r1(first.W)},${r1(first.H)},${r1(margin.top)},${r1(margin.right)},${r1(margin.bottom)},${r1(margin.left)}">
<meta name="doc-font" content="${escHtml(bodyFont)}|${bodySize}">
<style>
body{font-family:'${bodyFont}',sans-serif;font-size:${bodySize}pt;color:#000;max-width:${r1(first.W - margin.left - margin.right)}pt;margin:${r1(margin.top)}pt auto;padding:0 16px}
h1,h2,h3,h4,h5{font-weight:normal;font-size:inherit}
p,h1,h2,h3,h4,h5,li{margin:0}
table[data-borders="1"] td{border:1px solid #bfbfbf;padding:2pt 5pt}
table[data-borders="0"] td{padding:0 3pt 0 0;vertical-align:top}
header[data-running],footer[data-running]{color:#555;margin:8pt 0}
</style>
</head>
<body>
${runningHtml("header")}${parts.join("\n")}
${runningHtml("footer")}</body>
</html>
`;
}
