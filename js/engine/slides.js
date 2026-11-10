// PowerPoint writer. A deck is built from pictures (one per slide), from the
// pages of a PDF, or from a document, where each heading starts a slide.

import { zipWrite } from "./containers.js";
import { imageSize } from "./docmodel.js";
import { b64ToBytes, enc, xmlEsc } from "./util.js";

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const GROUP = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
const clean = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const THEME = `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Plain"><a:themeElements>
<a:clrScheme name="Plain"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="333333"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2><a:accent1><a:srgbClr val="2F5597"/></a:accent1><a:accent2><a:srgbClr val="C55A11"/></a:accent2><a:accent3><a:srgbClr val="7F7F7F"/></a:accent3><a:accent4><a:srgbClr val="BF9000"/></a:accent4><a:accent5><a:srgbClr val="2E75B6"/></a:accent5><a:accent6><a:srgbClr val="548235"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Plain"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Plain"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;

const MASTER = `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3600" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle>` +
  `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT = `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const rels = list => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith("http") ? type : REL + type}" Target="${target}"/>`).join("") + `</Relationships>`;

// slides: [{ image: { bytes, mime, w, h } } | { title, lines: [{ text, bullet, level }] }]
export async function slidesToPptx(slides, opts){
  if (!slides.length) throw new Error("nothing to put on a slide");
  const H = 6858000;
  // picture decks take the shape of their first picture; text decks are 16 by 9
  const firstImg = slides.find(s => s.image);
  const allImages = slides.every(s => s.image);
  const ratio = allImages && firstImg ? Math.max(0.5, Math.min(2.4, firstImg.image.w / firstImg.image.h)) : 16 / 9;
  const W = Math.round(H * ratio);
  const files = [];
  const slideIds = [];

  const textBox = (id, name, x, y, w, h, paras, anchor) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="${anchor || "t"}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;

  slides.forEach((s, i) => {
    const n = i + 1;
    const rel = [["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]];
    let shapes = "";
    if (s.image){
      const ext = s.image.mime === "image/jpeg" ? "jpeg" : "png";
      files.push({ name: `ppt/media/image${n}.${ext}`, bytes: s.image.bytes });
      rel.push(["rId2", "image", `../media/image${n}.${ext}`]);
      const k = Math.min(W / s.image.w, H / s.image.h);
      const w = Math.round(s.image.w * k), h = Math.round(s.image.h * k);
      shapes += `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture ${n}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        `<p:spPr><a:xfrm><a:off x="${Math.round((W - w) / 2)}" y="${Math.round((H - h) / 2)}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    } else {
      const m = 457200;
      const onlyTitle = !s.lines || !s.lines.length;
      if (s.title){
        shapes += textBox(2, "Title", m, onlyTitle ? Math.round(H * 0.3) : Math.round(m * 0.8), W - m * 2, onlyTitle ? Math.round(H * 0.4) : 1143000,
          `<a:p>${onlyTitle ? `<a:pPr algn="ctr"/>` : ""}<a:r><a:rPr lang="en-US" sz="${onlyTitle ? 4400 : 3200}" b="1"/><a:t>${xmlEsc(clean(s.title))}</a:t></a:r></a:p>`, onlyTitle ? "ctr" : "b");
      }
      if (!onlyTitle){
        const paras = s.lines.map(l => {
          const lvl = Math.min(4, l.level || 0);
          const pr = l.bullet
            ? `<a:pPr marL="${342900 + lvl * 342900}" indent="-342900"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>`
            : `<a:pPr marL="0" indent="0"><a:spcBef><a:spcPts val="800"/></a:spcBef><a:buNone/></a:pPr>`;
          return `<a:p>${pr}<a:r><a:rPr lang="en-US" sz="${l.code ? 1400 : 2000}"${l.bold ? ' b="1"' : ""}>${l.code ? `<a:latin typeface="Consolas"/>` : ""}</a:rPr><a:t>${xmlEsc(clean(l.text))}</a:t></a:r></a:p>`;
        }).join("");
        const top = s.title ? Math.round(m * 0.8) + 1143000 + 114300 : m;
        shapes += textBox(3, "Content", m, top, W - m * 2, H - top - m, paras, "t");
      }
    }
    files.push({ name: `ppt/slides/slide${n}.xml`, bytes: enc.encode(`${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`) });
    files.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, bytes: enc.encode(rels(rel)) });
    slideIds.push(n);
  });

  const presRels = [["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ...slideIds.map(n => [`rId${n + 1}`, "slide", `slides/slide${n}.xml`]),
    [`rId${slideIds.length + 2}`, "theme", "theme/theme1.xml"]];
  const pres = `${HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${slideIds.map(n => `<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`).join("")}</p:sldIdLst>` +
    `<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const types = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    slideIds.map(n => `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("") + `</Types>`;

  return zipWrite([
    { name: "[Content_Types].xml", bytes: enc.encode(types) },
    { name: "_rels/.rels", bytes: enc.encode(rels([["rId1", "officeDocument", "ppt/presentation.xml"]])) },
    { name: "ppt/presentation.xml", bytes: enc.encode(pres) },
    { name: "ppt/_rels/presentation.xml.rels", bytes: enc.encode(rels(presRels)) },
    { name: "ppt/slideMasters/slideMaster1.xml", bytes: enc.encode(MASTER) },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", bytes: enc.encode(rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]])) },
    { name: "ppt/slideLayouts/slideLayout1.xml", bytes: enc.encode(LAYOUT) },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", bytes: enc.encode(rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])) },
    { name: "ppt/theme/theme1.xml", bytes: enc.encode(THEME) },
    ...files
  ]);
}

export async function canvasSlide(canvas, jpeg){
  const blob = await canvas.convertToBlob(jpeg ? { type: "image/jpeg", quality: 0.9 } : { type: "image/png" });
  return { image: { bytes: new Uint8Array(await blob.arrayBuffer()), mime: jpeg ? "image/jpeg" : "image/png", w: canvas.width, h: canvas.height } };
}

// A document becomes a deck: every heading opens a slide, and what follows fills it.
export function htmlToSlides(html, docTitle){
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,template,title").forEach(n => n.remove());
  const slides = [];
  let cur = null, room = 0;
  const open = title => { cur = { title, lines: [] }; slides.push(cur); room = 760; };
  // text after a picture carries on under the last title
  const carry = () => {
    for (let i = slides.length - 1; i >= 0; i--) if (slides[i].title) return slides[i].title.replace(/ \(continued\)$/, "") + " (continued)";
    return docTitle || "";
  };
  const add = line => {
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (!cur) open(slides.length ? carry() : docTitle || "");
    // a slide holds only so much; the rest carries on under the same title
    const cost = text.length + 45;
    if (cur.lines.length && (room < cost || cur.lines.length >= 10)) open(cur.title ? cur.title.replace(/ \(continued\)$/, "") + " (continued)" : "");
    room -= cost;
    cur.lines.push({ ...line, text });
  };
  const walk = (node, level) => {
    for (const el of node.children){
      const t = el.tagName;
      if (/^H[1-6]$/.test(t)){ const s = el.textContent.replace(/\s+/g, " ").trim(); if (s) open(s); }
      else if (t === "P" || t === "BLOCKQUOTE" || t === "DT" || t === "DD" || t === "FIGCAPTION"){
        const img = el.querySelector("img[src^='data:image/']");
        if (img && !el.textContent.trim()) picture(img);
        else if (t === "P" && titled(el)) open(el.textContent.replace(/\s+/g, " ").trim());
        else add({ text: el.textContent, bullet: false });
      }
      else if (t === "PRE") for (const ln of el.textContent.split("\n").slice(0, 14)) add({ text: ln, bullet: false, code: true });
      else if (t === "UL" || t === "OL"){
        let n = 0;
        for (const li of el.children){
          if (li.tagName !== "LI") continue;
          n++;
          const own = li.cloneNode(true);
          own.querySelectorAll("ul,ol").forEach(x => x.remove());
          add({ text: (t === "OL" ? n + ". " : "") + own.textContent, bullet: t === "UL", level });
          for (const sub of li.children) if (/^(UL|OL)$/.test(sub.tagName)) walk({ children: [sub] }, level + 1);
        }
      }
      else if (t === "TABLE"){
        for (const tr of el.querySelectorAll("tr")) add({ text: Array.from(tr.children).map(c => c.textContent.trim()).join("  |  "), bullet: false });
      }
      else if (t === "IMG") picture(el);
      else if (t === "HR"){ /* a rule carries nothing onto a slide */ }
      else if (el.children.length) walk(el, level);
      else add({ text: el.textContent, bullet: false });
    }
  };
  // a short line set all in bold or in large type is a heading, whatever tag holds it
  const titled = el => {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (!text || text.length > 90 || /[.,;:]$/.test(text)) return false;
    let marked = 0;
    for (const n of el.querySelectorAll("strong,b,span[style*='font-size']")){
      if (n.parentElement.closest("strong,b,span[style*='font-size']")) continue;
      const big = /font-size:\s*([\d.]+)pt/.exec(n.getAttribute("style") || "");
      if (/^(STRONG|B)$/.test(n.tagName) || (big && +big[1] >= 14)) marked += n.textContent.replace(/\s+/g, " ").trim().length;
    }
    return marked >= text.length;
  };
  const picture = img => {
    const m = /^data:(image\/(?:png|jpe?g));base64,(.*)$/s.exec(img.getAttribute("src") || "");
    if (!m) return;
    try {
      const bytes = b64ToBytes(m[2].replace(/\s+/g, ""));
      const dim = imageSize(bytes);
      if (dim) slides.push({ image: { bytes, mime: m[1] === "image/jpg" ? "image/jpeg" : m[1], w: dim.w, h: dim.h } });
      cur = null;
    } catch (e){ /* an unreadable picture is skipped */ }
  };
  walk(doc.body || doc.documentElement, 0);
  if (!slides.length) slides.push({ title: docTitle || "Untitled", lines: [] });
  return slides;
}
