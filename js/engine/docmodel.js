// A plain model of a document: page, blocks, runs. HTML with inline styles is
// read into it once, and the Word and RTF writers both work from it.

import { b64ToBytes } from "./util.js";

const NAMED = {
  black:"000000", white:"ffffff", red:"ff0000", green:"008000", blue:"0000ff", yellow:"ffff00",
  gray:"808080", grey:"808080", silver:"c0c0c0", maroon:"800000", navy:"000080", purple:"800080",
  teal:"008080", olive:"808000", orange:"ffa500", cyan:"00ffff", magenta:"ff00ff", lime:"00ff00",
  darkyellow:"808000", darkblue:"00008b", darkred:"8b0000", darkgreen:"006400", darkcyan:"008b8b",
  darkmagenta:"8b008b", darkgray:"a9a9a9", lightgray:"d3d3d3"
};

// Any CSS colour to "rrggbb", or null when it is absent or see-through.
export function cssColor(v){
  if (!v) return null;
  v = String(v).trim().toLowerCase();
  if (!v || v === "transparent" || v === "inherit" || v === "auto" || v === "none") return null;
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return m[1].split("").map(c => c + c).join("");
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return m[1];
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m){
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map(n => Math.max(0, Math.min(255, Math.round(+n))).toString(16).padStart(2, "0")).join("");
  }
  return NAMED[v] || null;
}

// A CSS length in points. `em` is the font size it is relative to.
export function cssPt(v, em){
  if (v === undefined || v === null) return null;
  const m = /^\s*(-?[\d.]+)\s*(pt|px|in|cm|mm|em|rem|pc|%)?\s*$/.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]){
    case "pt": return n;
    case "in": return n * 72;
    case "cm": return n * 28.3465;
    case "mm": return n * 2.83465;
    case "pc": return n * 12;
    case "em": return n * (em || 11);
    case "rem": return n * 12;
    case "%": return em ? n / 100 * em : null;
    default: return n * 0.75;          // px, or a bare number
  }
}

export function parseStyle(el){
  const out = {};
  const raw = el.getAttribute && el.getAttribute("style");
  if (!raw) return out;
  for (const part of raw.split(";")){
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    if (k) out[k] = part.slice(i + 1).trim().replace(/\s*!important$/i, "");
  }
  return out;
}

const firstFont = v => {
  const f = String(v).split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  return /^(inherit|initial|sans-serif|serif|monospace|system-ui|-apple-system|blinkmacsystemfont)$/i.test(f) ? null : f || null;
};

// Width and height of a PNG, JPEG or GIF, read from its header.
export function imageSize(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8[0] === 0x89 && u8[1] === 0x50) return { w: dv.getUint32(16), h: dv.getUint32(20) };
  if (u8[0] === 0x47 && u8[1] === 0x49) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  if (u8[0] === 0xff && u8[1] === 0xd8){
    let p = 2;
    while (p + 9 < u8.length){
      if (u8[p] !== 0xff){ p++; continue; }
      const m = u8[p + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: dv.getUint16(p + 7), h: dv.getUint16(p + 5) };
      p += 2 + dv.getUint16(p + 2);
    }
  }
  return null;
}

const BLOCK = /^(P|H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE|DIV|HR|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|FIGURE|FIGCAPTION|DL|DT|DD|ADDRESS|NAV|FORM|DETAILS|SUMMARY|CENTER)$/;

export function htmlToModel(html){
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = doc.querySelector('meta[name="doc-page"]');
  const fontMeta = doc.querySelector('meta[name="doc-font"]');
  doc.querySelectorAll("script,style,noscript,template,title").forEach(n => n.remove());

  const model = { page: null, font: null, size: null, blocks: [], running: { header: null, footer: null } };
  if (meta){
    const v = (meta.getAttribute("content") || "").split(",").map(Number);
    if (v.length >= 6 && v.every(Number.isFinite)) model.page = { w: v[0], h: v[1], top: v[2], right: v[3], bottom: v[4], left: v[5] };
  }
  if (fontMeta){
    const [f, sz] = (fontMeta.getAttribute("content") || "").split("|");
    model.font = f || null;
    model.size = +sz || null;
  }
  const baseSize = model.size || 11;

  // Text formatting carried down the tree.
  const inherit = (fmt, el) => {
    const t = el.tagName;
    const css = parseStyle(el);
    const f = { ...fmt };
    if (t === "B" || t === "STRONG") f.b = true;
    if (t === "I" || t === "EM" || t === "CITE" || t === "VAR" || t === "DFN") f.i = true;
    if (t === "U" || t === "INS") f.u = true;
    if (t === "S" || t === "DEL" || t === "STRIKE") f.strike = true;
    if (t === "SUP") f.va = "super";
    if (t === "SUB") f.va = "sub";
    if (t === "CODE" || t === "SAMP" || t === "KBD" || t === "TT"){ f.font = "Consolas"; f.mono = true; }
    if (t === "MARK") f.bg = "ffff00";
    if (t === "A" && el.getAttribute("href")) f.link = el.getAttribute("href");
    if (t === "FONT"){
      if (el.getAttribute("color")) f.color = cssColor(el.getAttribute("color")) || f.color;
      if (el.getAttribute("face")) f.font = firstFont(el.getAttribute("face")) || f.font;
    }
    if (css["font-weight"]) f.b = /^(bold|bolder|[6-9]00)$/.test(css["font-weight"]);
    if (css["font-style"]) f.i = /italic|oblique/.test(css["font-style"]);
    const deco = css["text-decoration"] || css["text-decoration-line"];
    if (deco){
      if (/underline/.test(deco)) f.u = true;
      if (/line-through/.test(deco)) f.strike = true;
      if (/none/.test(deco)){ f.u = false; f.strike = false; }
    }
    if (css["font-family"]) f.font = firstFont(css["font-family"]) || f.font;
    if (css["font-size"]){
      const pt = cssPt(css["font-size"], f.size || baseSize);
      if (pt && pt > 0) f.size = Math.round(pt * 2) / 2;
    }
    if (css.color) f.color = cssColor(css.color) ?? f.color;
    const bg = css["background-color"] || (css.background && css.background.split(/\s+/)[0]);
    if (bg && !BLOCK.test(t) && t !== "TD" && t !== "TH" && t !== "TR" && t !== "BODY") f.bg = cssColor(bg) ?? f.bg;
    if (css["vertical-align"] === "super") f.va = "super";
    if (css["vertical-align"] === "sub") f.va = "sub";
    return f;
  };

  const sameFmt = (a, b) => a.b === b.b && a.i === b.i && a.u === b.u && a.strike === b.strike && a.va === b.va &&
    a.font === b.font && a.size === b.size && a.color === b.color && a.bg === b.bg && a.link === b.link;

  const pushText = (runs, text, fmt) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.text !== undefined && sameFmt(last, fmt)) last.text += text;
    else runs.push({ text, b: fmt.b, i: fmt.i, u: fmt.u, strike: fmt.strike, va: fmt.va, font: fmt.font,
      size: fmt.size, color: fmt.color, bg: fmt.bg, link: fmt.link });
  };

  const imageRun = (el, fmt) => {
    const src = el.getAttribute("src") || "";
    const m = /^data:(image\/(png|jpe?g|gif));base64,(.*)$/s.exec(src);
    if (!m) return { text: `[image: ${el.getAttribute("alt") || src.slice(0, 80)}]`, i: true, color: "808080" };
    let bytes;
    try { bytes = b64ToBytes(m[3].replace(/\s+/g, "")); } catch (e){ return null; }
    const css = parseStyle(el);
    const dim = imageSize(bytes) || { w: 300, h: 200 };
    let w = cssPt(css.width, baseSize) || cssPt(el.getAttribute("width"), baseSize);
    let h = cssPt(css.height, baseSize) || cssPt(el.getAttribute("height"), baseSize);
    if (w && !h) h = w * dim.h / dim.w;
    if (h && !w) w = h * dim.w / dim.h;
    if (!w){ w = dim.w * 0.75; h = dim.h * 0.75; }
    return { img: { bytes, mime: m[1] === "image/jpg" ? "image/jpeg" : m[1], w, h, alt: el.getAttribute("alt") || "" }, link: fmt.link };
  };

  // Collect the inline content of a node. Block children are skipped; the caller handles those.
  const inline = (node, fmt, runs, pre) => {
    for (const c of node.childNodes){
      if (c.nodeType === 3){
        let t = c.nodeValue.replace(/ /g, " ");
        if (!pre) t = t.replace(/[\t\r\n ]+/g, " ");
        if (pre){
          const lines = t.replace(/\r\n?/g, "\n").split("\n");
          lines.forEach((ln, k) => { if (k) runs.push({ br: true }); pushText(runs, ln.replace(/\t/g, "    "), fmt); });
        } else pushText(runs, t, fmt);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (t === "BR"){ runs.push({ br: true }); continue; }
      if (t === "IMG"){ const r = imageRun(c, fmt); if (r) runs.push(r); continue; }
      if (c.getAttribute("data-field") === "page"){
        const f = inherit(fmt, c);
        runs.push({ field: "page", b: f.b, i: f.i, font: f.font, size: f.size, color: f.color });
        continue;
      }
      if (BLOCK.test(t)) continue;
      inline(c, inherit(fmt, c), runs, pre);
    }
    return runs;
  };

  const trimRuns = runs => {
    while (runs.length && runs[0].text !== undefined && !runs[0].text.trim()) runs.shift();
    while (runs.length && runs[runs.length - 1].text !== undefined && !runs[runs.length - 1].text.trim()) runs.pop();
    if (runs.length && runs[0].text !== undefined) runs[0].text = runs[0].text.replace(/^\s+/, "");
    const last = runs[runs.length - 1];
    if (last && last.text !== undefined) last.text = last.text.replace(/\s+$/, "");
    return runs;
  };

  const paraProps = (el, ctx) => {
    const css = parseStyle(el);
    const em = ctx.fmt.size || baseSize;
    const p = {};
    const align = (css["text-align"] || el.getAttribute("align") || ctx.align || "").toLowerCase();
    if (align === "center" || align === "right" || align === "justify") p.align = align;
    const left = (cssPt(css["margin-left"], em) || 0) + (cssPt(css["padding-left"], em) || 0) + (ctx.indent || 0);
    if (left > 0.5) p.left = left;
    const right = cssPt(css["margin-right"], em);
    if (right > 0.5) p.right = right;
    const ti = cssPt(css["text-indent"], em);
    if (ti && Math.abs(ti) > 0.5) p.first = ti;
    const mt = cssPt(css["margin-top"], em), mb = cssPt(css["margin-bottom"], em);
    if (mt !== null) p.before = Math.max(0, mt);
    if (mb !== null) p.after = Math.max(0, mb);
    const lh = css["line-height"];
    if (lh){
      if (/^[\d.]+$/.test(lh)) p.line = parseFloat(lh);
      else if (/%$/.test(lh)) p.line = parseFloat(lh) / 100;
      else { const pt = cssPt(lh, em); if (pt) p.lineExact = pt; }
    }
    if (/always|page/.test(css["page-break-before"] || css["break-before"] || "")) p.breakBefore = true;
    if (/always|page/.test(css["page-break-after"] || css["break-after"] || "")) p.breakAfter = true;
    const bg = cssColor(css["background-color"]);
    if (bg) p.shade = bg;
    if (css["border-bottom"] && !/none|0/.test(css["border-bottom"])) p.rule = true;
    return p;
  };

  const addPara = (out, el, ctx, extra) => {
    const fmt = inherit(ctx.fmt, el);
    const runs = trimRuns(inline(el, fmt, [], ctx.pre));
    const props = paraProps(el, ctx);
    if (!runs.length && !props.breakBefore && !props.breakAfter) return null;
    const p = { type: "p", runs, ...props, ...(extra || {}) };
    out.push(p);
    return p;
  };

  const hasBlockKids = el => Array.from(el.children).some(c => BLOCK.test(c.tagName));

  const walk = (node, out, ctx) => {
    // loose text and inline nodes that sit between blocks become their own paragraph
    let loose = [];
    const flush = () => {
      const runs = trimRuns(loose);
      loose = [];
      if (runs.length) out.push({ type: "p", runs, ...(ctx.align ? { align: ctx.align } : {}), ...(ctx.indent ? { left: ctx.indent } : {}) });
    };
    for (const c of node.childNodes){
      if (c.nodeType === 3){
        const t = c.nodeValue.replace(/ /g, " ").replace(/[\t\r\n ]+/g, " ");
        if (t.trim() || loose.length) pushText(loose, t, ctx.fmt);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (!BLOCK.test(t)){
        if (t === "BR"){ if (loose.length) loose.push({ br: true }); continue; }
        if (t === "IMG"){ const r = imageRun(c, ctx.fmt); if (r) loose.push(r); continue; }
        if (t === "LI"){ flush(); listItem(c, out, ctx, false, 0); continue; }
        if (t === "TR" || t === "TD" || t === "TH" || t === "TBODY" || t === "THEAD" || t === "CAPTION") continue;
        inline({ childNodes: [c] }, ctx.fmt, loose, ctx.pre);
        continue;
      }
      flush();
      block(c, out, ctx);
    }
    flush();
  };

  const listItem = (li, out, ctx, ordered, level) => {
    const kids = Array.from(li.childNodes);
    const nested = kids.filter(k => k.nodeType === 1 && /^(UL|OL)$/.test(k.tagName));
    const holder = li.cloneNode(true);
    Array.from(holder.children).filter(k => /^(UL|OL)$/.test(k.tagName)).forEach(k => k.remove());
    const lctx = { ...ctx, indent: 0 };
    if (hasBlockKids(holder)){
      const inner = [];
      walk(holder, inner, lctx);
      let firstDone = false;
      for (const b of inner){
        if (b.type === "p" && !firstDone){ b.list = { ordered, level }; firstDone = true; }
        else if (b.type === "p") b.left = (b.left || 0) + 36 * (level + 1);
        out.push(b);
      }
    } else addPara(out, holder, lctx, { list: { ordered, level } });
    for (const n of nested) list(n, out, ctx, level + 1);
  };

  const list = (el, out, ctx, level) => {
    const ordered = el.tagName === "OL";
    let first = true;
    for (const li of el.children){
      if (li.tagName !== "LI"){ if (/^(UL|OL)$/.test(li.tagName)) list(li, out, ctx, level + 1); continue; }
      const before = out.length;
      listItem(li, out, ctx, ordered, level);
      const p = out[before];
      if (p && p.list && first){
        p.list.restart = true;
        const start = parseInt(el.getAttribute("start"), 10);
        if (ordered && start > 1) p.list.start = start;
        first = false;
      }
    }
  };

  const table = (el, out, ctx) => {
    const rows = Array.from(el.querySelectorAll("tr")).filter(tr => tr.closest("table") === el);
    if (!rows.length) return;
    const css = parseStyle(el);
    const t = { type: "table", rows: [], cols: [], borders: true };
    const b = el.getAttribute("data-borders");
    if (b === "0" || /^0|none/.test(css.border || "") || el.getAttribute("border") === "0") t.borders = false;
    t.width = cssPt(css.width, baseSize);
    if (css["margin-left"]) t.left = cssPt(css["margin-left"], baseSize) || 0;
    const colEls = Array.from(el.querySelectorAll("col")).filter(c => c.closest("table") === el);
    t.cols = colEls.map(c => cssPt(parseStyle(c).width, baseSize) || cssPt(c.getAttribute("width"), baseSize) || 0);
    for (const tr of rows){
      const row = [];
      for (const c of tr.children){
        if (!/^T[DH]$/.test(c.tagName)) continue;
        const ccss = parseStyle(c);
        const cellCtx = { fmt: inherit(c.tagName === "TH" ? { ...ctx.fmt, b: true } : ctx.fmt, c), align: (ccss["text-align"] || c.getAttribute("align") || (c.tagName === "TH" ? "center" : "")).toLowerCase() || undefined };
        const blocks = [];
        if (hasBlockKids(c)) walk(c, blocks, cellCtx);
        else {
          const runs = trimRuns(inline(c, cellCtx.fmt, [], false));
          blocks.push({ type: "p", runs, ...(cellCtx.align && cellCtx.align !== "left" ? { align: cellCtx.align } : {}) });
        }
        row.push({
          blocks: blocks.filter(x => x.type === "p"),
          span: Math.max(1, parseInt(c.getAttribute("colspan"), 10) || 1),
          shade: cssColor(ccss["background-color"] || ccss.background) || (c.tagName === "TH" && t.borders ? "f2f2f2" : null),
          width: cssPt(ccss.width, baseSize),
          valign: ccss["vertical-align"] || null
        });
      }
      if (row.length) t.rows.push(row);
    }
    if (t.rows.length) out.push(t);
  };

  const block = (el, out, ctx) => {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)){ addPara(out, el, ctx, { heading: +t[1] }); return; }
    if (el.hasAttribute("data-spacer")){ out.push({ type: "space", h: Math.max(1, +el.getAttribute("data-spacer") || 0) }); return; }
    if (t === "P" || t === "FIGCAPTION" || t === "DT" || t === "ADDRESS" || t === "SUMMARY"){
      if (hasBlockKids(el)){ walk(el, out, { ...ctx, fmt: inherit(ctx.fmt, el) }); return; }
      addPara(out, el, ctx);
      return;
    }
    if (t === "PRE"){
      const fmt = inherit({ ...ctx.fmt, font: "Consolas", mono: true, size: ctx.fmt.size || 9.5 }, el);
      const runs = inline(el, fmt, [], true);
      while (runs.length && runs[runs.length - 1].br) runs.pop();
      if (runs.length) out.push({ type: "p", runs, code: true, ...paraProps(el, ctx) });
      return;
    }
    if (t === "HR"){
      const css = parseStyle(el);
      const mt = cssPt(css["margin-top"], baseSize);
      out.push({ type: "hr", ...(mt !== null ? { before: Math.max(0, mt) } : {}), ...(/always|page/.test(css["page-break-before"] || "") ? { breakBefore: true } : {}) });
      return;
    }
    if (t === "UL" || t === "OL"){ list(el, out, ctx, 0); return; }
    if (t === "TABLE"){ table(el, out, ctx); return; }
    if (t === "BLOCKQUOTE" || t === "DD"){
      const sub = { ...ctx, fmt: inherit(t === "BLOCKQUOTE" ? { ...ctx.fmt, i: true } : ctx.fmt, el), indent: (ctx.indent || 0) + 36 };
      if (hasBlockKids(el)) walk(el, out, sub); else addPara(out, el, sub);
      return;
    }
    // generic containers
    const css = parseStyle(el);
    const before = out.length;
    const sub = { ...ctx, fmt: inherit(ctx.fmt, el) };
    const al = (css["text-align"] || (t === "CENTER" ? "center" : "") || el.getAttribute("align") || "").toLowerCase();
    if (al) sub.align = al;
    const ml = cssPt(css["margin-left"], baseSize);
    if (ml > 0.5) sub.indent = (ctx.indent || 0) + ml;
    const ncols = parseInt(css["column-count"], 10);
    if (ncols > 1 && !ctx.inCols){
      out.push({ type: "cols", n: Math.min(6, ncols), gap: cssPt(css["column-gap"], baseSize) || 18 });
      walk(el, out, { ...sub, inCols: true });
      out.push({ type: "cols", n: 1, gap: 0 });
      return;
    }
    const running = el.getAttribute("data-running");
    if (running){
      const inner = [];
      walk(el, inner, sub);
      model.running[running] = inner.filter(x => x.type === "p");
      return;
    }
    if (hasBlockKids(el)) walk(el, out, sub);
    else addPara(out, el, { ...ctx, align: sub.align || ctx.align, indent: ctx.indent });
    if (/always|page/.test(css["page-break-before"] || css["break-before"] || "")){
      const first = out[before];
      if (first && first.type === "p") first.breakBefore = true;
      else out.splice(before, 0, { type: "p", runs: [], breakBefore: true });
    }
  };

  const body = doc.body || doc.documentElement;
  const rootFmt = inherit({}, body);
  if (!model.font && rootFmt.font) model.font = rootFmt.font;
  if (!model.size && rootFmt.size) model.size = rootFmt.size;
  // the body's own font and size become the document default, not a property of every run
  walk(body, model.blocks, { fmt: { ...rootFmt, font: undefined, size: undefined } });
  return model;
}
