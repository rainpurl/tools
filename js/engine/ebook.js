// EPUB, MOBI, FB2, notebooks and web archives.

import { ZipReader, zipWrite } from "./containers.js";
import { parseEml } from "./mail.js";
import { htmlDoc, mdToHtml } from "./rich.js";
import { parseXml } from "./tree.js";
import { bytesToB64, concatBytes, enc, escHtml, utf8, xmlEsc } from "./util.js";

export async function epubToHtml(blob){
  const z = new ZipReader(blob);
  await z.open();
  const container = z.find("META-INF/container.xml");
  let opfPath = null;
  if (container){
    const cd = parseXml(await z.text(container), "container.xml");
    const rf = cd.getElementsByTagName("rootfile")[0];
    if (rf) opfPath = rf.getAttribute("full-path");
  }
  if (!opfPath){
    const guess = z.entries.find(e => /\.opf$/i.test(e.name));
    if (!guess) throw new Error("no OPF package file, not an epub");
    opfPath = guess.name;
  }
  const opfEntry = z.find(opfPath);
  if (!opfEntry) throw new Error("OPF file listed but missing: " + opfPath);
  const opf = parseXml(await z.text(opfEntry), "package document");
  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const title = (opf.getElementsByTagName("dc:title")[0] || opf.getElementsByTagName("title")[0] || {}).textContent || "Ebook";
  const manifest = new Map();
  for (const it of opf.getElementsByTagName("item")) manifest.set(it.getAttribute("id"), it.getAttribute("href"));
  let order = Array.from(opf.getElementsByTagName("itemref")).map(r => manifest.get(r.getAttribute("idref"))).filter(Boolean);
  if (!order.length){
    order = Array.from(opf.getElementsByTagName("item"))
      .filter(it => /xhtml|html/i.test(it.getAttribute("media-type") || ""))
      .map(it => it.getAttribute("href"));
  }

  const parts = [];
  for (const href of order){
    const clean = decodeURIComponent(href.split("#")[0]);
    const entry = z.find(baseDir + clean) || z.find(clean) ||
      z.entries.find(e => e.name.toLowerCase().endsWith(clean.toLowerCase()));
    if (!entry) continue;
    const d = new DOMParser().parseFromString(await z.text(entry), "text/html");
    d.querySelectorAll("script,style,head,link,meta").forEach(n => n.remove());
    if (d.querySelector("nav[epub\\:type=toc], nav#toc")) continue;
    const inner = (d.body ? d.body.innerHTML : "").trim();
    if (inner) parts.push(inner);
  }
  if (!parts.length) throw new Error("no readable chapters in this epub");
  return htmlDoc(title.trim(), parts.join("\n<hr>\n"));
}

export async function htmlToEpub(html, title){
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,head,noscript").forEach(n => n.remove());

  const chapters = [];
  let cur = { title: title || "Start", nodes: [] };
  for (const el of Array.from(doc.body.children)){
    if (/^H[12]$/.test(el.tagName) && cur.nodes.length){
      chapters.push(cur);
      cur = { title: el.textContent.trim() || "Chapter", nodes: [el] };
    } else {
      if (/^H[12]$/.test(el.tagName) && !cur.nodes.length) cur.title = el.textContent.trim() || cur.title;
      cur.nodes.push(el);
    }
  }
  if (cur.nodes.length) chapters.push(cur);
  if (!chapters.length) chapters.push({ title: title || "Start", nodes: [] });

  const css = `body{font-family:serif;line-height:1.5;margin:1em}
h1,h2,h3{line-height:1.25;font-family:sans-serif}
pre{white-space:pre-wrap;background:#f2f2f2;padding:.6em;font-size:.9em}
code{font-family:monospace}
blockquote{margin-left:1em;padding-left:.8em;border-left:3px solid #ccc;font-style:italic}
table{border-collapse:collapse}th,td{border:1px solid #bbb;padding:.3em .5em}
img{max-width:100%}`;

  const files = chapters.map((ch, i) => ({
    id: "ch" + (i + 1),
    href: `chapter-${String(i + 1).padStart(3, "0")}.xhtml`,
    title: ch.title,
    body: ch.nodes.map(n => n.outerHTML).join("\n")
  }));

  const xhtmlify = s => s
    .replace(/<(br|hr|img|meta|link|col|input)([^>]*?)\/>/gi, (m, t, a) => `<${t}${a.replace(/\/$/, "")}/>`)
    .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]{0,30};)/g, "&amp;")
    .replace(/&(nbsp|copy|mdash|ndash|hellip|rsquo|lsquo|ldquo|rdquo|trade|reg|deg|times|laquo|raquo|bull|dagger|permil|euro|pound|yen|sect|para|middot|frac12|frac14|frac34|plusmn|micro|not|shy|macr|cedil|sup1|sup2|sup3|ordm|ordf|iexcl|cent|curren|brvbar|uml|szlig);/g,
      (m, n) => ({ nbsp:"\u00a0", copy:"\u00a9", mdash:"\u2014", ndash:"\u2013", hellip:"\u2026",
        rsquo:"\u2019", lsquo:"\u2018", ldquo:"\u201c", rdquo:"\u201d", trade:"\u2122", reg:"\u00ae",
        deg:"\u00b0", times:"\u00d7", laquo:"\u00ab", raquo:"\u00bb", bull:"\u2022", dagger:"\u2020",
        permil:"\u2030", euro:"\u20ac", pound:"\u00a3", yen:"\u00a5", sect:"\u00a7", para:"\u00b6",
        middot:"\u00b7", frac12:"\u00bd", frac14:"\u00bc", frac34:"\u00be", plusmn:"\u00b1",
        micro:"\u00b5", not:"\u00ac", shy:"\u00ad", macr:"\u00af", cedil:"\u00b8", sup1:"\u00b9",
        sup2:"\u00b2", sup3:"\u00b3", ordm:"\u00ba", ordf:"\u00aa", iexcl:"\u00a1", cent:"\u00a2",
        curren:"\u00a4", brvbar:"\u00a6", uml:"\u00a8", szlig:"\u00df" }[n] || m));

  const page = f => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>${xmlEsc(f.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${xhtmlify(f.body)}
</body>
</html>`;

  const uid = "urn:uuid:" + [8,4,4,4,12].map(n => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")).join("-");
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uid}</dc:identifier>
<dc:title>${xmlEsc(title || "Document")}</dc:title>
<dc:language>en</dc:language>
<meta property="dcterms:modified">${now}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
${files.map(f => `<item id="${f.id}" href="${f.href}" media-type="application/xhtml+xml"/>`).join("\n")}
</manifest>
<spine toc="ncx">
${files.map(f => `<itemref idref="${f.id}"/>`).join("\n")}
</spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${files.map(f => `<li><a href="${f.href}">${xmlEsc(f.title)}</a></li>`).join("\n")}
</ol></nav></body>
</html>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${uid}"/></head>
<docTitle><text>${xmlEsc(title || "Document")}</text></docTitle>
<navMap>
${files.map((f, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${xmlEsc(f.title)}</text></navLabel><content src="${f.href}"/></navPoint>`).join("\n")}
</navMap>
</ncx>`;

  return zipWrite([
    { name: "mimetype", bytes: enc.encode("application/epub+zip") },
    { name: "META-INF/container.xml", bytes: enc.encode(`<?xml version="1.0" encoding="utf-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`) },
    { name: "OEBPS/content.opf", bytes: enc.encode(opf) },
    { name: "OEBPS/nav.xhtml", bytes: enc.encode(nav) },
    { name: "OEBPS/toc.ncx", bytes: enc.encode(ncx) },
    { name: "OEBPS/style.css", bytes: enc.encode(css) },
    ...files.map(f => ({ name: "OEBPS/" + f.href, bytes: enc.encode(page(f)) }))
  ]);
}

export function fb2ToHtml(text){
  const doc = parseXml(text, "fb2");
  const title = (doc.getElementsByTagName("book-title")[0] || {}).textContent || "Book";
  const out = [];
  const inline = node => {
    let s = "";
    for (const c of node.childNodes){
      if (c.nodeType === 3){ s += escHtml(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName.toLowerCase();
      if (t === "emphasis") s += "<em>" + inline(c) + "</em>";
      else if (t === "strong") s += "<strong>" + inline(c) + "</strong>";
      else if (t === "strikethrough") s += "<del>" + inline(c) + "</del>";
      else if (t === "code") s += "<code>" + inline(c) + "</code>";
      else if (t === "a") s += `<a href="${escHtml(c.getAttribute("l:href") || c.getAttribute("xlink:href") || "")}">${inline(c)}</a>`;
      else if (t === "empty-line") s += "<br>";
      else if (t === "image") s += "[image]";
      else s += inline(c);
    }
    return s;
  };
  const section = (el, depth) => {
    for (const c of el.children){
      const t = c.tagName.toLowerCase();
      if (t === "title"){
        const txt = Array.from(c.children).map(inline).join(" ").trim() || inline(c).trim();
        if (txt) out.push(`<h${Math.min(6, depth + 1)}>${txt}</h${Math.min(6, depth + 1)}>`);
      } else if (t === "section") section(c, depth + 1);
      else if (t === "p"){ const s = inline(c).trim(); if (s) out.push("<p>" + s + "</p>"); }
      else if (t === "subtitle"){ const s = inline(c).trim(); if (s) out.push(`<h${Math.min(6, depth + 2)}>${s}</h${Math.min(6, depth + 2)}>`); }
      else if (t === "epigraph" || t === "cite"){ const s = inline(c).trim(); if (s) out.push("<blockquote><p>" + s + "</p></blockquote>"); }
      else if (t === "poem"){
        const lines = Array.from(c.getElementsByTagName("v")).map(v => inline(v).trim()).filter(Boolean);
        if (lines.length) out.push("<p>" + lines.join("<br>") + "</p>");
      }
      else if (t === "empty-line") out.push("<p></p>");
    }
  };
  const bodies = Array.from(doc.getElementsByTagName("body"));
  if (!bodies.length) throw new Error("no body element, not an fb2 file");
  for (const b of bodies){
    if (b.getAttribute("name") === "notes") continue;
    section(b, 0);
  }
  return htmlDoc(title.trim(), out.join("\n"));
}

export function ipynbToHtml(text, name){
  const nb = JSON.parse(text);
  if (!Array.isArray(nb.cells)) throw new Error("no cells array, not a notebook");
  const src = c => Array.isArray(c.source) ? c.source.join("") : String(c.source || "");
  const lang = (((nb.metadata || {}).language_info || {}).name) || "python";
  const out = [];
  let n = 0;
  for (const c of nb.cells){
    if (c.cell_type === "markdown"){
      out.push(mdToHtml(src(c)));
      continue;
    }
    if (c.cell_type === "raw"){
      const s = src(c).trim();
      if (s) out.push("<pre><code>" + escHtml(s) + "</code></pre>");
      continue;
    }
    if (c.cell_type !== "code") continue;
    n++;
    const code = src(c).replace(/\n+$/, "");
    out.push(`<p><em>In [${c.execution_count ?? " "}]:</em></p>`);
    out.push(`<pre><code class="language-${lang}">${escHtml(code)}</code></pre>`);
    for (const o of c.outputs || []){
      const data = o.data || {};
      if (o.output_type === "stream"){
        const t = Array.isArray(o.text) ? o.text.join("") : String(o.text || "");
        if (t.trim()) out.push("<pre><code>" + escHtml(t.replace(/\n+$/, "")) + "</code></pre>");
      } else if (o.output_type === "error"){
        const tb = (o.traceback || []).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
        out.push("<pre><code>" + escHtml(tb || `${o.ename}: ${o.evalue}`) + "</code></pre>");
      } else if (data["image/png"]){
        const b64 = Array.isArray(data["image/png"]) ? data["image/png"].join("") : data["image/png"];
        out.push(`<p><img src="data:image/png;base64,${b64.replace(/\s+/g, "")}" alt="output image"/></p>`);
      } else if (data["text/html"]){
        out.push(Array.isArray(data["text/html"]) ? data["text/html"].join("") : data["text/html"]);
      } else if (data["text/markdown"]){
        out.push(mdToHtml(Array.isArray(data["text/markdown"]) ? data["text/markdown"].join("") : data["text/markdown"]));
      } else if (data["text/plain"]){
        const t = Array.isArray(data["text/plain"]) ? data["text/plain"].join("") : data["text/plain"];
        if (t.trim()) out.push("<pre><code>" + escHtml(t.replace(/\n+$/, "")) + "</code></pre>");
      }
    }
  }
  if (!out.length) throw new Error("notebook has no renderable cells");
  return htmlDoc(name || "Notebook", out.join("\n"));
}

export function mhtmlToHtml(text){
  const parsed = parseEml(text);
  let html = parsed.html;
  if (!html && parsed.plain) return htmlDoc("Web archive", "<pre>" + escHtml(parsed.plain) + "</pre>");
  if (!html) throw new Error("no html part found in this archive");
  const byLoc = new Map();
  for (const a of parsed.attachments){
    if (a.loc) byLoc.set(a.loc.toLowerCase(), a);
    if (a.cid) byLoc.set("cid:" + a.cid.toLowerCase(), a);
  }
  const d = new DOMParser().parseFromString(html, "text/html");
  d.querySelectorAll("script,noscript").forEach(n => n.remove());
  for (const img of d.querySelectorAll("img")){
    const src = (img.getAttribute("src") || "").trim();
    if (!src || /^data:/i.test(src)) continue;
    const hit = byLoc.get(src.toLowerCase()) || byLoc.get(("cid:" + src.replace(/^cid:/i, "")).toLowerCase());
    if (hit && hit.bytes.length < 4 * 1024 * 1024){
      img.setAttribute("src", `data:${hit.type || "image/png"};base64,${bytesToB64(hit.bytes)}`);
    }
  }
  const title = (d.querySelector("title") || {}).textContent || parsed.headers.get("subject") || "Web archive";
  d.querySelectorAll("head,title,meta,link").forEach(n => n.remove());
  return htmlDoc(title.trim(), d.body ? d.body.innerHTML : html);
}

export function palmDocUnpack(u8){
  const out = [];
  let p = 0;
  while (p < u8.length){
    const b = u8[p++];
    if (b === 0) out.push(0);
    else if (b <= 8){
      for (let i = 0; i < b && p < u8.length; i++) out.push(u8[p++]);
    }
    else if (b <= 0x7f) out.push(b);
    else if (b <= 0xbf){
      const b2 = u8[p++];
      const pair = (b << 8) | b2;
      const dist = (pair >> 3) & 0x7ff;
      const len = (pair & 7) + 3;
      if (dist === 0 || dist > out.length) continue;
      const start = out.length - dist;
      for (let i = 0; i < len; i++) out.push(out[start + i]);
    }
    else out.push(32, b ^ 0x80);
  }
  return Uint8Array.from(out);
}

export function mobiToHtml(u8, name){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o, n) => utf8.decode(u8.subarray(o, o + n)).replace(/\0+$/, "");
  if (u8.length < 78) throw new Error("file too short to be a mobi");
  const type = str(60, 4), creator = str(64, 4);
  if (!/^(BOOK|TEXt)$/.test(type) || !/^(MOBI|REAd)$/.test(creator))
    throw new Error(`not a mobi or palmdoc file, type ${type} creator ${creator}`);
  const nRecords = dv.getUint16(76);
  const offsets = [];
  for (let i = 0; i < nRecords; i++) offsets.push(dv.getUint32(78 + i * 8));
  if (!offsets.length) throw new Error("mobi has no records");
  const rec = i => u8.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : u8.length);

  const r0 = rec(0);
  const d0 = new DataView(r0.buffer, r0.byteOffset, r0.byteLength);
  const compression = d0.getUint16(0);
  const textLength = d0.getUint32(4);
  const textRecords = d0.getUint16(8);
  const encryption = d0.getUint16(12);
  if (encryption) throw new Error("this mobi is encrypted, so it cannot be read");
  if (compression === 17480) throw new Error("this mobi uses HUFF/CDIC compression, which is unsupported");
  if (compression !== 1 && compression !== 2) throw new Error("unknown mobi compression " + compression);

  let title = "", encoding = 1252, extra = 0;
  if (r0.length > 20 && str(offsets[0] + 16, 4) === "MOBI"){
    const hdrLen = d0.getUint32(20);
    encoding = d0.getUint32(28);
    if (hdrLen >= 92){
      const nameOff = d0.getUint32(84), nameLen = d0.getUint32(88);
      if (nameOff && nameLen && nameOff + nameLen <= r0.length) title = str(offsets[0] + nameOff, nameLen);
    }
    if (hdrLen >= 244){
      const flags = d0.getUint16(242);
      for (let b = 1; b < 0x200; b <<= 1) if (flags & b) extra++;
      if (flags & 1) extra--;
    }
  }
  const dec = encoding === 65001 ? utf8 : new TextDecoder("windows-1252");

  const parts = [];
  for (let i = 1; i <= textRecords && i < offsets.length; i++){
    let r = rec(i);
    for (let e = 0; e < extra && r.length > 1; e++){
      let n = 0;
      for (let k = 0; k < 4; k++){
        const byte = r[r.length - 1 - k];
        n = (n << 7) | (byte & 0x7f);
        if (byte & 0x80) break;
      }
      if (n <= 0 || n > r.length) break;
      r = r.subarray(0, r.length - n);
    }
    parts.push(compression === 2 ? palmDocUnpack(r) : r);
  }
  if (!parts.length) throw new Error("mobi has no text records");
  const raw = concatBytes(parts).subarray(0, textLength || undefined);
  let html = dec.decode(raw);

  html = html
    .replace(/<\/?mbp:[^>]*>/gi, "")
    .replace(/<\/?guide>|<reference[^>]*>/gi, "")
    .replace(/\sfilepos=["']?\d+["']?/gi, "")
    .replace(/<a(?![a-z])[^>]*>\s*<\/a>/gi, "");
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,head,noscript").forEach(n => n.remove());
  const body = doc.body ? doc.body.innerHTML.trim() : "";
  if (!body) throw new Error("mobi text decoded but contained no markup");
  return htmlDoc((title || name || "Ebook").trim(), body);
}
