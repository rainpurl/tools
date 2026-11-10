// Work out what a file is from its bytes first and its name second.

import { ZipReader } from "./containers.js";
import { EXT2KIND } from "./registry.js";
import { decodeText, extOf, latin1, utf8 } from "./util.js";

export function sniff(u8){
  const b = u8;
  const has = (o, ...sig) => sig.every((v, i) => b[o + i] === v);
  if (has(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (has(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (has(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (has(0, 0x42, 0x4d)) return "bmp";
  if (has(0, 0x00, 0x00, 0x01, 0x00) || has(0, 0x00, 0x00, 0x02, 0x00)) return "ico";
  if (has(0, 0x52, 0x49, 0x46, 0x46) && has(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  if (has(0, 0x52, 0x49, 0x46, 0x46) && has(8, 0x57, 0x41, 0x56, 0x45)) return "audio";
  if (has(4, 0x66, 0x74, 0x79, 0x70)){
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand.startsWith("avi")) return "avif";
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return "heic";
    if (brand === "mif1" || brand === "msf1"){
      const brands = latin1.decode(b.subarray(8, Math.min(b.length, 64)));
      return /avi[fs]/.test(brands) ? "avif" : "heic";
    }
    if (brand === "M4A " || brand.startsWith("mp4") || brand.startsWith("isom")) return "audio";
  }
  if (has(0, 0xff, 0x0a) || has(0, 0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20)) return "jxl";
  if (has(0, 0x25, 0x50, 0x44, 0x46)) return "pdf";
  if (has(0, 0xc5, 0xd0, 0xd3, 0xc6) || has(0, 0x25, 0x21, 0x50, 0x53)) return "eps";
  if (has(0, 0x44, 0x44, 0x53, 0x20)) return "dds";
  if (has(0, 0x59, 0xa6, 0x6a, 0x95)) return "ras";
  if (has(0, 0x01, 0xda) && (b[2] === 0 || b[2] === 1) && (b[3] === 1 || b[3] === 2)) return "sgi";
  if (latin1.decode(b.subarray(0, 8)) === "farbfeld") return "farbfeld";
  if (/^#\?(RADIANCE|RGBE)/.test(latin1.decode(b.subarray(0, 12)))) return "hdr";
  if (b[0] === 0x50 && (b[1] === 0x46 || b[1] === 0x66) && (b[2] === 0x0a || b[2] === 0x0d || b[2] === 0x20)) return "pfm";
  if (has(0, 0x49, 0x49, 0x2a, 0x00) || has(0, 0x4d, 0x4d, 0x00, 0x2a)) return "tiff";
  if (has(0, 0x71, 0x6f, 0x69, 0x66)) return "qoi";
  if (has(0, 0x69, 0x63, 0x6e, 0x73)) return "icns";
  if (has(0, 0x38, 0x42, 0x50, 0x53)) return "psd";
  if (utf8.decode(b.subarray(0, 15)) === "SQLite format 3") return "sqlite";
  if (utf8.decode(b.subarray(0, 6)) === "bplist") return "bplist";
  if (b[0] === 0x0a && b[2] === 0x01 && (b[1] === 0 || b[1] === 2 || b[1] === 3 || b[1] === 5)) return "pcx";
  if (b[0] === 0x50 && b[1] >= 0x31 && b[1] <= 0x36 && (b[2] === 0x0a || b[2] === 0x20 || b[2] === 0x09 || b[2] === 0x0d)) return "pnm";
  if (has(0, 0x1f, 0x8b)) return "gz";
  if (has(0, 0x49, 0x44, 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio";
  if (has(0, 0x66, 0x4c, 0x61, 0x43)) return "audio";
  if (has(0, 0x4f, 0x67, 0x67, 0x53)) return "audio";
  if (has(0, 0x7b, 0x5c, 0x72, 0x74)) return "rtf";
  if (b.length > 262 && has(257, 0x75, 0x73, 0x74, 0x61, 0x72)) return "tar";
  if (has(0, 0x50, 0x4b, 0x03, 0x04)) return "zipish";
  return null;
}

export async function detectKind(file, head){
  const ext = extOf(file.name);
  const byExt = EXT2KIND.get(ext);
  const magic = sniff(head);

  if (magic === "zipish"){
    if (byExt && ["docx","pptx","xlsx","odt","ods","odp","epub","kmz","zip"].includes(byExt)) return byExt;
    try {
      const z = new ZipReader(file);
      await z.open();
      const mt = z.find("mimetype");
      if (mt){
        const t = (await z.text(mt)).trim();
        if (t === "application/epub+zip") return "epub";
        if (t === "application/vnd.oasis.opendocument.text") return "odt";
        if (t === "application/vnd.oasis.opendocument.spreadsheet") return "ods";
        if (t === "application/vnd.oasis.opendocument.presentation") return "odp";
      }
      if (z.find("word/document.xml")) return "docx";
      if (z.find("xl/workbook.xml")) return "xlsx";
      if (z.find("ppt/presentation.xml")) return "pptx";
      if (z.find("META-INF/container.xml") || z.entries.some(e => /\.opf$/i.test(e.name))) return "epub";
      if (z.entries.some(e => /\.kml$/i.test(e.name))) return "kmz";
      if (z.find("content.xml")){
        const c = await z.text(z.find("content.xml"));
        if (/office:spreadsheet/.test(c)) return "ods";
        if (/office:presentation/.test(c)) return "odp";
        if (/office:text/.test(c)) return "odt";
      }
    } catch (e){ /* fall through */ }
    return "zip";
  }
  if (magic === "gz" && (ext === "tgz" || /\.tar\.gz$/i.test(file.name))) return "tgz";
  if (ext === "ai" && latin1.decode(head.subarray(0, 4096)).includes("%PDF-")) return "pdf";
  if (head.length > 68){
    const t4 = utf8.decode(head.subarray(60, 68));
    if (/^(BOOK|TEXt)(MOBI|REAd)$/.test(t4)) return "mobi";
  }
  if (head.length >= 84 && (!ext || ext === "stl")){
    const c = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(80, true);
    if (c > 0 && 84 + c * 50 === file.size) return "stl";
  }
  if (magic && magic !== "zipish") return magic;
  if (byExt) return byExt;

  const raw = head.subarray(0, 4096);
  const bom16 = (raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff);
  let nul = 0, ctrl = 0;
  for (const b of raw){
    if (b === 0) nul++;
    else if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  if ((nul && !bom16) || ctrl > raw.length * 0.02) return "bin";
  const txt = decodeText(raw).trim();
  if (!txt) return "bin";
  const bad = (txt.match(/\ufffd/g) || []).length;
  if (bad > txt.length * 0.02) return "bin";
  if (/^<\?xml/i.test(txt)){
    if (/<svg[\s>]/i.test(txt)) return "svg";
    if (/<FictionBook/i.test(txt)) return "fb2";
    if (/<tt[\s>]/i.test(txt)) return "ttml";
    if (/<gpx[\s>]/i.test(txt)) return "gpx";
    if (/<kml[\s>]/i.test(txt)) return "kml";
    return "xml";
  }
  if (/^<(!doctype html|html)[\s>]/i.test(txt)) return "html";
  if (/^[CN]?OFF\s/i.test(txt)) return "off";
  if (/^\s*solid/i.test(txt) && /^\s*facet\s+normal/im.test(txt)) return "stl";
  if (/^v\s+-?[\d.]/m.test(txt) && /^f\s+\d/m.test(txt)) return "obj";
  if (/\/\*\s*XPM\s*\*\//.test(txt)) return "xpm";
  if (/#define\s+\S*_?width\s+\d+/i.test(txt) && /_bits\s*\[\s*\]/.test(txt)) return "xbm";
  if (/^<svg[\s>]/i.test(txt)) return "svg";
  if (/^<gpx[\s>]/i.test(txt)) return "gpx";
  if (/^<kml[\s>]/i.test(txt)) return "kml";
  if (/^[\[{]/.test(txt)){
    if (/"nbformat"\s*:/.test(txt) && /"cells"\s*:/.test(txt)) return "ipynb";
    if (/"type"\s*:\s*"(FeatureCollection|Feature)"/.test(txt)) return "geojson";
    if (/"log"\s*:/.test(txt) && /"entries"\s*:/.test(txt)) return "har";
    return "json";
  }
  if (/^BEGIN:VCALENDAR/im.test(txt)) return "ics";
  if (/^BEGIN:VCARD/im.test(txt)) return "vcf";
  if (/^WEBVTT/.test(txt)) return "vtt";
  if (/\[Script Info\]/i.test(txt) || /\[V4\+? Styles\]/i.test(txt)) return "ass";
  if (/^\s*\{\d+\}\{\d+\}/m.test(txt)) return "subv";
  if (/^\s*\[\d{1,3}:\d{2}([.:]\d{1,3})?\]/m.test(txt)) return "lrc";
  if (/^\s*\d{1,2}:\d{2}:\d{2}\.\d{3},\d{1,2}:\d{2}:\d{2}\.\d{3}\s*$/m.test(txt)) return "sbv";
  if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/m.test(txt)) return "srt";
  if (/content-type:\s*multipart\/related/i.test(txt) && /content-location:/i.test(txt)) return "mhtml";
  if (/^(from|to|subject|date|message-id|received):/im.test(txt) && /\n\n/.test(txt)) return "eml";
  return "txt";
}
