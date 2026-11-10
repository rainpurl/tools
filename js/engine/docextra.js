// More document formats: mailbox files and XPS.

import { ZipReader } from "./containers.js";
import { htmlDoc } from "./rich.js";
import { escHtml, latin1, safeName } from "./util.js";

// A mailbox is messages end to end, each starting with a "From " line.
export function mboxSplit(u8){
  const text = latin1.decode(u8);
  const starts = [];
  const re = /(^|\n)From [^\n]*\d{4}[^\n]*\n/g;
  for (let m; (m = re.exec(text));) starts.push({ at: m.index + m[1].length, body: m.index + m[0].length });
  if (!starts.length) throw new Error("no messages were found in this mailbox");
  const pad = String(starts.length).length;
  return starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : text.length;
    const msg = text.slice(s.body, end).replace(/\n>From /g, "\nFrom ");
    const subject = (/^Subject:[ \t]*(.*)$/im.exec(msg.slice(0, 8000)) || [, ""])[1].trim();
    const bytes = new Uint8Array(msg.length);
    for (let k = 0; k < msg.length; k++) bytes[k] = msg.charCodeAt(k) & 255;
    return { name: `${String(i + 1).padStart(pad, "0")}${subject ? "-" + safeName(subject).slice(0, 60) : ""}.eml`, bytes };
  });
}

// XPS pages place runs of glyphs at fixed points, like a PDF. The text is put
// back into lines and paragraphs by position.
export async function xpsToHtml(blob, title){
  const z = new ZipReader(blob);
  await z.open();
  const pages = z.entries.filter(e => /\.fpage$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!pages.length) throw new Error("this XPS file has no pages in it");
  const out = [];
  for (const [pi, entry] of pages.entries()){
    const doc = new DOMParser().parseFromString(await z.text(entry), "application/xml");
    const runs = [];
    for (const g of doc.getElementsByTagName("Glyphs")){
      const text = (g.getAttribute("UnicodeString") || "").replace(/^\{\}/, "");
      if (!text) continue;
      const size = +g.getAttribute("FontRenderingEmSize") || 12;
      let x = +g.getAttribute("OriginX") || 0, y = +g.getAttribute("OriginY") || 0;
      const m = /matrix\(([^)]+)\)|^([-\d.,\s]+)$/.exec(g.getAttribute("RenderTransform") || "");
      if (m){
        const v = (m[1] || m[2]).split(/[\s,]+/).map(Number);
        if (v.length === 6){ const nx = v[0] * x + v[2] * y + v[4]; y = v[1] * x + v[3] * y + v[5]; x = nx; }
      }
      runs.push({ text, x, y, size, bold: /bold/i.test(g.getAttribute("StyleSimulations") || "") });
    }
    runs.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const r of runs){
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - r.y) < r.size * 0.4) last.runs.push(r);
      else lines.push({ y: r.y, size: r.size, runs: [r] });
    }
    if (pi) out.push("<hr>");
    let para = [], prev = null;
    const flush = () => { if (para.length){ out.push(`<p>${para.join(" ")}</p>`); para = []; } };
    for (const l of lines){
      l.runs.sort((a, b) => a.x - b.x);
      const text = l.runs.map(r => r.text).join(l.runs.length > 1 && !l.runs.some(r => /^\s|\s$/.test(r.text)) ? " " : "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (prev && l.y - prev.y > Math.max(l.size, prev.size) * 1.7) flush();
      para.push(escHtml(text));
      prev = l;
    }
    flush();
  }
  return htmlDoc(title || "Document", out.join("\n"));
}
