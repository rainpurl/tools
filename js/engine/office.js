// Word, Excel and PowerPoint files.

import { ZipReader, zipWrite } from "./containers.js";
import { htmlDoc } from "./rich.js";
import { rowsToSheet } from "./table.js";
import { bytesToB64, enc, escHtml, xmlEsc } from "./util.js";

export async function docxToHtml(blob){
  const z = new ZipReader(blob);
  await z.open();
  const main = z.find("word/document.xml");
  if (!main) throw new Error("no word/document.xml, not a docx");
  const doc = new DOMParser().parseFromString(await z.text(main), "application/xml");

  const relsEntry = z.find("word/_rels/document.xml.rels");
  const rels = new Map();
  const mediaMap = new Map();

  if (relsEntry){
    const rd = new DOMParser().parseFromString(await z.text(relsEntry), "application/xml");
    for (const r of rd.getElementsByTagName("Relationship")){
      const id = r.getAttribute("Id");
      const target = r.getAttribute("Target");
      if (id && target){
        rels.set(id, target);
        // Pre-extract embedded images to base64 data URIs
        const fullPath = target.startsWith("media/") ? "word/" + target : target.replace(/^\//, "");
        const imgEntry = z.find(fullPath) || z.find("word/" + target) || z.find(target);
        if (imgEntry){
          try {
            const rawBytes = await z.bytes(imgEntry);
            const ext = target.split('.').pop().toLowerCase();
            const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
            mediaMap.set(id, `data:${mime};base64,${bytesToB64(rawBytes)}`);
          } catch (e){ /* ignore unreadable images */ }
        }
      }
    }
  }

  const tagOf = el => el.tagName.replace(/^.*:/, "");

  const runHtml = r => {
    let text = "";
    let imgHtml = "";
    for (const c of r.children){
      const t = tagOf(c);
      if (t === "t") text += c.textContent;
      else if (t === "tab") text += "    ";
      else if (t === "br") text += "<br>";
      else if (t === "drawing" || t === "pict"){
        const blips = c.getElementsByTagName("a:blip");
        let embedId = null;
        if (blips.length) embedId = blips[0].getAttribute("r:embed") || blips[0].getAttribute("embed");
        if (embedId && mediaMap.has(embedId)){
          imgHtml += `<img src="${mediaMap.get(embedId)}" style="max-width:100%;height:auto;display:inline-block;vertical-align:middle;margin:2px 0;" alt="Embedded image">`;
        } else {
          text += "[image]";
        }
      }
    }

    if (!text && !imgHtml) return "";
    let s = text ? escHtml(text).replace(/&lt;br&gt;/g, "<br>") : "";

    const pr = Array.from(r.children).find(c => tagOf(c) === "rPr");
    const styles = [];

    if (pr){
      const on = n => {
        const e = Array.from(pr.children).find(c => tagOf(c) === n);
        return e && e.getAttribute("w:val") !== "0" && e.getAttribute("w:val") !== "false";
      };
      if (on("b") || on("bCs")) s = "<strong>" + s + "</strong>";
      if (on("i") || on("iCs")) s = "<em>" + s + "</em>";
      if (on("u")) s = "<u>" + s + "</u>";
      if (on("strike")) s = "<del>" + s + "</del>";

      const vert = Array.from(pr.children).find(c => tagOf(c) === "vertAlign");
      if (vert){
        const v = vert.getAttribute("w:val");
        if (v === "superscript") s = "<sup>" + s + "</sup>";
        if (v === "subscript") s = "<sub>" + s + "</sub>";
      }

      // Preserve font color
      const color = Array.from(pr.children).find(c => tagOf(c) === "color");
      if (color && color.getAttribute("w:val") && color.getAttribute("w:val") !== "auto"){
        styles.push(`color:#${color.getAttribute("w:val")}`);
      }

      // Preserve font size (stored in half-points)
      const sz = Array.from(pr.children).find(c => tagOf(c) === "sz");
      if (sz && sz.getAttribute("w:val")){
        const pt = Math.round(parseInt(sz.getAttribute("w:val"), 10) / 2);
        if (pt > 0) styles.push(`font-size:${pt}pt`);
      }

      // Preserve highlight / background color
      const highlight = Array.from(pr.children).find(c => tagOf(c) === "highlight");
      if (highlight && highlight.getAttribute("w:val") && highlight.getAttribute("w:val") !== "none"){
        styles.push(`background-color:${highlight.getAttribute("w:val")}`);
      }

      // Preserve font family
      const rFonts = Array.from(pr.children).find(c => tagOf(c) === "rFonts");
      if (rFonts){
        const face = rFonts.getAttribute("w:ascii") || rFonts.getAttribute("w:hAnsi");
        if (face && !/^(calibri|times|arial|helvetica)$/i.test(face)){
          styles.push(`font-family:'${face}',sans-serif`);
        }
      }
    }

    let res = "";
    if (s){
      res += styles.length ? `<span style="${styles.join(";")}">${s}</span>` : s;
    }
    if (imgHtml){
      res += (res ? " " : "") + imgHtml;
    }
    return res;
  };

  const paraInner = p => {
    let s = "";
    for (const c of p.children){
      const t = tagOf(c);
      if (t === "r") s += runHtml(c);
      else if (t === "hyperlink"){
        const target = rels.get(c.getAttribute("r:id")) || c.getAttribute("w:anchor") || "";
        const inner = Array.from(c.children).filter(x => tagOf(x) === "r").map(runHtml).join("");
        s += target ? `<a href="${escHtml(target)}">${inner}</a>` : inner;
      }
      else if (t === "drawing"){
        const blips = c.getElementsByTagName("a:blip");
        let embedId = null;
        if (blips.length) embedId = blips[0].getAttribute("r:embed") || blips[0].getAttribute("embed");
        if (embedId && mediaMap.has(embedId)){
          s += `<img src="${mediaMap.get(embedId)}" style="max-width:100%;height:auto;display:block;margin:6px 0;" alt="Embedded image">`;
        }
      }
      else if (t === "smartTag" || t === "sdt") s += paraInner(c);
    }
    return s;
  };

  const paraStyle = p => {
    const pr = Array.from(p.children).find(c => tagOf(c) === "pPr");
    if (!pr) return { css: "" };
    const st = Array.from(pr.children).find(c => tagOf(c) === "pStyle");
    const num = Array.from(pr.children).find(c => tagOf(c) === "numPr");
    const val = st ? (st.getAttribute("w:val") || "") : "";
    const ilvl = num ? Array.from(num.children).find(c => tagOf(c) === "ilvl") : null;

    const listStyle = val.match(/^List\s*(Bullet|Number|Paragraph)\s*(\d)?$/i);
    let heading = (val.match(/^Heading\s*(\d)$/i) || [])[1];
    if (!heading && /^Title$/i.test(val)) heading = "1";
    if (!heading && /^Subtitle$/i.test(val)) heading = "2";

    const cssStyles = [];

    // Text alignment
    const jc = Array.from(pr.children).find(c => tagOf(c) === "jc");
    if (jc && jc.getAttribute("w:val")){
      const a = jc.getAttribute("w:val");
      if (a === "center") cssStyles.push("text-align:center");
      else if (a === "right") cssStyles.push("text-align:right");
      else if (a === "both") cssStyles.push("text-align:justify");
      else if (a === "left") cssStyles.push("text-align:left");
    }

    // Left indentation (twips to pt)
    const ind = Array.from(pr.children).find(c => tagOf(c) === "ind");
    if (ind && ind.getAttribute("w:left")){
      const pt = Math.round(parseInt(ind.getAttribute("w:left"), 10) / 20);
      if (pt > 0 && !num && !listStyle) cssStyles.push(`margin-left:${pt}pt`);
    }

    // Paragraph spacing before / after
    const spacing = Array.from(pr.children).find(c => tagOf(c) === "spacing");
    if (spacing){
      if (spacing.getAttribute("w:before")){
        const top = Math.round(parseInt(spacing.getAttribute("w:before"), 10) / 20);
        if (top > 0) cssStyles.push(`margin-top:${top}pt`);
      }
      if (spacing.getAttribute("w:after")){
        const bot = Math.round(parseInt(spacing.getAttribute("w:after"), 10) / 20);
        if (bot > 0) cssStyles.push(`margin-bottom:${bot}pt`);
      }
    }

    return {
      style: val,
      heading,
      list: !!num || !!listStyle,
      level: ilvl ? parseInt(ilvl.getAttribute("w:val") || "0", 10) : (listStyle && listStyle[2] ? +listStyle[2] - 1 : 0),
      ordered: /Number/i.test(val),
      css: cssStyles.join(";")
    };
  };

  const out = [];
  let listOpen = [];
  const closeLists = to => { while (listOpen.length > to) out.push("</" + listOpen.pop() + ">"); };

  const body = Array.from(doc.getElementsByTagName("w:body")[0]?.children || doc.documentElement.children);
  const walkBlocks = nodes => {
    for (const el of nodes){
      const t = tagOf(el);
      if (t === "p"){
        const inner = paraInner(el).trim();
        const st = paraStyle(el);
        const styleAttr = st.css ? ` style="${st.css}"` : "";

        if (st.list){
          const want = st.level + 1;
          const tag = st.ordered ? "ol" : "ul";
          while (listOpen.length > want) out.push("</" + listOpen.pop() + ">");
          if (listOpen.length === want && listOpen[want - 1] !== tag) out.push("</" + listOpen.pop() + ">");
          while (listOpen.length < want){ out.push("<" + tag + ">"); listOpen.push(tag); }
          out.push(`<li${styleAttr}>` + (inner || "") + "</li>");
          continue;
        }
        closeLists(0);
        if (!inner){ continue; }
        if (st.heading) out.push(`<h${Math.min(6, st.heading)}${styleAttr}>${inner}</h${Math.min(6, st.heading)}>`);
        else if (/quote/i.test(st.style)) out.push(`<blockquote${styleAttr}><p>${inner}</p></blockquote>`);
        else out.push(`<p${styleAttr}>` + inner + "</p>");
      } else if (t === "tbl"){
        closeLists(0);
        const rows = Array.from(el.children).filter(c => tagOf(c) === "tr");
        const trs = rows.map((tr, ri) => {
          const cells = Array.from(tr.children).filter(c => tagOf(c) === "tc");
          const cell = ri === 0 ? "th" : "td";
          return "<tr>" + cells.map(tc => {
            const tcPr = Array.from(tc.children).find(c => tagOf(c) === "tcPr");
            const cellStyles = ["border:1px solid #d0d0d0", "padding:4px 8px", "vertical-align:top"];
            if (tcPr){
              const shd = Array.from(tcPr.children).find(c => tagOf(c) === "shd");
              if (shd && shd.getAttribute("w:fill") && shd.getAttribute("w:fill") !== "auto"){
                cellStyles.push(`background-color:#${shd.getAttribute("w:fill")}`);
              }
              const tcW = Array.from(tcPr.children).find(c => tagOf(c) === "tcW");
              if (tcW && tcW.getAttribute("w:w") && tcW.getAttribute("w:type") === "dxa"){
                const wPt = Math.round(parseInt(tcW.getAttribute("w:w"), 10) / 20);
                if (wPt > 0) cellStyles.push(`width:${wPt}pt`);
              }
            }
            const inner = Array.from(tc.children).filter(c => tagOf(c) === "p").map(paraInner).join("<br>");
            return `<${cell} style="${cellStyles.join(";")}">${inner || "&nbsp;"}</${cell}>`;
          }).join("") + "</tr>";
        });
        out.push('<table style="border-collapse:collapse;width:100%;margin:10px 0;">' + (trs.length ? "<thead>" + trs[0] + "</thead><tbody>" + trs.slice(1).join("") + "</tbody>" : "") + "</table>");
      } else if (t === "sdt"){
        const content = Array.from(el.children).find(c => tagOf(c) === "sdtContent");
        if (content) walkBlocks(Array.from(content.children));
      }
    }
  };
  walkBlocks(body);
  closeLists(0);
  return htmlDoc("Document", out.join("\n"));
}

export async function xlsxToSheets(blob){
  const z = new ZipReader(blob);
  await z.open();
  const wbEntry = z.find("xl/workbook.xml");
  if (!wbEntry) throw new Error("no xl/workbook.xml, not an xlsx");
  const P = s => new DOMParser().parseFromString(s, "application/xml");

  const shared = [];
  const ssEntry = z.find("xl/sharedStrings.xml");
  if (ssEntry){
    const sd = P(await z.text(ssEntry));
    for (const si of sd.getElementsByTagName("si")){
      let s = "";
      for (const t of si.getElementsByTagName("t")) s += t.textContent;
      shared.push(s);
    }
  }
  const relMap = new Map();
  const relEntry = z.find("xl/_rels/workbook.xml.rels");
  if (relEntry){
    const rd = P(await z.text(relEntry));
    for (const r of rd.getElementsByTagName("Relationship")) relMap.set(r.getAttribute("Id"), r.getAttribute("Target"));
  }
  const wb = P(await z.text(wbEntry));
  const sheetDefs = Array.from(wb.getElementsByTagName("sheet")).map((s, i) => ({
    name: s.getAttribute("name") || "Sheet" + (i + 1),
    target: relMap.get(s.getAttribute("r:id")) || `worksheets/sheet${i + 1}.xml`
  }));

  const colIdx = ref => {
    const m = String(ref).match(/^([A-Z]+)/);
    if (!m) return 0;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const out = [];
  for (const def of sheetDefs){
    const path = "xl/" + def.target.replace(/^\/?xl\//, "").replace(/^\//, "");
    const se = z.find(path) || z.find("xl/" + def.target) || z.find(def.target.replace(/^\//, ""));
    if (!se) continue;
    const sd = P(await z.text(se));
    const grid = [];
    for (const row of sd.getElementsByTagName("row")){
      const cells = [];
      for (const c of row.getElementsByTagName("c")){
        const idx = colIdx(c.getAttribute("r") || "");
        const type = c.getAttribute("t");
        let v = "";
        if (type === "inlineStr"){
          for (const t of c.getElementsByTagName("t")) v += t.textContent;
        } else {
          const vn = c.getElementsByTagName("v")[0];
          const raw = vn ? vn.textContent : "";
          if (type === "s") v = shared[parseInt(raw, 10)] ?? "";
          else if (type === "b") v = raw === "1" ? "TRUE" : "FALSE";
          else v = raw;
        }
        while (cells.length < idx) cells.push("");
        cells[idx] = v;
      }
      grid.push(cells);
    }
    while (grid.length && grid[grid.length - 1].every(c => !c)) grid.pop();
    out.push(rowsToSheet(grid, def.name, true));
  }
  if (!out.length) throw new Error("workbook has no readable sheets");
  return out;
}

export async function sheetsToXlsx(sheets){
  const colName = n => {
    let s = "";
    n++;
    while (n > 0){ const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  const isNum = v => v !== "" && v !== null && v !== undefined && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(String(v).trim());
  const parts = [], overrides = [], rels = [], defs = [];

  sheets.forEach((sh, si) => {
    const all = sh.headers.length ? [sh.headers, ...sh.rows] : sh.rows;
    const rowsXml = all.map((r, ri) => {
      const cs = r.map((v, ci) => {
        const ref = colName(ci) + (ri + 1);
        if (v === "" || v === null || v === undefined) return "";
        if (isNum(v)) return `<c r="${ref}"><v>${String(v).trim()}</v></c>`;
        const style = (ri === 0 && sh.headers.length) ? ' s="1"' : "";
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
      }).join("");
      return `<row r="${ri + 1}">${cs}</row>`;
    }).join("");
    const widths = (sh.headers.length ? sh.headers : (sh.rows[0] || [])).map((_, ci) => {
      let w = 8;
      for (const r of all) w = Math.max(w, Math.min(60, String(r[ci] ?? "").length + 2));
      return `<col min="${ci + 1}" max="${ci + 1}" width="${w}" customWidth="1"/>`;
    }).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${rowsXml}</sheetData></worksheet>`;
    parts.push({ name: `xl/worksheets/sheet${si + 1}.xml`, bytes: enc.encode(xml) });
    overrides.push(`<Override PartName="/xl/worksheets/sheet${si + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    rels.push(`<Relationship Id="rSh${si + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${si + 1}.xml"/>`);
    const nm = (sh.name || "Sheet" + (si + 1)).replace(/[\\\/\?\*\[\]:]/g, "_").slice(0, 31) || "Sheet" + (si + 1);
    defs.push(`<sheet name="${xmlEsc(nm)}" sheetId="${si + 1}" r:id="rSh${si + 1}"/>`);
  });

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`;

  return zipWrite([
    { name: "[Content_Types].xml", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides.join("\n")}
</Types>`) },
    { name: "_rels/.rels", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
    { name: "xl/workbook.xml", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${defs.join("")}</sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", bytes: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.join("\n")}
<Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) },
    { name: "xl/styles.xml", bytes: enc.encode(styles) },
    ...parts
  ]);
}

export async function pptxToHtml(blob){
  const z = new ZipReader(blob);
  await z.open();
  const slides = z.entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => (+a.name.match(/(\d+)/)[1]) - (+b.name.match(/(\d+)/)[1]));
  if (!slides.length) throw new Error("no slides found, not a pptx");
  const notes = new Map();
  for (const e of z.entries){
    const m = e.name.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
    if (m) notes.set(+m[1], e);
  }
  const out = [];
  let n = 0;
  for (const s of slides){
    n++;
    const doc = new DOMParser().parseFromString(await z.text(s), "application/xml");
    const paras = [];
    for (const p of doc.getElementsByTagName("a:p")){
      let txt = "";
      for (const t of p.getElementsByTagName("a:t")) txt += t.textContent;
      if (txt.trim()) paras.push(txt.trim());
    }
    out.push(`<h2>Slide ${n}</h2>`);
    if (paras.length){
      out.push(`<h3>${escHtml(paras[0])}</h3>`);
      if (paras.length > 1) out.push("<ul>" + paras.slice(1).map(t => `<li>${escHtml(t)}</li>`).join("") + "</ul>");
    } else {
      out.push("<p><em>no text on this slide</em></p>");
    }
    const ne = notes.get(n);
    if (ne){
      const nd = new DOMParser().parseFromString(await z.text(ne), "application/xml");
      let nt = "";
      for (const p of nd.getElementsByTagName("a:p")){
        let t = "";
        for (const x of p.getElementsByTagName("a:t")) t += x.textContent;
        if (t.trim()) nt += t.trim() + "\n";
      }
      if (nt.trim()) out.push(`<blockquote><p>${escHtml(nt.trim()).replace(/\n/g, "<br>")}</p></blockquote>`);
    }
  }
  return htmlDoc("Presentation", out.join("\n"));
}
