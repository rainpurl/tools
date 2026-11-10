// PDF writing: images to pages, and HTML to laid out text.

import { b64ToBytes, concatBytes, deflateZlib, enc } from "./util.js";

export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008], a5: [419.53, 595.28] };

export class PdfBuilder {
  constructor(){ this.objs = [null]; }
  add(body){ this.objs.push(body); return this.objs.length - 1; }
  async build(){
    const parts = [enc.encode("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n")];
    const offsets = [0];
    let pos = parts[0].length;
    for (let i = 1; i < this.objs.length; i++){
      offsets[i] = pos;
      const o = this.objs[i];
      const head = enc.encode(`${i} 0 obj\n`);
      const tail = enc.encode("\nendobj\n");
      const chunks = Array.isArray(o) ? o : [enc.encode(o)];
      parts.push(head, ...chunks, tail);
      pos += head.length + chunks.reduce((s, c) => s + c.length, 0) + tail.length;
    }
    const xrefPos = pos;
    let xref = `xref\n0 ${this.objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < this.objs.length; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    xref += `trailer\n<< /Size ${this.objs.length} /Root ${this.rootRef} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    parts.push(enc.encode(xref));
    return concatBytes(parts);
  }
}

export async function pdfStream(dict, bytes, compress){
  let data = bytes, filter = "";
  if (compress !== false && bytes.length > 200){
    const z = await deflateZlib(bytes);
    if (z.length < bytes.length){ data = z; filter = " /Filter /FlateDecode"; }
  }
  return [enc.encode(`<< ${dict}${filter} /Length ${data.length} >>\nstream\n`), data, enc.encode("\nendstream")];
}

export async function imagesToPdf(canvases, opts){
  const pdf = new PdfBuilder();
  const pageIds = [], kids = [];
  const pagesId = pdf.add("placeholder");
  const [PW, PH] = PAGE_SIZES[opts.pageSize || "letter"];
  const margin = opts.margin ?? 0;

  for (const canvas of canvases){
    const w = canvas.width, h = canvas.height;
    const jpeg = opts.imageFormat === "jpeg";
    let imgObj;
    if (jpeg){
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: opts.quality ?? opts.imgQuality ?? 0.88 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      imgObj = pdf.add([enc.encode(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`), bytes, enc.encode("\nendstream")]);
    } else {
      const id = canvas.getContext("2d").getImageData(0, 0, w, h).data;
      const rgb = new Uint8Array(w * h * 3);
      let alpha = null;
      for (let i = 0, j = 0; i < id.length; i += 4, j += 3){
        const a = id[i + 3];
        if (a !== 255){
          if (!alpha) alpha = new Uint8Array(w * h).fill(255);
          alpha[j / 3] = a;
        }
        rgb[j] = id[i]; rgb[j + 1] = id[i + 1]; rgb[j + 2] = id[i + 2];
      }
      let smaskRef = "";
      if (alpha){
        const sm = pdf.add(await pdfStream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8`, alpha));
        smaskRef = ` /SMask ${sm} 0 R`;
      }
      imgObj = pdf.add(await pdfStream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8${smaskRef}`, rgb));
    }
    let pw = PW, ph = PH;
    if (opts.fitPage === "image"){ pw = w * 0.75; ph = h * 0.75; }
    const availW = pw - margin * 2, availH = ph - margin * 2;
    const scale = Math.min(availW / w, availH / h);
    const dw = w * scale, dh = h * scale;
    const x = (pw - dw) / 2, y = (ph - dh) / 2;
    const content = pdf.add(await pdfStream("", enc.encode(`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`)));
    const page = pdf.add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${content} 0 R >>`);
    pageIds.push(page);
    kids.push(`${page} 0 R`);
  }
  pdf.objs[pagesId] = `<< /Type /Pages /Count ${pageIds.length} /Kids [ ${kids.join(" ")} ] >>`;
  const catalog = pdf.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  pdf.rootRef = catalog;
  return pdf.build();
}

export const HELV_W = (() => {
  const w = new Array(256).fill(556);
  const set = (s, v) => { for (const c of s) w[c.charCodeAt(0)] = v; };
  set(" !\"#$%&'()*+,-./0123456789:;<=>?", 278);
  set("0123456789", 556);
  set("$#&", 556);
  set("\"", 355); set("'", 191); set("(", 333); set(")", 333); set("*", 389);
  set("+", 584); set(",", 278); set("-", 333); set(".", 278); set("/", 278);
  set(":", 278); set(";", 278); set("<", 584); set("=", 584); set(">", 584); set("?", 556);
  set("@", 1015);
  set("ABDEHKNOPQRSUVXY", 722); set("C", 722); set("F", 611); set("G", 778);
  set("I", 278); set("J", 500); set("L", 611); set("M", 833); set("T", 611);
  set("W", 944); set("Z", 611);
  set("abcdeghknopqsuvxyz", 556); set("f", 278); set("i", 222); set("j", 222);
  set("l", 222); set("m", 833); set("r", 333); set("t", 278); set("w", 722);
  set("[", 278); set("]", 278); set("\\", 278); set("^", 469); set("_", 556);
  set("`", 333); set("{", 334); set("}", 334); set("|", 260); set("~", 584);
  return w;
})();

export function helvWidth(s, size, bold){
  let t = 0;
  for (let i = 0; i < s.length; i++){
    const c = s.charCodeAt(i);
    t += (c < 256 ? HELV_W[c] : 556) * (bold ? 1.06 : 1);
  }
  return t * size / 1000;
}

export const WINANSI = {
  "\u20ac":0x80, "\u201a":0x82, "\u0192":0x83, "\u201e":0x84, "\u2026":0x85,
  "\u2020":0x86, "\u2021":0x87, "\u02c6":0x88, "\u2030":0x89, "\u0160":0x8a,
  "\u2039":0x8b, "\u0152":0x8c, "\u017d":0x8e, "\u2018":0x91, "\u2019":0x92,
  "\u201c":0x93, "\u201d":0x94, "\u2022":0x95, "\u2013":0x96, "\u2014":0x97,
  "\u02dc":0x98, "\u2122":0x99, "\u0161":0x9a, "\u203a":0x9b, "\u0153":0x9c,
  "\u017e":0x9e, "\u0178":0x9f, "\u00a0":0x20
};

export function pdfStr(s){
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7e]/g, c => {
      const w = WINANSI[c];
      if (w !== undefined) return w === 0x20 ? " " : "\\" + w.toString(8).padStart(3, "0");
      const code = c.charCodeAt(0);
      return code < 256 ? "\\" + code.toString(8).padStart(3, "0") : "?";
    });
}

export function parseCssColor(str){
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s === "transparent" || s === "inherit" || s === "initial") return null;
  if (s.startsWith("#")){
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex[0]+hex[0] + hex[1]+hex[1] + hex[2]+hex[2];
    if (hex.length >= 6){
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
    }
  }
  const m = s.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m){
    return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  }
  // Named color fallbacks
  const named = { black:[0,0,0], white:[1,1,1], red:[0.9,0.1,0.1], blue:[0.1,0.3,0.85],
    gray:[0.5,0.5,0.5], grey:[0.5,0.5,0.5], darkgray:[0.25,0.25,0.25] };
  return named[s] || null;
}

export function parseStyleAttr(el){
  const st = {};
  const raw = el.getAttribute ? (el.getAttribute("style") || "") : "";
  if (!raw) return st;
  for (const part of raw.split(";")){
    const colon = part.indexOf(":");
    if (colon > 0){
      const k = part.slice(0, colon).trim().toLowerCase();
      const v = part.slice(colon + 1).trim();
      st[k] = v;
    }
  }
  return st;
}

export async function htmlToPdf(html, opts){
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,head,noscript").forEach(n => n.remove());
  const [PW, PH] = PAGE_SIZES[opts.pageSize || "letter"];
  const M = 48;
  const maxW = PW - M * 2;

  const pdf = new PdfBuilder();
  const pagesId = pdf.add("placeholder");
  const fonts = {
    F1: pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    F2: pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
    F3: pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>"),
    F4: pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>"),
    F5: pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"),
    F6: pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>")
  };

  const imagesMap = new Map();
  let imgCounter = 0;

  // Pre-load images
  const imgEls = Array.from(doc.querySelectorAll("img"));
  for (const img of imgEls){
    const src = img.getAttribute("src") || "";
    if (src.startsWith("data:") && !imagesMap.has(src)){
      const comma = src.indexOf(",");
      if (comma > 0){
        const meta = src.slice(0, comma);
        const b64 = src.slice(comma + 1);
        try {
          const raw = b64ToBytes(b64);
          let w = 0, h = 0;
          let isJpeg = /image\/jpe?g/i.test(meta);

          if (isJpeg){
            // Extract JPEG dimensions from SOF marker
            for (let i = 0; i < raw.length - 8; i++){
              if (raw[i] === 0xff && (raw[i+1] >= 0xc0 && raw[i+1] <= 0xc3)){
                h = (raw[i+5] << 8) | raw[i+6];
                w = (raw[i+7] << 8) | raw[i+8];
                break;
              }
            }
          } else if (raw.length > 24 && raw[0] === 0x89 && raw[1] === 0x50){ // PNG
            const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
            w = dv.getUint32(16);
            h = dv.getUint32(20);
          }

          if (w > 0 && h > 0){
            let imgObj;
            if (isJpeg){
              imgObj = pdf.add([enc.encode(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${raw.length} >>\nstream\n`), raw, enc.encode("\nendstream")]);
            } else {
              // Convert PNG/other to decoded RGB/Alpha
              const blob = new Blob([raw]);
              let bmp = null;
              try { bmp = await createImageBitmap(blob); } catch(e){}
              if (bmp){
                const c = new OffscreenCanvas(w, h);
                const ctx = c.getContext("2d");
                ctx.drawImage(bmp, 0, 0);
                const id = ctx.getImageData(0, 0, w, h).data;
                const rgb = new Uint8Array(w * h * 3);
                let alpha = null;
                for (let i = 0, j = 0; i < id.length; i += 4, j += 3){
                  const a = id[i + 3];
                  if (a !== 255){
                    if (!alpha) alpha = new Uint8Array(w * h).fill(255);
                    alpha[j / 3] = a;
                  }
                  rgb[j] = id[i]; rgb[j + 1] = id[i + 1]; rgb[j + 2] = id[i + 2];
                }
                let smaskRef = "";
                if (alpha){
                  const sm = pdf.add(await pdfStream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8`, alpha));
                  smaskRef = ` /SMask ${sm} 0 R`;
                }
                imgObj = pdf.add(await pdfStream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8${smaskRef}`, rgb));
              }
            }
            if (imgObj){
              const name = "Im" + (++imgCounter);
              imagesMap.set(src, { obj: imgObj, name, width: w, height: h });
            }
          }
        } catch (e){ /* skip malformed image */ }
      }
    }
  }

  // Layout blocks
  const pages = [];
  let curOps = [];
  let curXObjects = new Map();
  let y = PH - M;

  const newPage = () => {
    pages.push({ ops: curOps, xobjects: curXObjects });
    curOps = [];
    curXObjects = new Map();
    y = PH - M;
  };

  const ensureSpace = needed => {
    if (y - needed < M){
      newPage();
    }
  };

  const drawText = (str, x, yPos, size, fontName, color) => {
    if (!str) return;
    let colCmd = "";
    if (color && (color[0] !== 0 || color[1] !== 0 || color[2] !== 0)){
      colCmd = `${color[0].toFixed(3)} ${color[1].toFixed(3)} ${color[2].toFixed(3)} rg `;
    } else {
      colCmd = "0 0 0 rg ";
    }
    curOps.push(`BT ${colCmd}/${fontName} ${size} Tf ${x.toFixed(2)} ${yPos.toFixed(2)} Td (${pdfStr(str)}) Tj ET`);
  };

  // Render paragraphs and runs
  const renderParagraph = (node, depth, optsPara = {}) => {
    const elStyle = parseStyleAttr(node);
    let align = optsPara.align || elStyle["text-align"] || "left";
    let indent = (depth * 14) + (optsPara.indent || 0);
    if (elStyle["margin-left"]){
      const pt = parseFloat(elStyle["margin-left"]);
      if (pt > 0) indent += pt;
    }

    let defaultSize = optsPara.size || 10.5;
    if (elStyle["font-size"]){
      const pt = parseFloat(elStyle["font-size"]);
      if (pt > 0) defaultSize = pt;
    }

    const defaultColor = parseCssColor(elStyle["color"]) || optsPara.color || [0, 0, 0];
    const defaultBold = optsPara.bold || elStyle["font-weight"] === "bold";
    const defaultItalic = optsPara.italic || elStyle["font-style"] === "italic";
    const isMono = optsPara.mono || /courier|consolas|mono/i.test(elStyle["font-family"] || "");

    // Flatten children into inline fragments
    const fragments = [];
    const collectRuns = (parent, parentState) => {
      for (const child of parent.childNodes){
        if (child.nodeType === 3){
          const t = child.nodeValue.replace(/\s+/g, " ");
          if (t && t !== " "){
            fragments.push({ text: t, ...parentState });
          } else if (t === " "){
            fragments.push({ text: " ", ...parentState });
          }
        } else if (child.nodeType === 1){
          const tName = child.tagName.toUpperCase();
          if (tName === "BR"){
            fragments.push({ br: true });
            continue;
          }
          if (tName === "IMG"){
            const src = child.getAttribute("src") || "";
            if (imagesMap.has(src)){
              fragments.push({ img: imagesMap.get(src) });
            }
            continue;
          }
          const cStyle = parseStyleAttr(child);
          const cBold = parentState.bold || tName === "B" || tName === "STRONG" || cStyle["font-weight"] === "bold";
          const cItalic = parentState.italic || tName === "I" || tName === "EM" || cStyle["font-style"] === "italic";
          const cColor = parseCssColor(cStyle["color"]) || parentState.color;
          let cSize = parentState.size;
          if (cStyle["font-size"]){
            const pt = parseFloat(cStyle["font-size"]);
            if (pt > 0) cSize = pt;
          }
          collectRuns(child, {
            bold: cBold,
            italic: cItalic,
            color: cColor,
            size: cSize,
            mono: parentState.mono || tName === "CODE" || /courier|consolas|mono/i.test(cStyle["font-family"] || "")
          });
        }
      }
    };

    collectRuns(node, { bold: defaultBold, italic: defaultItalic, color: defaultColor, size: defaultSize, mono: isMono });

    if (!fragments.length) return;

    // Check for standalone block images
    if (fragments.length === 1 && fragments[0].img){
      const im = fragments[0].img;
      const aspect = im.height / im.width;
      const fitW = Math.min(maxW - indent, im.width * 0.75);
      const fitH = fitW * aspect;
      ensureSpace(fitH + 12);
      curXObjects.set(im.name, im.obj);
      let imgX = M + indent;
      if (align === "center") imgX = M + (maxW - fitW) / 2;
      else if (align === "right") imgX = M + maxW - fitW;
      curOps.push(`q ${fitW.toFixed(2)} 0 0 ${fitH.toFixed(2)} ${imgX.toFixed(2)} ${(y - fitH).toFixed(2)} cm /${im.name} Do Q`);
      y -= (fitH + 12);
      return;
    }

    // Word wrap fragments into lines
    const availW = maxW - indent;
    const lines = [];
    let curLine = [];
    let curLineWidth = 0;

    const measureFrag = frag => {
      if (frag.mono) return frag.text.length * frag.size * 0.6;
      return helvWidth(frag.text, frag.size, frag.bold);
    };

    for (const frag of fragments){
      if (frag.br){
        lines.push({ items: curLine, width: curLineWidth });
        curLine = [];
        curLineWidth = 0;
        continue;
      }
      if (frag.img){
        lines.push({ items: curLine, width: curLineWidth });
        curLine = [];
        curLineWidth = 0;
        continue;
      }

      const words = frag.text.split(" ");
      for (let wIdx = 0; wIdx < words.length; wIdx++){
        const wStr = words[wIdx];
        if (wStr === "" && wIdx > 0 && wIdx < words.length - 1) continue;
        const wordText = (wIdx > 0 ? " " : "") + wStr;
        const wWidth = measureFrag({ ...frag, text: wordText });

        if (curLineWidth + wWidth > availW && curLine.length > 0){
          lines.push({ items: curLine, width: curLineWidth });
          curLine = [];
          curLineWidth = 0;
          const trimmed = wordText.trimStart();
          const trWidth = measureFrag({ ...frag, text: trimmed });
          curLine.push({ ...frag, text: trimmed, width: trWidth });
          curLineWidth = trWidth;
        } else {
          curLine.push({ ...frag, text: wordText, width: wWidth });
          curLineWidth += wWidth;
        }
      }
    }
    if (curLine.length > 0){
      lines.push({ items: curLine, width: curLineWidth });
    }

    // Render lines to page
    const lead = defaultSize * 1.38;
    for (const line of lines){
      ensureSpace(lead + 2);
      let lineX = M + indent;
      if (align === "center"){
        lineX = M + indent + Math.max(0, (availW - line.width) / 2);
      } else if (align === "right"){
        lineX = M + indent + Math.max(0, availW - line.width);
      }

      if (optsPara.marker && line === lines[0]){
        drawText(optsPara.marker, M + indent - 12, y - defaultSize, defaultSize, "F1", defaultColor);
      }
      let curX = lineX;
      for (const item of line.items){
        const fontName = item.mono ? (item.bold ? "F6" : "F5") : item.bold && item.italic ? "F4" : item.bold ? "F2" : item.italic ? "F3" : "F1";
        drawText(item.text, curX, y - item.size, item.size, fontName, item.color);
        curX += item.width;
      }
      y -= lead;
    }
    y -= (optsPara.spaceAfter || 4);
  };

  // Render styled tables
  const renderTable = (tblNode) => {
    const trs = Array.from(tblNode.querySelectorAll("tr")).filter(tr => tr.closest("table") === tblNode);
    if (!trs.length) return;

    // Determine columns
    const cols = Math.max(...trs.map(r => Array.from(r.children).filter(c => /^T[DH]$/.test(c.tagName)).length));
    if (!cols) return;
    const colWidth = maxW / cols;

    y -= 6;
    for (const tr of trs){
      const cells = Array.from(tr.children).filter(c => /^T[DH]$/.test(c.tagName));
      let maxCellHeight = 22;

      // Pre-measure cell lines
      const cellData = cells.map(td => {
        const isTh = td.tagName === "TH";
        const cStyle = parseStyleAttr(td);
        const bg = parseCssColor(cStyle["background-color"]);
        const txt = td.textContent.replace(/\s+/g, " ").trim();
        const fontSize = isTh ? 9.5 : 9.0;
        const fontName = isTh ? "F2" : "F1";

        // Word wrap cell text
        const words = txt.split(" ");
        const lines = [];
        let cur = "";
        for (const w of words){
          const test = cur ? cur + " " + w : w;
          const wWidth = helvWidth(test, fontSize, isTh);
          if (cur && wWidth > colWidth - 10){
            lines.push(cur);
            cur = w;
          } else {
            cur = test;
          }
        }
        if (cur) lines.push(cur);

        const h = Math.max(20, lines.length * (fontSize * 1.35) + 8);
        if (h > maxCellHeight) maxCellHeight = h;

        return { lines, bg, fontSize, fontName, isTh };
      });

      ensureSpace(maxCellHeight + 4);

      // Draw cell backgrounds and borders
      for (let cIdx = 0; cIdx < cols; cIdx++){
        const cellX = M + cIdx * colWidth;
        const cd = cellData[cIdx];
        if (cd && cd.bg){
          curOps.push(`${cd.bg[0].toFixed(3)} ${cd.bg[1].toFixed(3)} ${cd.bg[2].toFixed(3)} rg ${cellX.toFixed(2)} ${(y - maxCellHeight).toFixed(2)} ${colWidth.toFixed(2)} ${maxCellHeight.toFixed(2)} re f`);
        }
        // Border
        curOps.push(`0.5 w 0.82 0.82 0.82 RG ${cellX.toFixed(2)} ${(y - maxCellHeight).toFixed(2)} ${colWidth.toFixed(2)} ${maxCellHeight.toFixed(2)} re S`);

        // Text inside cell
        if (cd && cd.lines.length){
          let textY = y - 5 - cd.fontSize;
          for (const line of cd.lines){
            drawText(line, cellX + 5, textY, cd.fontSize, cd.fontName, [0.1, 0.1, 0.1]);
            textY -= (cd.fontSize * 1.35);
          }
        }
      }
      y -= maxCellHeight;
    }
    y -= 8;
  };

  // Walk through top-level document elements
  const walkNodes = (parent, depth) => {
    for (const child of parent.children){
      const t = child.tagName.toUpperCase();

      if (/^H[1-6]$/.test(t)){
        const lvl = +t[1];
        const sizes = [22, 17, 14, 12, 11, 10];
        ensureSpace(sizes[lvl - 1] + 10);
        renderParagraph(child, depth, {
          size: sizes[lvl - 1],
          bold: true,
          spaceAfter: lvl <= 2 ? 8 : 4
        });
        continue;
      }

      if (t === "P"){
        renderParagraph(child, depth, { spaceAfter: 5 });
        continue;
      }

      if (t === "PRE"){
        const lines = child.textContent.replace(/\n+$/, "").split("\n");
        const preH = Math.min(300, lines.length * 12 + 10);
        ensureSpace(24);
        curOps.push(`0.96 0.96 0.96 rg ${M} ${(y - preH).toFixed(2)} ${maxW} ${preH.toFixed(2)} re f`);
        for (const ln of lines){
          ensureSpace(12);
          drawText(ln || " ", M + 8, y - 9, 8.5, "F5", [0.15, 0.15, 0.15]);
          y -= 12;
        }
        y -= 6;
        continue;
      }

      if (t === "BLOCKQUOTE"){
        ensureSpace(24);
        const startY = y;
        renderParagraph(child, depth, { indent: 16, italic: true, color: [0.35, 0.35, 0.35] });
        const endY = y;
        const barH = Math.max(12, startY - endY);
        curOps.push(`2.0 w 0.75 0.75 0.75 RG ${(M + 4).toFixed(2)} ${endY.toFixed(2)} m ${(M + 4).toFixed(2)} ${startY.toFixed(2)} l S`);
        continue;
      }

      if (t === "HR"){
        ensureSpace(14);
        curOps.push(`0.5 w 0.85 0.85 0.85 RG ${M} ${y.toFixed(2)} m ${(M + maxW)} ${y.toFixed(2)} l S`);
        y -= 12;
        continue;
      }

      if (t === "UL" || t === "OL"){
        let itemIndex = 1;
        for (const li of child.children){
          if (li.tagName.toUpperCase() !== "LI") continue;
          const mark = t === "OL" ? (itemIndex++) + "." : "\u2022";
          renderParagraph(li, depth, {
            indent: 14,
            spaceAfter: 3,
            marker: mark
          });
        }
        y -= 4;
        continue;
      }

      if (t === "TABLE"){
        renderTable(child);
        continue;
      }

      if (t === "IMG"){
        const src = child.getAttribute("src") || "";
        if (imagesMap.has(src)){
          const im = imagesMap.get(src);
          const aspect = im.height / im.width;
          const fitW = Math.min(maxW, im.width * 0.75);
          const fitH = fitW * aspect;
          ensureSpace(fitH + 12);
          curXObjects.set(im.name, im.obj);
          curOps.push(`q ${fitW.toFixed(2)} 0 0 ${fitH.toFixed(2)} ${M.toFixed(2)} ${(y - fitH).toFixed(2)} cm /${im.name} Do Q`);
          y -= (fitH + 12);
        }
        continue;
      }

      if (["DIV","SECTION","ARTICLE","MAIN","BODY","HEADER","FOOTER","ASIDE"].includes(t)){
        walkNodes(child, depth);
        continue;
      }

      renderParagraph(child, depth, { spaceAfter: 4 });
    }
  };

  walkNodes(doc.body, 0);

  if (curOps.length > 0 || !pages.length){
    pages.push({ ops: curOps, xobjects: curXObjects });
  }

  // Construct PDF Pages
  const kids = [];
  for (const p of pages){
    const content = pdf.add(await pdfStream("", enc.encode(p.ops.join("\n"))));
    const fontRes = Object.entries(fonts).map(([k, v]) => `/${k} ${v} 0 R`).join(" ");
    let xobjRes = "";
    if (p.xobjects.size > 0){
      xobjRes = " /XObject << " + Array.from(p.xobjects.entries()).map(([k, v]) => `/${k} ${v} 0 R`).join(" ") + " >>";
    }
    const pageObj = pdf.add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << ${fontRes} >>${xobjRes} >> /Contents ${content} 0 R >>`);
    kids.push(`${pageObj} 0 R`);
  }

  pdf.objs[pagesId] = `<< /Type /Pages /Count ${kids.length} /Kids [ ${kids.join(" ")} ] >>`;
  const catalog = pdf.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  pdf.rootRef = catalog;
  return pdf.build();
}
