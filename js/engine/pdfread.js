// PDF reading through pdf.js.

import { MODULES } from "./modules.js";
import { htmlDoc } from "./rich.js";
import { escHtml } from "./util.js";

export async function loadPdfDoc(blob){
  const lib = await MODULES.pdfjs.load();
  const data = new Uint8Array(await blob.arrayBuffer());
  return lib.getDocument({ data, isEvalSupported: false }).promise;
}

export async function pdfToHtml(doc){
  const parts = [];
  for (let n = 1; n <= doc.numPages; n++){
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    let y = null, line = [];
    const lines = [];
    for (const it of tc.items){
      if (!it.str) continue;
      const ty = Math.round(it.transform[5]);
      if (y !== null && Math.abs(ty - y) > 2){ lines.push(line.join("")); line = []; }
      y = ty;
      line.push(it.str + (it.hasEOL ? "\n" : ""));
    }
    if (line.length) lines.push(line.join(""));
    const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    parts.push(`<h2>Page ${n}</h2>`);
    for (const para of text.split(/\n{2,}/)) if (para.trim()) parts.push("<p>" + escHtml(para.trim()).replace(/\n/g, "<br>") + "</p>");
  }
  return htmlDoc("PDF", parts.join("\n"));
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
