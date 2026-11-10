// Decode anything image shaped to a canvas, and encode a canvas back out.

import { framesToGif } from "./anim.js";
import { MAX_AREA, MAX_DIM, bitmapToCanvas, canvasRGBA, vectorScale } from "./canvas.js";
import {
  ddsDecode,
  farbfeldDecode,
  hdrDecode,
  icnsEntries,
  pcxDecode,
  pfmDecode,
  pnmDecode,
  pnmEncode,
  psdDecode,
  qoiDecode,
  qoiEncode,
  rasDecode,
  sgiDecode,
  tgaDecode,
  tgaEncode,
  tiffDecode,
  tiffEncode,
  wbmpDecode,
  xbmDecode,
  xbmEncode,
  xpmDecode
} from "./codecs.js";
import { useModule } from "./modules.js";
import { MIME } from "./registry.js";
import { bytesToB64, concatBytes, decodeText, deflateZlib, enc, latin1 } from "./util.js";

export async function svgRender(text, opts){
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length || !svg || svg.localName !== "svg")
    throw new Error("svg could not be parsed");
  const UNIT = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 };
  const len = s => {
    const m = String(s || "").trim().match(/^([\d.]+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?$/i);
    if (!m) return 0;
    const u = (m[2] || "px").toLowerCase();
    return u === "%" ? 0 : parseFloat(m[1]) * UNIT[u];
  };
  let w = len(svg.getAttribute("width")), h = len(svg.getAttribute("height"));
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  if (hasVb){
    if (!w && !h){ w = vb[2]; h = vb[3]; }
    else if (!w) w = h * vb[2] / vb[3];
    else if (!h) h = w * vb[3] / vb[2];
  }
  w = w || 1024; h = h || 1024;
  if (!hasVb) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const target = opts && opts.vecSize !== undefined ? +opts.vecSize : 4096;
  const s = vectorScale(w, h, target);
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  const out = new XMLSerializer().serializeToString(doc);
  const url = URL.createObjectURL(new Blob([out], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("svg could not be rendered"));
      img.src = url;
    });
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, W, H);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

export async function loadRaster(blob, kind, opts){
  opts = opts || {};
  if (kind === "svg") return svgRender(decodeText(new Uint8Array(await blob.arrayBuffer())), opts);
  if (kind === "eps") return epsRender(new Uint8Array(await blob.arrayBuffer()), opts);
  if (kind === "heic" || kind === "jxl"){
    try { return bitmapToCanvas(await createImageBitmap(blob)); } catch (e){ /* use module */ }
    if (kind === "heic"){
      const heic2any = await useModule("heif", opts);
      let out = await heic2any({ blob: new Blob([blob], { type: "image/heic" }), toType: "image/png" });
      if (Array.isArray(out)) out = out[0];
      return bitmapToCanvas(await createImageBitmap(out));
    }
    const decode = await useModule("jxl", opts);
    const id = await decode(await blob.arrayBuffer());
    const c = new OffscreenCanvas(id.width, id.height);
    c.getContext("2d").putImageData(id, 0, 0);
    return c;
  }
  if (kind === "dds") return ddsDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "sgi") return sgiDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "ras") return rasDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "hdr") return hdrDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "pfm") return pfmDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "farbfeld") return farbfeldDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "wbmp") return wbmpDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "psd") return psdDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "xbm") return xbmDecode(await blob.text());
  if (kind === "xpm") return xpmDecode(await blob.text());
  if (kind === "tiff") return tiffDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "tga")  return tgaDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "pnm")  return pnmDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "qoi")  return qoiDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "pcx")  return pcxDecode(new Uint8Array(await blob.arrayBuffer()));
  if (kind === "icns"){
    const list = icnsEntries(new Uint8Array(await blob.arrayBuffer())).filter(e => e.ext === "png");
    if (!list.length) throw new Error("this icns has no png entries");
    const biggest = list.reduce((a, b) => b.bytes.length > a.bytes.length ? b : a);
    blob = new Blob([biggest.bytes], { type: "image/png" });
  }
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e){
    throw new Error("this browser could not decode the image");
  }
  return bitmapToCanvas(bmp);
}

export async function canvasToBytes(canvas, target, quality){
  if (target === "bmp") return bmpEncode(canvas);
  if (target === "ico") return icoEncode(canvas);
  if (target === "tiff") return tiffEncode(canvas);
  if (target === "xbm") return xbmEncode(canvas, "image");
  if (target === "tga") return tgaEncode(canvas);
  if (target === "ppm") return pnmEncode(canvas, false);
  if (target === "pgm") return pnmEncode(canvas, true);
  if (target === "qoi") return qoiEncode(canvas);
  if (target === "eps") return epsEncode(canvas);
  if (target === "svg") return svgWrap(canvas);
  if (target === "gif") return framesToGif([{ canvas, delay: 100 }], { gifColors: 256 });
  const type = MIME[target] || "image/png";
  const blob = await canvas.convertToBlob({ type, quality: quality });
  if (blob.type !== type && target !== "png"){
    throw new Error("this browser cannot encode " + target.toUpperCase());
  }
  return new Uint8Array(await blob.arrayBuffer());
}

export function bmpEncode(canvas){
  const { width: w, height: h } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  const rowSize = Math.floor((24 * w + 31) / 32) * 4;
  const pixSize = rowSize * h;
  const out = new Uint8Array(54 + pixSize);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, pixSize, true);
  dv.setInt32(38, 2835, true);
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++){
    let p = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++){
      const i = (y * w + x) * 4;
      const a = data[i + 3] / 255;
      out[p++] = Math.round(data[i + 2] * a + 255 * (1 - a));
      out[p++] = Math.round(data[i + 1] * a + 255 * (1 - a));
      out[p++] = Math.round(data[i]     * a + 255 * (1 - a));
    }
  }
  return out;
}

export async function icoEncode(canvas){
  const sizes = [256, 128, 64, 48, 32, 16].filter(s => s <= Math.max(canvas.width, canvas.height) || s <= 64);
  const imgs = [];
  for (const s of sizes){
    const c = new OffscreenCanvas(s, s);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const scale = Math.min(s / canvas.width, s / canvas.height);
    const w = Math.round(canvas.width * scale), h = Math.round(canvas.height * scale);
    ctx.drawImage(canvas, Math.floor((s - w) / 2), Math.floor((s - h) / 2), w, h);
    const blob = await c.convertToBlob({ type: "image/png" });
    imgs.push({ size: s, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  const head = new Uint8Array(6 + imgs.length * 16);
  const dv = new DataView(head.buffer);
  dv.setUint16(2, 1, true);
  dv.setUint16(4, imgs.length, true);
  let offset = head.length;
  imgs.forEach((im, i) => {
    const o = 6 + i * 16;
    head[o] = im.size >= 256 ? 0 : im.size;
    head[o + 1] = im.size >= 256 ? 0 : im.size;
    dv.setUint16(o + 4, 1, true);
    dv.setUint16(o + 6, 32, true);
    dv.setUint32(o + 8, im.bytes.length, true);
    dv.setUint32(o + 12, offset, true);
    offset += im.bytes.length;
  });
  return concatBytes([head, ...imgs.map(i => i.bytes)]);
}

export function ascii85(u8){
  const out = [];
  let line = "";
  const push = s => {
    line += s;
    while (line.length >= 76){ out.push(line.slice(0, 76)); line = line.slice(76); }
  };
  for (let i = 0; i < u8.length; i += 4){
    const n = Math.min(4, u8.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? u8[i + k] : 0);
    if (n === 4 && v === 0){ push("z"); continue; }
    const c = new Array(5);
    for (let k = 4; k >= 0; k--){ c[k] = String.fromCharCode(33 + (v % 85)); v = Math.floor(v / 85); }
    push(c.join("").slice(0, n + 1));
  }
  push("~>");
  if (line) out.push(line);
  return out.join("\n");
}

export async function epsEncode(canvas){
  const w = canvas.width, h = canvas.height;
  const px = canvasRGBA(canvas);
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3){
    const a = px[i + 3] / 255;
    rgb[j]     = Math.round(px[i]     * a + 255 * (1 - a));
    rgb[j + 1] = Math.round(px[i + 1] * a + 255 * (1 - a));
    rgb[j + 2] = Math.round(px[i + 2] * a + 255 * (1 - a));
  }
  const data = ascii85(await deflateZlib(rgb));
  const head = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 ${w} ${h}
%%HiResBoundingBox: 0 0 ${w} ${h}
%%Creator: convert.html
%%LanguageLevel: 2
%%Pages: 1
%%EndComments
%%Page: 1 1
gsave
/DeviceRGB setcolorspace
${w} ${h} scale
<< /ImageType 1 /Width ${w} /Height ${h} /BitsPerComponent 8 /Decode [0 1 0 1 0 1]
   /ImageMatrix [${w} 0 0 -${h} 0 ${h}]
   /DataSource currentfile /ASCII85Decode filter /FlateDecode filter >> image
`;
  return enc.encode(head + data + "\ngrestore\nshowpage\n%%EOF\n");
}

export async function svgWrap(canvas){
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));
  const w = canvas.width, h = canvas.height;
  return enc.encode(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<image width="${w}" height="${h}" xlink:href="data:image/png;base64,${b64}"/>
</svg>
`);
}

export function epsSections(u8){
  if (u8[0] === 0xc5 && u8[1] === 0xd0 && u8[2] === 0xd3 && u8[3] === 0xc6){
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const psOff = dv.getUint32(4, true), psLen = dv.getUint32(8, true);
    const tifOff = dv.getUint32(20, true), tifLen = dv.getUint32(24, true);
    return {
      ps: u8.subarray(psOff, psOff + psLen),
      tiff: tifLen && tifOff + tifLen <= u8.length ? u8.subarray(tifOff, tifOff + tifLen) : null
    };
  }
  return { ps: u8, tiff: null };
}

export function epsBBox(ps){
  const scan = text => {
    for (const re of [/%%HiResBoundingBox:\s*([-+\d.eE\s]+)/g, /%%BoundingBox:\s*([-+\d.eE\s]+)/g]){
      for (const m of text.matchAll(re)){
        const n = m[1].trim().split(/\s+/).slice(0, 4).map(Number);
        if (n.length === 4 && n.every(Number.isFinite) && n[2] > n[0] && n[3] > n[1]) return n;
      }
    }
    return null;
  };
  return scan(latin1.decode(ps.subarray(0, Math.min(ps.length, 262144)))) ||
         scan(latin1.decode(ps.subarray(Math.max(0, ps.length - 65536))));
}

export async function runGhostscript(input, args, opts){
  const gs = await useModule("ghostscript", opts);
  const errs = [];
  const mod = await gs.factory({
    wasmBinary: gs.wasmBinary,
    noInitialRun: true,
    print: () => {},
    printErr: s => errs.push(s),
    locateFile: f => gs.base + f
  });
  mod.FS.writeFile("/in.ps", input);
  try { mod.callMain(args); }
  catch (e){
    if (!(e && (e.name === "ExitStatus" || typeof e.status === "number"))) throw e;
  }
  const names = mod.FS.readdir("/").filter(n => /^out/.test(n)).sort();
  const outs = names.map(n => mod.FS.readFile("/" + n));
  if (!outs.length || !outs[0].length){
    const why = errs.filter(s => s.trim()).slice(-3).join(" ").slice(0, 300);
    throw new Error("Ghostscript produced no output" + (why ? ": " + why : ""));
  }
  return outs;
}

export async function epsRender(u8, opts){
  const { ps, tiff } = epsSections(u8);
  const isEps = /EPSF/.test(latin1.decode(ps.subarray(0, 80)));
  let failure = null;
  if (opts.allowModules !== false){
    try {
      const bb = epsBBox(ps);
      const wPt = bb ? bb[2] - bb[0] : 612, hPt = bb ? bb[3] - bb[1] : 792;
      const target = opts.vecSize !== undefined ? +opts.vecSize : 4096;
      const wIn = wPt / 72, hIn = hPt / 72;
      let dpi = target ? target / Math.max(wIn, hIn) : 96;
      dpi = Math.min(dpi, MAX_DIM / Math.max(wIn, hIn), Math.sqrt(MAX_AREA / (wIn * hIn)), 4800);
      dpi = Math.max(10, dpi);
      const args = ["-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pngalpha",
        "-r" + dpi.toFixed(3), "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
        "-dFirstPage=1", "-dLastPage=1"];
      if (isEps || bb) args.push("-dEPSCrop");
      args.push("-sOutputFile=/out.png", "/in.ps");
      const [png] = await runGhostscript(ps, args, opts);
      return bitmapToCanvas(await createImageBitmap(new Blob([png], { type: "image/png" })));
    } catch (e){ failure = e; }
  }
  if (tiff){
    try { return tiffDecode(tiff); } catch (e){ /* report error */ }
  }
  if (failure) throw new Error("could not render this PostScript: " + failure.message);
  throw new Error("rendering EPS needs the optional Ghostscript module");
}

export async function epsToPdf(u8, opts){
  const { ps } = epsSections(u8);
  const isEps = /EPSF/.test(latin1.decode(ps.subarray(0, 80)));
  const args = ["-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pdfwrite"];
  if (isEps) args.push("-dEPSCrop");
  args.push("-sOutputFile=/out.pdf", "/in.ps");
  return (await runGhostscript(ps, args, opts))[0];
}
