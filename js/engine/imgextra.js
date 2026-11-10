// More picture formats: the preview inside a camera RAW file, the flattened
// picture inside layered files, and the AVIF, JPEG XL and ICNS writers.

import { bitmapToCanvas, canvasRGBA } from "./canvas.js";
import { ZipReader } from "./containers.js";
import { useModule } from "./modules.js";
import { concatBytes } from "./util.js";

// Camera RAW files carry a finished JPEG next to the sensor data. The largest
// one is what file browsers show, and it is what comes out here.
export async function rawPreview(blob){
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const starts = [];
  for (let i = 0; i + 3 < u8.length && starts.length < 32; i++){
    if (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff && (u8[i + 3] === 0xe0 || u8[i + 3] === 0xe1 || u8[i + 3] === 0xdb)) starts.push(i);
  }
  let best = null;
  for (const at of starts){
    try {
      const bmp = await createImageBitmap(new Blob([u8.subarray(at)], { type: "image/jpeg" }));
      if (!best || bmp.width * bmp.height > best.width * best.height){ if (best) best.close(); best = bmp; }
      else bmp.close();
    } catch (e){ /* sensor data that happens to start like a JPEG */ }
  }
  if (!best) throw new Error("no preview picture was found inside this RAW file");
  return bitmapToCanvas(best);
}

const INNER = {
  ora: ["mergedimage.png"],
  kra: ["mergedimage.png", "preview.png"],
  iwork: ["preview.jpg", "preview-web.jpg", "QuickLook/Thumbnail.jpg", "QuickLook/Thumbnail.png", "preview-micro.jpg"]
};

// Layered and document bundles keep a flattened picture of themselves.
export async function bundlePicture(blob, kind){
  const z = new ZipReader(blob);
  await z.open();
  for (const name of INNER[kind] || []){
    const e = z.find(name);
    if (!e) continue;
    const bytes = await z.bytes(e);
    return bitmapToCanvas(await createImageBitmap(new Blob([bytes])));
  }
  throw new Error("this file holds no flattened picture to read");
}

export async function avifEncode(canvas, quality, opts){
  const mod = await useModule("avifenc", opts);
  const out = mod.encode(canvasRGBA(canvas), canvas.width, canvas.height, {
    quality: Math.round((quality || 0.6) * 100), qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0,
    speed: 7, subsample: 1, chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false, bitDepth: 8, lossless: false
  });
  if (!out) throw new Error("the AVIF encoder gave no output");
  return new Uint8Array(out).slice();
}

export async function jxlEncode(canvas, quality, opts){
  const mod = await useModule("jxlenc", opts);
  const q = Math.round((quality || 0.8) * 100);
  const out = mod.encode(canvasRGBA(canvas), canvas.width, canvas.height, {
    effort: 5, quality: q, progressive: false, epf: -1, lossyPalette: false, decodingSpeedTier: 0,
    photonNoiseIso: 0, lossyModular: false, lossless: q >= 100
  });
  if (!out) throw new Error("the JPEG XL encoder gave no output");
  return new Uint8Array(out).slice();
}

// macOS icon: the same picture as PNG at each standard size up to the source's own.
const ICNS_SIZES = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]];
export async function icnsEncode(canvas){
  const longest = Math.max(canvas.width, canvas.height);
  const parts = [];
  for (const [type, size] of ICNS_SIZES){
    if (size > Math.max(128, longest)) continue;
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const k = size / longest, w = canvas.width * k, h = canvas.height * k;
    ctx.drawImage(canvas, (size - w) / 2, (size - h) / 2, w, h);
    const png = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    const head = new Uint8Array(8);
    for (let i = 0; i < 4; i++) head[i] = type.charCodeAt(i);
    new DataView(head.buffer).setUint32(4, png.length + 8);
    parts.push(head, png);
  }
  const body = concatBytes(parts);
  const head = new Uint8Array(8);
  head.set([0x69, 0x63, 0x6e, 0x73]);
  new DataView(head.buffer).setUint32(4, body.length + 8);
  return concatBytes([head, body]);
}
