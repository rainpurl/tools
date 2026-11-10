// The conversion engine: build a shared shape from a file, then write the target from it.

import { decodeFrames, framesToApng, framesToGif } from "./anim.js";
import {
  aiffDecode,
  audioToAac,
  audioToAiff,
  audioToOpus,
  audioToPcm,
  audioToWav,
  decodeAudio
} from "./audio.js";
import { bitmapToCanvas, resizeCanvas } from "./canvas.js";
import { icnsEntries } from "./codecs.js";
import { ZipReader, tarRead, tarWrite, zipWrite } from "./containers.js";
import {
  cuesToAss,
  cuesToLrc,
  cuesToRich,
  cuesToSbv,
  cuesToSrt,
  cuesToSub,
  cuesToTable,
  cuesToText,
  cuesToTtml,
  cuesToVtt,
  parseAss,
  parseCues,
  parseLrc,
  parseSbv,
  parseSub,
  parseTtml,
  tc
} from "./cues.js";
import {
  bplistDecode,
  bsonDecode,
  cborDecode,
  cborEncode,
  dbfToSheets,
  harToSheets,
  msgpackDecode,
  msgpackEncode,
  sheetsToSql,
  sqliteRead
} from "./data.js";
import { epubToHtml, fb2ToHtml, htmlToEpub, ipynbToHtml, mhtmlToHtml, mobiToHtml } from "./ebook.js";
import { bytesToB32, bytesToQp, bytesToUrlEnc } from "./encode.js";
import {
  geojsonToSheets,
  gpxToSheets,
  kmlToSheets,
  kmzToSheets,
  sheetsToGeojson,
  sheetsToGpx,
  sheetsToKml
} from "./geo.js";
import { emlToHtml, parseEml, parseIcs, parseVcf, sheetsToIcs, sheetsToVcf } from "./mail.js";
import { htmlToAsciidoc, htmlToBbcode, htmlToLatex, htmlToRst } from "./markup.js";
import {
  meshToCanvas,
  meshToObj,
  meshToOff,
  meshToSheets,
  meshToStl,
  objDecode,
  offDecode,
  stlDecode
} from "./mesh.js";
import { MODULES, MODULE_HUBS, TARGET_MODULE } from "./modules.js";
import { htmlToOdt, odfOpen, odpToHtml, odsToSheets, odtToHtml, sheetsToOds } from "./odf.js";
import { htmlToDocx, htmlToRtf } from "./docwrite.js";
import { docxToHtml, pptxToHtml, sheetsToXlsx, xlsxToSheets } from "./office.js";
import { loadPdfDoc, pdfToCanvases, pdfToHtml } from "./pdfread.js";
import { htmlToPdf, imagesToPdf } from "./pdfwrite.js";
import { canvasToBytes, epsToPdf, loadRaster } from "./raster.js";
import { KINDS, MIME, TARGETS, VECTOR_KINDS, canCombine, hubsOf, routeFor } from "./registry.js";
import { htmlDoc, htmlToMd, htmlToText, mdToHtml } from "./rich.js";
import { rtfToHtml } from "./rtf.js";
import {
  jsonToTable,
  objectsToSheet,
  parseDelimited,
  rowsToSheet,
  sheetsToDelimited,
  sheetsToHtml,
  sheetsToMarkdown,
  sheetsToText,
  sheetsToXml,
  tableToObjects
} from "./table.js";
import {
  iniParse,
  parseXml,
  stripJsonComments,
  toIni,
  toToml,
  toYaml,
  tomlParse,
  treeToTable,
  treeToXml,
  xmlToTree,
  yamlParse
} from "./tree.js";
import {
  baseName,
  bytesToB64,
  bytesToHex,
  decodeText,
  enc,
  escHtml,
  gunzip,
  gzip,
  safeName,
  utf8
} from "./util.js";

import { cfbKind, docToHtml, parseMsg, pptToHtml, xlsToSheets } from "./cfb.js";
import { bibToSheets, npyToSheets, parquetToSheets, risToSheets, sheetsToBib, sheetsToRis } from "./dataextra.js";
import { mboxSplit, xpsToHtml } from "./docextra.js";
import { fontExt, fontTo, readFonts } from "./fonts.js";
import { avConvert, sevenCreate, sevenExtract } from "./media.js";
import { glbDecode, meshToGlb, meshToPly, plyDecode, threeMfDecode } from "./meshextra.js";
import { canvasSlide, htmlToSlides, slidesToPptx } from "./slides.js";

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

export async function getHub(item, hub, opts){
  item._hub = item._hub || {};
  const key = hub === "raster" && VECTOR_KINDS.has(item.kind) ? "raster@" + (+opts.vecSize || 0) : hub;
  if (key in item._hub) return item._hub[key];
  const v = await buildHub(item, hub, opts);
  item._hub[key] = v;
  return v;
}

export async function rawBytes(item){
  if (!item._bytes) item._bytes = new Uint8Array(await item.file.arrayBuffer());
  return item._bytes;
}

export async function rawText(item){
  if (item._text === undefined) item._text = decodeText(await rawBytes(item));
  return item._text;
}

export async function buildHub(item, hub, opts){
  const kind = item.kind;
  const name = baseName(item.file.name);

  if (hub === "bytes") return rawBytes(item);
  if (hub === "plain") return rawText(item);
  if (hub === "raster") return loadRaster(item.file, kind, opts);
  if (hub === "audio"){
    if (/\.(aif|aiff|aifc)$/i.test(item.file.name) || (await rawBytes(item)).length > 12 &&
        utf8.decode((await rawBytes(item)).subarray(8, 12)).startsWith("AIF"))
      return aiffDecode(await rawBytes(item));
    return decodeAudio(item.file);
  }
  if (hub === "pdf") return loadPdfDoc(item.file);
  if (hub === "anim") return decodeFrames(item.file, kind, opts.frameLimit || 600);
  if (hub === "icons") return icnsEntries(await rawBytes(item));
  if (hub === "av") return item;
  if (hub === "font") return readFonts(await rawBytes(item), opts);
  if (hub === "mesh"){
    if (kind === "ply") return plyDecode(await rawBytes(item), name);
    if (kind === "glb") return glbDecode(await rawBytes(item), name);
    if (kind === "m3mf") return threeMfDecode(item.file, name);
    if (kind === "obj") return objDecode(await rawText(item), name);
    if (kind === "off") return offDecode(await rawText(item), name);
    if (kind === "stl") return stlDecode(await rawBytes(item), name);
    throw new Error("no mesh representation");
  }

  if (hub === "archive"){
    if (KINDS[kind].module === "sevenzip") return sevenExtract(item.file, kind, opts);
    if (kind === "mbox") return mboxSplit(await rawBytes(item));
    if (KINDS[kind].zip || kind === "kmz"){
      const z = new ZipReader(item.file);
      await z.open();
      const out = [];
      for (const e of z.entries) out.push({ name: e.name, bytes: await z.bytes(e) });
      return out;
    }
    if (kind === "tar") return tarRead(await rawBytes(item));
    if (kind === "gz"){
      const inner = await gunzip(await rawBytes(item));
      const stripped = item.file.name.replace(/\.gz$/i, "");
      if (/\.tar$/i.test(stripped)) return tarRead(inner);
      return [{ name: stripped || name, bytes: inner }];
    }
    if (kind === "tgz") return tarRead(await gunzip(await rawBytes(item)));
    throw new Error("not an archive");
  }

  if (hub === "cues"){
    const txt = await rawText(item);
    if (kind === "ass")  return parseAss(txt);
    if (kind === "subv") return parseSub(txt, opts.subFps);
    if (kind === "sbv")  return parseSbv(txt);
    if (kind === "lrc")  return parseLrc(txt);
    if (kind === "ttml") return parseTtml(txt);
    return parseCues(txt, kind);
  }

  if (hub === "tree"){
    const text = await rawText(item);
    if (kind === "json") return JSON.parse(text);
    if (kind === "yaml") return yamlParse(text);
    if (kind === "toml") return tomlParse(text);
    if (kind === "ini")  return iniParse(text);
    if (kind === "jsonc") return JSON.parse(stripJsonComments(text));
    if (kind === "geojson" || kind === "har") return JSON.parse(text);
    if (kind === "msgpack") return msgpackDecode(await rawBytes(item));
    if (kind === "cbor")  return cborDecode(await rawBytes(item));
    if (kind === "bson")  return bsonDecode(await rawBytes(item));
    if (kind === "bplist") return bplistDecode(await rawBytes(item));
    if (kind === "xml" || kind === "gpx" || kind === "kml") return xmlToTree(parseXml(text, kind));
    throw new Error("no tree representation");
  }

  if (hub === "table"){
    if (kind === "xls") return xlsToSheets(await rawBytes(item), opts);
    if (kind === "parquet") return parquetToSheets(await rawBytes(item), name, opts);
    if (kind === "npy") return npyToSheets(await rawBytes(item), name);
    const text = kind === "xlsx" ? null : await rawText(item);
    if (kind === "bib") return bibToSheets(text, name);
    if (kind === "ris") return risToSheets(text, name);
    const header = opts.hasHeader !== false;
    if (kind === "csv")  return [rowsToSheet(parseDelimited(text, opts.delimIn || null), name, header)];
    if (kind === "tsv")  return [rowsToSheet(parseDelimited(text, "\t"), name, header)];
    if (kind === "jsonl") return [objectsToSheet(text.split(/\n+/).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (e){ return { line: l }; } }), name)];
    if (kind === "json") return jsonToTable(JSON.parse(text), name);
    if (kind === "yaml") return treeToTable(yamlParse(text), name);
    if (kind === "xml"){
      const d = new DOMParser().parseFromString(text, "application/xml");
      if (d.getElementsByTagName("parsererror").length) throw new Error("invalid xml");
      return treeToTable(xmlToTree(d), name);
    }
    if (kind === "xlsx") return xlsxToSheets(item.file);
    if (kind === "toml") return treeToTable(tomlParse(text), name);
    if (kind === "ini")  return treeToTable(iniParse(text), name);
    if (kind === "jsonc") return jsonToTable(JSON.parse(stripJsonComments(text)), name);
    if (kind === "har")  return harToSheets(text);
    if (kind === "gpx")  return gpxToSheets(text);
    if (kind === "kml")  return kmlToSheets(text);
    if (kind === "kmz")  return kmzToSheets(item.file);
    if (kind === "geojson") return geojsonToSheets(text);
    if (kind === "dbf")  return dbfToSheets(await rawBytes(item), name);
    if (kind === "obj")  return meshToSheets(objDecode(await rawText(item), name));
    if (kind === "off")  return meshToSheets(offDecode(await rawText(item), name));
    if (kind === "stl")  return meshToSheets(stlDecode(await rawBytes(item), name));
    if (kind === "sqlite") return sqliteRead(await rawBytes(item), opts);
    if (kind === "msgpack") return jsonToTable(msgpackDecode(await rawBytes(item)), name);
    if (kind === "cbor")  return jsonToTable(cborDecode(await rawBytes(item)), name);
    if (kind === "bson")  return jsonToTable(bsonDecode(await rawBytes(item)), name);
    if (kind === "bplist") return treeToTable(bplistDecode(await rawBytes(item)), name);
    if (kind === "ods"){ const o = await odfOpen(item.file); return odsToSheets(o.doc, name); }
    if (kind === "ics")  return parseIcs(text);
    if (kind === "vcf")  return parseVcf(text);
    if (kind === "html"){
      const d = new DOMParser().parseFromString(text, "text/html");
      const tables = Array.from(d.querySelectorAll("table"));
      if (!tables.length) throw new Error("no table in this html");
      return tables.map((tb, i) => {
        const rows = Array.from(tb.querySelectorAll("tr")).filter(tr => tr.closest("table") === tb)
          .map(tr => Array.from(tr.children).filter(c => /^T[DH]$/.test(c.tagName)).map(c => c.textContent.trim()));
        const hasTh = !!tb.querySelector("th");
        return rowsToSheet(rows, tables.length > 1 ? "table " + (i + 1) : name, hasTh);
      });
    }
    throw new Error("no table representation");
  }

  if (hub === "rich"){
    const kindsDirect = { html: t => t, md: t => htmlDoc(name, mdToHtml(t)) };
    if (kind in kindsDirect) return kindsDirect[kind](await rawText(item));
    if (kind === "txt") return htmlDoc(name, "<pre>" + escHtml(await rawText(item)) + "</pre>");
    if (kind === "rtf") return rtfToHtml(await rawText(item), name);
    if (kind === "docx") return docxToHtml(item.file);
    if (kind === "pptx") return pptxToHtml(item.file);
    if (kind === "odt"){ const o = await odfOpen(item.file); return odtToHtml(o.doc, name); }
    if (kind === "odp"){ const o = await odfOpen(item.file); return odpToHtml(o.doc, name); }
    if (kind === "epub") return epubToHtml(item.file);
    if (kind === "mobi") return mobiToHtml(await rawBytes(item), name);
    if (kind === "fb2") return fb2ToHtml(await rawText(item));
    if (kind === "ipynb") return ipynbToHtml(await rawText(item), name);
    if (kind === "code"){
      const lang = (item.file.name.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();
      return htmlDoc(name, `<pre><code${lang ? ` class="language-${escHtml(lang)}"` : ""}>` +
        escHtml(await rawText(item)).replace(/\n+$/, "") + "</code></pre>");
    }
    if (kind === "mhtml") return mhtmlToHtml(await rawText(item));
    if (kind === "eml"){
      const p = parseEml(await rawText(item));
      item._eml = p;
      return emlToHtml(p);
    }
    if (kind === "msg"){
      const p = parseMsg(await rawBytes(item));
      item._eml = p;
      return emlToHtml(p);
    }
    if (kind === "doc" || kind === "xls" || kind === "ppt"){
      // the extension is not always the truth for these
      const bytes = await rawBytes(item);
      const real = cfbKind(bytes) || kind;
      if (real === "ppt") return pptToHtml(bytes);
      if (real === "doc") return docToHtml(bytes, name);
      throw new Error("this file is not a Word or PowerPoint document");
    }
    if (kind === "xps") return xpsToHtml(item.file, name);
    throw new Error("no document representation");
  }
  throw new Error("unknown hub " + hub);
}

export async function emitRich(html, target, opts, one){
  if (target === "html") return one(enc.encode(html));
  if (target === "md")   return one(enc.encode(htmlToMd(html) + "\n"));
  if (target === "txt")  return one(enc.encode(htmlToText(html, opts.textWrap || 0)));
  if (target === "rtf" || target === "doc") return one(enc.encode(htmlToRtf(html)));
  if (target === "docx") return one(await htmlToDocx(html));
  if (target === "odt")  return one(await htmlToOdt(html, opts.docTitle || ""));
  if (target === "epub") return one(await htmlToEpub(html, opts.docTitle || ""));
  if (target === "latex")  return one(enc.encode(htmlToLatex(html, opts.docTitle || "")));
  if (target === "adoc")   return one(enc.encode(htmlToAsciidoc(html, opts.docTitle || "")));
  if (target === "rst")    return one(enc.encode(htmlToRst(html, opts.docTitle || "")));
  if (target === "bbcode") return one(enc.encode(htmlToBbcode(html)));
  if (target === "pdf")  return one(await htmlToPdf(html, opts));
  if (target === "pptx") return one(await slidesToPptx(htmlToSlides(html, opts.docTitle || "")));
  return null;
}

export async function convertItem(item, target, opts){
  const hub = routeFor(item.kind, target);
  if (!hub) throw new Error("no route");
  const mod = MODULE_HUBS[hub];
  if (mod && !MODULES[mod].loaded){
    if (!opts.allowModules) throw new Error(`needs the optional ${MODULES[mod].label} module`);
    if (typeof opts.notify === "function") opts.notify(`  loading ${MODULES[mod].label} module (${MODULES[mod].size})`);
    await MODULES[mod].load();
  }

  const base = item.outBase || safeName(baseName(item.file.name));
  opts = { ...opts, docTitle: baseName(item.file.name) };
  const def = TARGETS[target];
  const one = bytes => [{ name: base + (def.ext ? "." + def.ext : ""), bytes, mime: MIME[target] || "application/octet-stream" }];

  if (item.kind === "eps" && target === "pdf") return one(await epsToPdf(await rawBytes(item), opts));

  const tm = TARGET_MODULE[target];
  if (tm && !MODULES[tm].loaded){
    if (!opts.allowModules) throw new Error(`needs the optional ${MODULES[tm].label} module`);
    if (typeof opts.notify === "function" && tm !== "sevenzip") opts.notify(`  loading ${MODULES[tm].label} (${MODULES[tm].size})`);
  }

  if (hub === "av") return avConvert({ ...item, outBase: base }, target, opts);

  let val;
  try { val = await getHub(item, hub, opts); }
  catch (e){
    // sound the browser cannot decode goes to ffmpeg instead
    if (hub === "audio" && def.via.includes("av") && hubsOf(item.kind).includes("av") && opts.allowModules !== false){
      return avConvert({ ...item, outBase: base }, target, opts);
    }
    throw e;
  }

  if (hub === "font"){
    const many = val.length > 1;
    const outs = [];
    for (const [i, font] of val.entries()){
      const ext = target === "sfnt" ? fontExt(font) : target;
      outs.push({ name: `${base}${many ? "-" + (i + 1) : ""}.${ext}`, bytes: await fontTo(font, target, opts), mime: target === "sfnt" ? "font/" + ext : MIME[target] });
    }
    return outs;
  }

  if (hub === "pdf" && target === "pptx" && opts.pdfSlides !== "text"){
    const slides = [];
    for (const c of await pdfToCanvases(val, 2)) slides.push(await canvasSlide(c, true));
    return one(await slidesToPptx(slides));
  }

  if (hub === "archive" && target === "pdf"){
    const pics = val.filter(m => IMAGE_NAME.test(m.name) && !/(^|\/)(__MACOSX|\.)/.test(m.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!pics.length) throw new Error("there are no pictures in this archive to make pages from");
    const canvases = [];
    for (const m of pics){
      try { canvases.push(bitmapToCanvas(await createImageBitmap(new Blob([m.bytes])))); }
      catch (e){ /* a picture the browser cannot read is left out */ }
    }
    if (!canvases.length) throw new Error("none of the pictures in this archive could be read");
    return one(await imagesToPdf(canvases, { ...opts, fitPage: "image" }));
  }

  if (target === "files" && (hub === "archive" || hub === "pdf")){
    if (hub === "archive") return val.map(m => ({ name: safeName(m.name.split("/").pop()) || "file", path: m.name, bytes: m.bytes, mime: "application/octet-stream" }));
    const canvases = await pdfToCanvases(val, opts.pdfScale || 2);
    const out = [];
    for (const [i, c] of canvases.entries()){
      out.push({ name: `${base}-p${String(i + 1).padStart(3, "0")}.png`, bytes: await canvasToBytes(c, "png"), mime: "image/png" });
    }
    return out;
  }

  if (hub === "pdf" && ["png","jpeg","webp"].includes(target)){
    const canvases = await pdfToCanvases(val, opts.pdfScale || 2);
    const out = [];
    for (const [i, c] of canvases.entries()){
      const cc = resizeCanvas(c, opts.imgMax || 0, target === "jpeg" ? (opts.imgBg || "#ffffff") : null);
      out.push({ name: `${base}-p${String(i + 1).padStart(3, "0")}.${def.ext}`, bytes: await canvasToBytes(cc, target, opts.imgQuality), mime: MIME[target] });
    }
    return out;
  }

  if (hub === "pdf" && TARGETS[target].via.includes("rich")){
    // colours and pictures cost a render of every page, so only read them where they can be kept
    const html = await pdfToHtml(val, { ...opts, styled: ["docx", "doc", "rtf", "html"].includes(target), pageBreaks: opts.pdfPageBreaks !== false });
    const out = await emitRich(html, target, opts, one);
    if (out) return out;
  }

  if (hub === "anim"){
    if (target === "gif") return one(await framesToGif(val, opts));
    if (target === "apng") return one(await framesToApng(val, opts));
    if (target === "frames"){
      const outs = [];
      for (const [i, f] of val.entries()){
        const c = resizeCanvas(f.canvas, opts.imgMax || 0, null);
        outs.push({ name: `${base}-f${String(i + 1).padStart(4, "0")}.png`, bytes: await canvasToBytes(c, "png"), mime: "image/png" });
      }
      return outs;
    }
    if (target === "files"){
      const outs = [];
      for (const [i, f] of val.entries()){
        const c = resizeCanvas(f.canvas, opts.imgMax || 0, null);
        outs.push({ name: `${base}-f${String(i + 1).padStart(4, "0")}.png`, bytes: await canvasToBytes(c, "png"), mime: "image/png" });
      }
      return outs;
    }
  }

  if (hub === "icons" && (target === "files" || target === "zip")){
    const outs = val.map(e => ({ name: `${base}-${e.type}.${e.ext}`, bytes: e.bytes, mime: e.mime }));
    if (target === "zip") return one(await zipWrite(outs.map(o => ({ name: o.name, bytes: o.bytes }))));
    return outs;
  }

  if (hub === "mesh"){
    if (target === "obj") return one(enc.encode(meshToObj(val)));
    if (target === "off") return one(enc.encode(meshToOff(val)));
    if (target === "stl") return one(meshToStl(val, opts));
    if (target === "ply") return one(meshToPly(val));
    if (target === "glb") return one(meshToGlb(val));
    if (["png","jpeg","webp"].includes(target)){
      return one(await canvasToBytes(meshToCanvas(val, opts), target, +opts.imgQuality || 0.9));
    }
    if (target === "pdf") return one(await imagesToPdf([meshToCanvas(val, opts)], opts));
  }

  switch (hub){
    case "raster": {
      const flat = target === "jpeg" || target === "bmp" || target === "eps";
      const canvas = resizeCanvas(val, opts.imgMax || 0, flat ? (opts.imgBg || "#ffffff") : null);
      if (target === "pdf") return one(await imagesToPdf([canvas], opts));
      if (target === "pptx") return one(await slidesToPptx([await canvasSlide(canvas, false)]));
      return one(await canvasToBytes(canvas, target, opts.imgQuality));
    }

    case "table": {
      const sheets = val;
      if (target === "csv")   return one(enc.encode(sheetsToDelimited(sheets, opts.delimOut || ",", opts.writeHeader)));
      if (target === "tsv")   return one(enc.encode(sheetsToDelimited(sheets, "\t", opts.writeHeader)));
      if (target === "json"){
        const v = sheets.length === 1 ? tableToObjects(sheets[0])
          : Object.fromEntries(sheets.map(s => [s.name, tableToObjects(s)]));
        return one(enc.encode(JSON.stringify(v, null, opts.jsonPretty === false ? 0 : 2) + "\n"));
      }
      if (target === "jsonl") return one(enc.encode(sheets.flatMap(tableToObjects).map(o => JSON.stringify(o)).join("\n") + "\n"));
      if (target === "yaml"){
        const v = sheets.length === 1 ? tableToObjects(sheets[0]) : Object.fromEntries(sheets.map(s => [s.name, tableToObjects(s)]));
        return one(enc.encode(toYaml(v)));
      }
      if (target === "xml")   return one(enc.encode(sheetsToXml(sheets)));
      if (target === "xlsx")  return one(await sheetsToXlsx(sheets));
      if (target === "ods")   return one(await sheetsToOds(sheets));
      if (target === "sql")   return one(enc.encode(sheetsToSql(sheets, opts)));
      if (target === "msgpack") return one(msgpackEncode(
        sheets.length === 1 ? tableToObjects(sheets[0])
          : Object.fromEntries(sheets.map(sh => [sh.name, tableToObjects(sh)]))));
      if (target === "cbor")   return one(cborEncode(
        sheets.length === 1 ? tableToObjects(sheets[0])
          : Object.fromEntries(sheets.map(sh => [sh.name, tableToObjects(sh)]))));
      if (target === "geojson") return one(enc.encode(sheetsToGeojson(sheets, opts.jsonPretty)));
      if (target === "gpx")    return one(enc.encode(sheetsToGpx(sheets)));
      if (target === "kml")    return one(enc.encode(sheetsToKml(sheets)));
      if (target === "ics")    return one(enc.encode(sheetsToIcs(sheets)));
      if (target === "vcf")    return one(enc.encode(sheetsToVcf(sheets)));
      if (target === "bib")    return one(enc.encode(sheetsToBib(sheets)));
      if (target === "ris")    return one(enc.encode(sheetsToRis(sheets)));
      if (target === "md")    return one(enc.encode(sheetsToMarkdown(sheets)));
      if (target === "html")  return one(enc.encode(sheetsToHtml(sheets, base)));
      if (target === "txt")   return one(enc.encode(sheetsToText(sheets)));
      break;
    }

    case "tree": {
      if (target === "json") return one(enc.encode(JSON.stringify(val, null, opts.jsonPretty === false ? 0 : 2) + "\n"));
      if (target === "yaml") return one(enc.encode(toYaml(val)));
      if (target === "xml")  return one(enc.encode(treeToXml(val, base)));
      if (target === "toml") return one(enc.encode(toToml(val)));
      if (target === "msgpack") return one(msgpackEncode(val));
      if (target === "cbor") return one(cborEncode(val));
      if (target === "ini")  return one(enc.encode(toIni(val)));
      if (target === "txt")  return one(enc.encode(JSON.stringify(val, null, 2) + "\n"));
      break;
    }

    case "rich": {
      const html = val;
      const extras = [];
      if (item._eml && item._eml.attachments.length && opts.emlAttachments !== false){
        for (const a of item._eml.attachments) extras.push({ name: base + "-" + a.name, bytes: a.bytes, mime: "application/octet-stream" });
      }
      const main = await emitRich(html, target, opts, one);
      if (main) return main.concat(extras);
      break;
    }

    case "cues": {
      if (target === "srt")  return one(enc.encode(cuesToSrt(val)));
      if (target === "vtt")  return one(enc.encode(cuesToVtt(val)));
      if (target === "ass")  return one(enc.encode(cuesToAss(val, opts)));
      if (target === "subv") return one(enc.encode(cuesToSub(val, opts.subFps)));
      if (target === "sbv")  return one(enc.encode(cuesToSbv(val)));
      if (target === "lrc")  return one(enc.encode(cuesToLrc(val)));
      if (target === "ttml") return one(enc.encode(cuesToTtml(val, opts.docTitle)));
      if (TARGETS[target].via.includes("rich")){
        const out = await emitRich(cuesToRich(val, opts.docTitle), target, opts, one);
        if (out) return out;
      }
      if (target === "txt")  return one(enc.encode(cuesToText(val)));
      if (target === "json") return one(enc.encode(JSON.stringify(val.map(c => ({ start: tc(c.start, true), end: tc(c.end, true), text: c.text })), null, 2) + "\n"));
      if (target === "csv")  return one(enc.encode(sheetsToDelimited(cuesToTable(val), ",", opts.writeHeader)));
      if (target === "tsv")  return one(enc.encode(sheetsToDelimited(cuesToTable(val), "\t", opts.writeHeader)));
      break;
    }

    case "audio": {
      const bits = +opts.wavBits || 16;
      if (target === "wav")  return one(audioToWav(val, bits));
      if (target === "aiff") return one(audioToAiff(val, bits === 32 ? 32 : bits));
      if (target === "pcm")  return one(audioToPcm(val, bits, opts.pcmLittleEndian !== false));
      if (target === "opus") return one(await audioToOpus(val, opts));
      if (target === "aac")  return one(await audioToAac(val, opts));
      break;
    }

    case "archive": {
      const members = val;
      if (target === "zip")  return one(await zipWrite(members));
      if (target === "tar")  return one(tarWrite(members));
      if (target === "tgz")  return one(await gzip(tarWrite(members)));
      if (target === "sevenz" || target === "txz" || target === "tbz2") return one(await sevenCreate(members, target, opts));
      break;
    }

    case "plain": {
      if (target === "txt") return one(enc.encode(val.replace(/\r\n?/g, "\n")));
      break;
    }

    case "bytes": {
      const bytes = val;
      if (target === "gz")      return [{ name: safeName(item.file.name) + ".gz", bytes: await gzip(bytes), mime: MIME.gz }];
      if (target === "zip")     return one(await zipWrite([{ name: safeName(item.file.name), bytes }]));
      if (target === "tar")     return one(tarWrite([{ name: safeName(item.file.name), bytes }]));
      if (target === "tgz")     return one(await gzip(tarWrite([{ name: safeName(item.file.name), bytes }])));
      if (target === "sevenz" || target === "txz" || target === "tbz2") return one(await sevenCreate([{ name: safeName(item.file.name), bytes }], target, opts));
      if (target === "xz" || target === "bz2"){
        return [{ name: safeName(item.file.name) + "." + target, bytes: await sevenCreate([{ name: safeName(item.file.name), bytes }], target, opts), mime: MIME[target] }];
      }
      if (target === "base64")  return one(enc.encode(bytesToB64(bytes).replace(/(.{76})/g, "$1\n") + "\n"));
      if (target === "base32")  return one(enc.encode(bytesToB32(bytes).replace(/(.{76})/g, "$1\n") + "\n"));
      if (target === "urlenc")  return one(enc.encode(bytesToUrlEnc(bytes) + "\n"));
      if (target === "qp")      return one(enc.encode(bytesToQp(bytes)));
      if (target === "hex")     return one(enc.encode(bytesToHex(bytes, true) + "\n"));
      if (target === "datauri"){
        const mime = item.file.type || MIME[item.kind] || "application/octet-stream";
        return one(enc.encode(`data:${mime};base64,${bytesToB64(bytes)}\n`));
      }
      break;
    }
  }
  throw new Error(`${KINDS[item.kind].label} to ${def.label} is not wired up`);
}

export async function convertCombined(items, target, opts, onProgress){
  const plan = canCombine(items, target);
  if (!plan) throw new Error("these files cannot be combined into " + TARGETS[target].label);
  const { hub, eligible } = plan;
  const def = TARGETS[target];
  const name = safeName(opts.combineName || "combined") + (def.ext ? "." + def.ext : "");
  const one = bytes => [{ name, bytes, mime: MIME[target] || "application/octet-stream" }];

  const values = [];
  for (const [i, it] of eligible.entries()){
    onProgress && onProgress(i, it);
    values.push({ item: it, value: await getHub(it, hub, opts) });
  }

  if (hub === "bytes"){
    const members = values.map(v => ({ name: safeName(v.item.file.name), bytes: v.value }));
    const seen = new Map();
    for (const m of members){
      if (seen.has(m.name)){
        const n = seen.get(m.name) + 1;
        seen.set(m.name, n);
        const dot = m.name.lastIndexOf(".");
        m.name = dot > 0 ? `${m.name.slice(0, dot)}-${n}${m.name.slice(dot)}` : `${m.name}-${n}`;
      } else seen.set(m.name, 1);
    }
    if (target === "zip") return one(await zipWrite(members));
    if (target === "tar") return one(tarWrite(members));
    if (target === "tgz") return one(await gzip(tarWrite(members)));
    if (target === "sevenz" || target === "txz" || target === "tbz2") return one(await sevenCreate(members, target, opts));
  }

  if (hub === "raster" || hub === "anim"){
    const frames = [];
    for (const v of values){
      if (hub === "anim"){
        for (const f of v.value) frames.push(f);
      } else {
        frames.push({ canvas: resizeCanvas(v.value, opts.imgMax || 0, null), delay: +opts.gifDelay || 100 });
      }
    }
    if (target === "pdf") return one(await imagesToPdf(frames.map(f => f.canvas), opts));
    if (target === "pptx"){
      const slides = [];
      for (const f of frames) slides.push(await canvasSlide(f.canvas, false));
      return one(await slidesToPptx(slides));
    }
    if (target === "gif"){
      const w = frames[0].canvas.width, h = frames[0].canvas.height;
      const norm = frames.map(f => {
        if (f.canvas.width === w && f.canvas.height === h) return f;
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext("2d");
        if (opts.gifBg !== "none"){ ctx.fillStyle = opts.gifBg || "#ffffff"; ctx.fillRect(0, 0, w, h); }
        const scale = Math.min(w / f.canvas.width, h / f.canvas.height);
        const dw = Math.round(f.canvas.width * scale), dh = Math.round(f.canvas.height * scale);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(f.canvas, Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh);
        return { canvas: c, delay: f.delay };
      });
      return one(await framesToGif(norm, opts));
    }
  }

  if (hub === "table"){
    const sheets = [];
    const used = new Map();
    for (const v of values){
      const base = baseName(v.item.file.name);
      for (const sh of v.value){
        let nm = v.value.length > 1 ? `${base} ${sh.name || ""}`.trim() : base;
        if (used.has(nm)){
          const n = used.get(nm) + 1;
          used.set(nm, n);
          nm = `${nm} (${n})`;
        } else used.set(nm, 1);
        sheets.push({ ...sh, name: nm.slice(0, 31) });
      }
    }
    if (target === "xlsx") return one(await sheetsToXlsx(sheets));
    if (target === "ods")  return one(await sheetsToOds(sheets));
    if (target === "sql")  return one(enc.encode(sheetsToSql(sheets, opts)));
    if (target === "json"){
      return one(enc.encode(JSON.stringify(
        Object.fromEntries(sheets.map(s => [s.name, tableToObjects(s)])), null,
        opts.jsonPretty === false ? 0 : 2) + "\n"));
    }
    if (target === "csv" || target === "tsv"){
      const delim = target === "tsv" ? "\t" : (opts.delimOut || ",");
      const sig = sheets[0].headers.join("\u0000");
      const uniform = sheets.every(s => s.headers.join("\u0000") === sig);
      if (uniform){
        const merged = [{ name: "combined", headers: sheets[0].headers, rows: sheets.flatMap(s => s.rows) }];
        if (opts.combineSource !== false){
          merged[0] = {
            name: "combined",
            headers: [...sheets[0].headers, "source"],
            rows: sheets.flatMap(s => s.rows.map(r => [...r, s.name]))
          };
        }
        return one(enc.encode(sheetsToDelimited(merged, delim, opts.writeHeader)));
      }
      return one(enc.encode(sheetsToDelimited(sheets, delim, opts.writeHeader)));
    }
  }

  if (hub === "rich"){
    const bodies = values.map(v => {
      const doc = new DOMParser().parseFromString(v.value, "text/html");
      doc.querySelectorAll("script,style,head,noscript").forEach(n => n.remove());
      const inner = doc.body ? doc.body.innerHTML.trim() : "";
      const title = baseName(v.item.file.name);
      const hasTop = /^\s*<h1[\s>]/i.test(inner);
      return (opts.combineHeadings === false || hasTop ? "" : `<h1>${escHtml(title)}</h1>\n`) + inner;
    });
    const joined = bodies.join("\n<hr>\n");
    const html = htmlDoc(opts.combineName || "Combined", joined);
    const out = await emitRich(html, target, opts, one);
    if (out) return out;
  }

  throw new Error(`combining into ${def.label} is not wired up`);
}
