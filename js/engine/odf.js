// OpenDocument text, sheets and slides.

import { ZipReader, zipWrite } from "./containers.js";
import { htmlDoc } from "./rich.js";
import { rowsToSheet } from "./table.js";
import { parseXml } from "./tree.js";
import { enc, escHtml, xmlEsc } from "./util.js";

export async function odfOpen(blob){
  const z = new ZipReader(blob);
  await z.open();
  const c = z.find("content.xml");
  if (!c) throw new Error("no content.xml, not an OpenDocument file");
  return { zip: z, doc: parseXml(await z.text(c), "content.xml") };
}

export function odfTextStyles(doc){
  const map = new Map();
  for (const s of doc.getElementsByTagName("style:style")){
    const name = s.getAttribute("style:name");
    const tp = s.getElementsByTagName("style:text-properties")[0];
    if (!name || !tp) continue;
    const get = a => tp.getAttribute(a) || "";
    map.set(name, {
      b: /^(bold|[6-9]00)$/.test(get("fo:font-weight")),
      i: /^(italic|oblique)$/.test(get("fo:font-style")),
      u: !!get("style:text-underline-style") && get("style:text-underline-style") !== "none",
      s: !!get("style:text-line-through-style") && get("style:text-line-through-style") !== "none",
      mono: /mono|courier|consol/i.test(get("style:font-name") || get("fo:font-family"))
    });
  }
  return map;
}

export function odfInline(node, styles){
  let out = "";
  for (const c of node.childNodes){
    if (c.nodeType === 3){ out += escHtml(c.nodeValue); continue; }
    if (c.nodeType !== 1) continue;
    switch (c.tagName){
      case "text:line-break": out += "<br>"; break;
      case "text:tab": out += "\t"; break;
      case "text:s": out += " ".repeat(Math.min(200, +(c.getAttribute("text:c") || 1))); break;
      case "text:a": {
        const href = c.getAttribute("xlink:href") || "";
        const inner = odfInline(c, styles);
        out += href ? `<a href="${escHtml(href)}">${inner}</a>` : inner;
        break;
      }
      case "text:span": {
        const st = styles.get(c.getAttribute("text:style-name")) || {};
        let inner = odfInline(c, styles);
        if (st.mono) inner = "<code>" + inner + "</code>";
        if (st.s) inner = "<del>" + inner + "</del>";
        if (st.u) inner = "<u>" + inner + "</u>";
        if (st.i) inner = "<em>" + inner + "</em>";
        if (st.b) inner = "<strong>" + inner + "</strong>";
        out += inner;
        break;
      }
      case "draw:frame": case "draw:image":
        out += "[image]";
        break;
      case "text:note": case "office:annotation":
        break;
      case "text:bookmark": case "text:bookmark-start": case "text:bookmark-end":
      case "text:sequence-decl": case "text:soft-page-break":
        break;
      default:
        out += odfInline(c, styles);
    }
  }
  return out;
}

export function odfListOrdered(doc, styleName){
  if (!styleName) return false;
  for (const ls of doc.getElementsByTagName("text:list-style")){
    if (ls.getAttribute("style:name") !== styleName) continue;
    return !!ls.getElementsByTagName("text:list-level-style-number").length;
  }
  return false;
}

export function odtToHtml(doc, title){
  const styles = odfTextStyles(doc);
  const out = [];
  const para = el => {
    const inner = odfInline(el, styles).trim();
    const sn = el.getAttribute("text:style-name") || "";
    if (!inner) return;
    if (/Preformatted/i.test(sn)) out.push("<pre><code>" + inner + "</code></pre>");
    else if (/Quotation/i.test(sn)) out.push("<blockquote><p>" + inner + "</p></blockquote>");
    else out.push("<p>" + inner + "</p>");
  };
  const list = (el, depth) => {
    const ordered = odfListOrdered(doc, el.getAttribute("text:style-name"));
    const tag = ordered ? "ol" : "ul";
    out.push("<" + tag + ">");
    for (const item of el.children){
      if (!/^text:(list-item|list-header)$/.test(item.tagName)) continue;
      out.push("<li>");
      for (const kid of item.children){
        if (kid.tagName === "text:list") list(kid, depth + 1);
        else if (/^text:(p|h)$/.test(kid.tagName)){
          const inner = odfInline(kid, styles).trim();
          if (inner) out.push(inner);
        }
      }
      out.push("</li>");
    }
    out.push("</" + tag + ">");
  };
  const table = el => {
    const rows = Array.from(el.getElementsByTagName("table:table-row"));
    if (!rows.length) return;
    const grid = rows.map(r => Array.from(r.children)
      .filter(c => c.tagName === "table:table-cell")
      .flatMap(c => {
        const rep = Math.min(64, +(c.getAttribute("table:number-columns-repeated") || 1));
        const v = Array.from(c.children).filter(x => /^text:(p|h)$/.test(x.tagName))
          .map(p => odfInline(p, styles).trim()).filter(Boolean).join("<br>");
        return Array(rep).fill(v);
      }));
    const head = grid[0].map(c => `<th>${c}</th>`).join("");
    const body = grid.slice(1).map(r => "<tr>" + r.map(c => `<td>${c}</td>`).join("") + "</tr>").join("");
    out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
  };
  const walk = node => {
    for (const el of node.children){
      switch (el.tagName){
        case "text:h": {
          const lvl = Math.min(6, Math.max(1, +(el.getAttribute("text:outline-level") || 1)));
          const inner = odfInline(el, styles).trim();
          if (inner) out.push(`<h${lvl}>${inner}</h${lvl}>`);
          break;
        }
        case "text:p": para(el); break;
        case "text:list": list(el, 0); break;
        case "table:table": table(el); break;
        case "text:section": case "office:text": case "text:index-body":
        case "text:table-of-content": walk(el); break;
        default: if (el.children.length) walk(el);
      }
    }
  };
  const body = doc.getElementsByTagName("office:text")[0];
  if (!body) throw new Error("no office:text, this may be a spreadsheet or presentation");
  walk(body);
  return htmlDoc(title || "Document", out.join("\n"));
}

export function odsToSheets(doc, fallbackName){
  const sheets = [];
  for (const t of doc.getElementsByTagName("table:table")){
    const name = t.getAttribute("table:name") || fallbackName || "Sheet";
    const rows = [];
    for (const r of Array.from(t.getElementsByTagName("table:table-row"))){
      const cellEls = Array.from(r.children).filter(c => /^table:(table-cell|covered-table-cell)$/.test(c.tagName));
      const cells = [];
      cellEls.forEach((c, idx) => {
        const vt = c.getAttribute("office:value-type");
        let v;
        if (vt === "float" || vt === "percentage" || vt === "currency") v = c.getAttribute("office:value") ?? "";
        else if (vt === "boolean") v = c.getAttribute("office:boolean-value") === "true" ? "TRUE" : "FALSE";
        else if (vt === "date") v = c.getAttribute("office:date-value") ?? "";
        else if (vt === "time") v = c.getAttribute("office:time-value") ?? "";
        else v = Array.from(c.getElementsByTagName("text:p")).map(p => p.textContent).join("\n");
        const rep = (v === "" && idx === cellEls.length - 1) ? 1 : Math.min(2048, +(c.getAttribute("table:number-columns-repeated") || 1));
        for (let i = 0; i < rep; i++) cells.push(v);
      });
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      const repRow = cells.length ? Math.min(2048, +(r.getAttribute("table:number-rows-repeated") || 1)) : 1;
      for (let i = 0; i < repRow; i++) rows.push(cells.slice());
    }
    while (rows.length && rows[rows.length - 1].every(c => !c)) rows.pop();
    if (rows.length) sheets.push(rowsToSheet(rows, name, true));
  }
  if (!sheets.length) throw new Error("no sheet data found");
  return sheets;
}

export function odpToHtml(doc, title){
  const styles = odfTextStyles(doc);
  const out = [];
  const pages = Array.from(doc.getElementsByTagName("draw:page"));
  if (!pages.length) throw new Error("no draw:page elements, not a presentation");
  pages.forEach((pg, i) => {
    out.push(`<h2>Slide ${i + 1}${pg.getAttribute("draw:name") ? ": " + escHtml(pg.getAttribute("draw:name")) : ""}</h2>`);
    const texts = Array.from(pg.getElementsByTagName("text:p")).map(p => odfInline(p, styles).trim()).filter(Boolean);
    if (!texts.length){ out.push("<p><em>no text on this slide</em></p>"); return; }
    out.push(`<h3>${texts[0]}</h3>`);
    if (texts.length > 1) out.push("<ul>" + texts.slice(1).map(t => `<li>${t}</li>`).join("") + "</ul>");
  });
  return htmlDoc(title || "Presentation", out.join("\n"));
}

export const ODF_NS = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2"`;

export function odfManifest(mime, extra){
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
${extra || ""}
</manifest:manifest>`;
}

export function odfMeta(title){
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${ODF_NS} xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">
<office:meta><dc:title>${xmlEsc(title || "Document")}</dc:title><meta:generator>convert.html</meta:generator></office:meta>
</office:document-meta>`;
}

export const ODT_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${ODF_NS}>
<office:styles>
<style:style style:name="Standard" style:family="paragraph"/>
<style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-bottom="0.1in"/></style:style>
${[1,2,3,4,5,6].map(n => `<style:style style:name="Heading_20_${n}" style:display-name="Heading ${n}" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="0.15in" fo:margin-bottom="0.06in" fo:keep-with-next="always"/><style:text-properties fo:font-weight="bold" fo:font-size="${20 - n * 2}pt"/></style:style>`).join("\n")}
<style:style style:name="List_20_Paragraph" style:display-name="List Paragraph" style:family="paragraph" style:parent-style-name="Standard"/>
<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="0.4in"/><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties style:font-name="Courier New" fo:font-size="10pt"/></style:style>
<style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Italic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="Underline" style:family="text"><style:text-properties style:text-underline-style="solid"/></style:style>
<style:style style:name="Strike" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
<style:style style:name="Code" style:family="text"><style:text-properties style:font-name="Courier New"/></style:style>
<text:list-style style:name="LBullet"><text:list-level-style-bullet text:level="1" text:bullet-char="\u2022"><style:list-level-properties text:space-before="0.25in" text:min-label-width="0.25in"/></text:list-level-style-bullet></text:list-style>
<text:list-style style:name="LNumber"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties text:space-before="0.25in" text:min-label-width="0.25in"/></text:list-level-style-number></text:list-style>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="8.5in" fo:page-height="11in" fo:margin="1in"/></style:page-layout>
</office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>
</office:document-styles>`;

export async function htmlToOdt(html, title){
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,head,noscript").forEach(n => n.remove());
  const body = [];
  const T = s => xmlEsc(s).replace(/\t/g, "<text:tab/>").replace(/ {2,}/g, m => " " + `<text:s text:c="${m.length - 1}"/>`);

  const inline = (node, fmt) => {
    let out = "";
    for (const c of node.childNodes){
      if (c.nodeType === 3){
        const txt = c.nodeValue.replace(/\u00a0/g, " ").replace(/[\r\n]+/g, " ");
        if (!txt) continue;
        const name = fmt.b && fmt.i ? "Bold" : fmt.b ? "Bold" : fmt.i ? "Italic" : fmt.u ? "Underline" : fmt.s ? "Strike" : fmt.code ? "Code" : null;
        out += name ? `<text:span text:style-name="${name}">${T(txt)}</text:span>` : T(txt);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const t = c.tagName.toUpperCase();
      if (t === "BR"){ out += "<text:line-break/>"; continue; }
      if (t === "IMG"){
        const src = c.getAttribute("src") || "";
        out += T("[image" + ((c.getAttribute("alt") || (src.startsWith("data:") ? "" : src)) ? ": " + (c.getAttribute("alt") || src) : "") + "]");
        continue;
      }
      if (t === "A"){
        const href = c.getAttribute("href") || "";
        const inner = inline(c, fmt);
        out += href ? `<text:a xlink:href="${xmlEsc(href)}">${inner}</text:a>` : inner;
        continue;
      }
      const nf = { ...fmt };
      if (t === "B" || t === "STRONG") nf.b = true;
      if (t === "I" || t === "EM" || t === "CITE") nf.i = true;
      if (t === "U") nf.u = true;
      if (t === "DEL" || t === "S" || t === "STRIKE") nf.s = true;
      if (t === "CODE" || t === "SAMP" || t === "KBD") nf.code = true;
      out += inline(c, nf);
    }
    return out;
  };

  const walk = (node, depth) => {
    for (const el of node.children){
      const t = el.tagName.toUpperCase();
      if (/^H[1-6]$/.test(t)){
        const n = +t[1];
        const inner = inline(el, {});
        if (inner) body.push(`<text:h text:style-name="Heading_20_${n}" text:outline-level="${n}">${inner}</text:h>`);
        continue;
      }
      if (t === "P"){ const s = inline(el, {}); if (s) body.push(`<text:p text:style-name="Text_20_body">${s}</text:p>`); continue; }
      if (t === "BLOCKQUOTE"){
        for (const p of (el.children.length ? el.children : [el])){
          const s = inline(p, {});
          if (s) body.push(`<text:p text:style-name="Quotations">${s}</text:p>`);
        }
        continue;
      }
      if (t === "PRE"){
        for (const ln of el.textContent.replace(/\n+$/, "").split("\n")) body.push(`<text:p text:style-name="Preformatted_20_Text">${T(ln) || ""}</text:p>`);
        continue;
      }
      if (t === "HR"){ body.push(`<text:p text:style-name="Standard"/>`); continue; }
      if (t === "UL" || t === "OL"){
        const style = t === "OL" ? "LNumber" : "LBullet";
        const items = [];
        for (const li of el.children){
          if (li.tagName.toUpperCase() !== "LI") continue;
          const nested = Array.from(li.children).filter(c => /^(UL|OL)$/.test(c.tagName.toUpperCase()));
          const clone = li.cloneNode(true);
          Array.from(clone.children).filter(c => /^(UL|OL)$/.test(c.tagName.toUpperCase())).forEach(c => c.remove());
          let inner = `<text:p text:style-name="List_20_Paragraph">${inline(clone, {})}</text:p>`;
          for (const sub of nested){
            const save = body.length;
            walk({ children: [sub] }, depth + 1);
            inner += body.splice(save).join("");
          }
          items.push(`<text:list-item>${inner}</text:list-item>`);
        }
        if (items.length) body.push(`<text:list text:style-name="${style}">${items.join("")}</text:list>`);
        continue;
      }
      if (t === "TABLE"){
        const rows = Array.from(el.querySelectorAll("tr")).filter(tr => tr.closest("table") === el);
        if (!rows.length) continue;
        const cols = Math.max(...rows.map(r => Array.from(r.children).filter(c => /^T[DH]$/.test(c.tagName)).length));
        const name = "Table" + (body.filter(b => b.startsWith("<table:table ")).length + 1);
        const trs = rows.map(tr => {
          const cells = Array.from(tr.children).filter(c => /^T[DH]$/.test(c.tagName));
          const tcs = [];
          for (let k = 0; k < cols; k++){
            const c = cells[k];
            const inner = c ? inline(c, c.tagName === "TH" ? { b: true } : {}) : "";
            tcs.push(`<table:table-cell office:value-type="string"><text:p text:style-name="Text_20_body">${inner}</text:p></table:table-cell>`);
          }
          return `<table:table-row>${tcs.join("")}</table:table-row>`;
        });
        body.push(`<table:table table:name="${xmlEsc(name)}"><table:table-column table:number-columns-repeated="${cols}"/>${trs.join("")}</table:table>`);
        continue;
      }
      if (["DIV","SECTION","ARTICLE","MAIN","BODY","HEADER","FOOTER","ASIDE","FIGURE","DL"].includes(t)){ walk(el, depth); continue; }
      const s = inline(el, {});
      if (s) body.push(`<text:p text:style-name="Text_20_body">${s}</text:p>`);
    }
  };
  walk(doc.body, 0);
  if (!body.length) body.push("<text:p/>");

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS}>
<office:automatic-styles/>
<office:body><office:text>
${body.join("\n")}
</office:text></office:body>
</office:document-content>`;

  const mime = "application/vnd.oasis.opendocument.text";
  return zipWrite([
    { name: "mimetype", bytes: enc.encode(mime) },
    { name: "META-INF/manifest.xml", bytes: enc.encode(odfManifest(mime)) },
    { name: "meta.xml", bytes: enc.encode(odfMeta(title)) },
    { name: "styles.xml", bytes: enc.encode(ODT_STYLES) },
    { name: "content.xml", bytes: enc.encode(content) }
  ]);
}

export async function sheetsToOds(sheets){
  const isNum = v => v !== "" && v !== null && v !== undefined && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(String(v).trim());
  const cell = v => {
    if (v === "" || v === null || v === undefined) return "<table:table-cell/>";
    if (isNum(v)) return `<table:table-cell office:value-type="float" office:value="${String(v).trim()}"><text:p>${xmlEsc(v)}</text:p></table:table-cell>`;
    return `<table:table-cell office:value-type="string"><text:p>${xmlEsc(v)}</text:p></table:table-cell>`;
  };
  const tables = sheets.map((sh, si) => {
    const all = sh.headers.length ? [sh.headers, ...sh.rows] : sh.rows;
    const cols = Math.max(1, ...all.map(r => r.length));
    const rows = all.map((r, ri) => {
      const cs = [];
      for (let k = 0; k < cols; k++) cs.push(ri === 0 && sh.headers.length
        ? `<table:table-cell office:value-type="string" table:style-name="ceHead"><text:p>${xmlEsc(r[k] ?? "")}</text:p></table:table-cell>`
        : cell(r[k]));
      return `<table:table-row>${cs.join("")}</table:table-row>`;
    });
    const nm = (sh.name || "Sheet" + (si + 1)).replace(/[\[\]\*\/\\\?:]/g, "_").slice(0, 31) || "Sheet" + (si + 1);
    return `<table:table table:name="${xmlEsc(nm)}"><table:table-column table:number-columns-repeated="${cols}"/>${rows.join("")}</table:table>`;
  });

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS}>
<office:automatic-styles>
<style:style style:name="ceHead" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style>
</office:automatic-styles>
<office:body><office:spreadsheet>
${tables.join("\n")}
</office:spreadsheet></office:body>
</office:document-content>`;

  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${ODF_NS}><office:styles/><office:automatic-styles/><office:master-styles/></office:document-styles>`;

  const mime = "application/vnd.oasis.opendocument.spreadsheet";
  return zipWrite([
    { name: "mimetype", bytes: enc.encode(mime) },
    { name: "META-INF/manifest.xml", bytes: enc.encode(odfManifest(mime)) },
    { name: "meta.xml", bytes: enc.encode(odfMeta("Spreadsheet")) },
    { name: "styles.xml", bytes: enc.encode(styles) },
    { name: "content.xml", bytes: enc.encode(content) }
  ]);
}
