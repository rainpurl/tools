// Pixel work on canvases: crop, turn, trim, key out a colour, trace a background.

import { MAX_AREA, MAX_DIM, canvasRGBA, resizeCanvas } from "./canvas.js";
import { canvasToBytes, loadRaster } from "./raster.js";

export function cloneCanvas(c){
  const o = new OffscreenCanvas(c.width, c.height);
  o.getContext("2d").drawImage(c, 0, 0);
  return o;
}

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

export const hexOf = (r, g, b) => "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");

export const rgbOf = hex => {
  const m = String(hex).trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return [255, 255, 255];
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

export function opCrop(src, r){
  const x = clamp(Math.round(r.x), 0, src.width - 1), y = clamp(Math.round(r.y), 0, src.height - 1);
  const w = clamp(Math.round(r.w), 1, src.width - x), h = clamp(Math.round(r.h), 1, src.height - y);
  if (x === 0 && y === 0 && w === src.width && h === src.height) return null;
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

export function opRotate90(src, dir){
  const c = new OffscreenCanvas(src.height, src.width);
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(dir * Math.PI / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function opFlip(src, horizontal){
  const c = new OffscreenCanvas(src.width, src.height);
  const ctx = c.getContext("2d");
  if (horizontal){ ctx.translate(src.width, 0); ctx.scale(-1, 1); }
  else { ctx.translate(0, src.height); ctx.scale(1, -1); }
  ctx.drawImage(src, 0, 0);
  return c;
}

export function opRotate(src, deg, expand){
  if (!(deg % 360)) return null;
  const r = deg * Math.PI / 180;
  const cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
  const W = expand ? Math.ceil(src.width * cos + src.height * sin) : src.width;
  const H = expand ? Math.ceil(src.width * sin + src.height * cos) : src.height;
  if (W * H > MAX_AREA) throw new Error("the rotated image would be too large for a canvas");
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.translate(W / 2, H / 2);
  ctx.rotate(r);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function opTrim(src){
  const w = src.width, h = src.height;
  const px = canvasRGBA(src);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      if (px[(y * w + x) * 4 + 3] > 8){
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("the image is fully transparent");
  return opCrop(src, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}

export const MAX_RGB_DIST = Math.sqrt(3 * 255 * 255);

export const cdist = (px, i, k) => {
  const dr = px[i] - k[0], dg = px[i + 1] - k[1], db = px[i + 2] - k[2];
  return Math.sqrt(dr * dr + dg * dg + db * db) / MAX_RGB_DIST * 100;
};

export const keep = (d, tol, soft) => d <= tol ? 0 : (soft > 0 && d < tol + soft) ? (d - tol) / soft : 1;

export function unmixPixel(px, i, k, f){
  for (let c = 0; c < 3; c++) px[i + c] = clamp(Math.round((px[i + c] - k[c] * (1 - f)) / f), 0, 255);
}

export function applyKeep(px, i, k, f){
  if (f >= 1) return;
  if (f <= 0.004){ px[i + 3] = 0; return; }
  unmixPixel(px, i, k, f);
  px[i + 3] = Math.round(px[i + 3] * f);
}

export function floodKey(px, w, h, seeds, distOf, keyOf, tol, soft){
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (const s of seeds) if (!seen[s]){ seen[s] = 1; stack.push(s); }
  let removed = 0;
  while (stack.length){
    const p = stack.pop();
    const i = p * 4;
    const clear = px[i + 3] < 8;
    const d = clear ? 0 : distOf(px, i);
    const f = clear ? 0 : keep(d, tol, soft);
    if (f >= 1) continue;
    if (!clear){ applyKeep(px, i, keyOf(px, i), f); removed++; }
    if (d > tol) continue;
    const x = p % w, y = (p / w) | 0;
    if (x > 0 && !seen[p - 1]){ seen[p - 1] = 1; stack.push(p - 1); }
    if (x < w - 1 && !seen[p + 1]){ seen[p + 1] = 1; stack.push(p + 1); }
    if (y > 0 && !seen[p - w]){ seen[p - w] = 1; stack.push(p - w); }
    if (y < h - 1 && !seen[p + w]){ seen[p + w] = 1; stack.push(p + w); }
  }
  return removed;
}

export function borderSeeds(w, h){
  const s = [];
  for (let x = 0; x < w; x++){ s.push(x); s.push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++){ s.push(y * w); s.push(y * w + w - 1); }
  return s;
}

export function opRemoveColor(src, key, tol, soft, mode, seed){
  const w = src.width, h = src.height;
  const c = cloneCanvas(src);
  const ctx = c.getContext("2d");
  const id = ctx.getImageData(0, 0, w, h);
  const px = id.data;
  let removed = 0;
  if (mode === "all"){
    for (let i = 0; i < px.length; i += 4){
      if (px[i + 3] === 0) continue;
      const f = keep(cdist(px, i, key), tol, soft);
      if (f < 1){ applyKeep(px, i, key, f); removed++; }
    }
  } else {
    let seeds;
    if (mode === "point"){
      if (!seed) throw new Error("pick a point on the image first");
      seeds = [clamp(Math.floor(seed.y), 0, h - 1) * w + clamp(Math.floor(seed.x), 0, w - 1)];
    } else seeds = borderSeeds(w, h);
    removed = floodKey(px, w, h, seeds, (p, i) => cdist(p, i, key), () => key, tol, soft);
  }
  if (!removed) return null;
  ctx.putImageData(id, 0, 0);
  return c;
}

export function borderPalette(px, w, h){
  const counts = new Map();
  const seeds = borderSeeds(w, h);
  for (const p of seeds){
    const i = p * 4;
    if (px[i + 3] < 8) continue;
    const k = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
    const e = counts.get(k);
    if (e){ e.n++; e.r += px[i]; e.g += px[i + 1]; e.b += px[i + 2]; }
    else counts.set(k, { n: 1, r: px[i], g: px[i + 1], b: px[i + 2] });
  }
  const list = [...counts.values()].sort((a, b) => b.n - a.n);
  if (!list.length) return [];
  const total = seeds.length;
  const pick = list.filter((e, i) => i === 0 || e.n >= total * 0.05).slice(0, 4);
  return pick.map(e => [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)]);
}

export function opRemoveBgEdges(src, tol, soft, notify){
  const w = src.width, h = src.height;
  const c = cloneCanvas(src);
  const ctx = c.getContext("2d");
  const id = ctx.getImageData(0, 0, w, h);
  const px = id.data;
  const refs = borderPalette(px, w, h);
  if (!refs.length) throw new Error("the edges are already transparent");
  const nearest = (p, i) => {
    let best = refs[0], bd = Infinity;
    for (const r of refs){ const d = cdist(p, i, r); if (d < bd){ bd = d; best = r; } }
    return { d: bd, r: best };
  };
  const removed = floodKey(px, w, h, borderSeeds(w, h),
    (p, i) => nearest(p, i).d, (p, i) => nearest(p, i).r, tol, soft);
  if (!removed) return null;
  ctx.putImageData(id, 0, 0);
  if (notify) notify(`      background traced from ${refs.map(r => hexOf(...r)).join(", ")}`);
  return c;
}

// Pixel jobs by name, so a worker can be asked for one.
export const PIXEL_OPS = {
  trim: src => opTrim(src),
  removeColor: (src, p) => opRemoveColor(src, p.key, p.tol, p.soft, p.mode, p.seed),
  removeBgEdges: (src, p, notify) => opRemoveBgEdges(src, p.tol, p.soft, notify)
};

/* --------------------------------------------------------------------------
   Batch jobs: resize, re-encode and name one image. Runs in a worker when it
   can, and on the page for the formats that need the document.
   -------------------------------------------------------------------------- */

// Halve repeatedly before the last step. One big jump drops detail that
// several small ones keep.
export function scaleCanvas(src, w, h){
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (w === src.width && h === src.height) return src;
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h){
    const half = new OffscreenCanvas(Math.max(1, cur.width >> 1), Math.max(1, cur.height >> 1));
    const hx = half.getContext("2d");
    hx.imageSmoothingQuality = "high";
    hx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

// Work out the output size, and the source crop when the job fills a box.
export function planSize(w, h, s){
  const n = v => Math.max(0, +v || 0);
  let scale = 1, crop = null, tw, th;
  switch (s.mode){
    case "long":    if (n(s.size)) scale = n(s.size) / Math.max(w, h); break;
    case "width":   if (n(s.width)) scale = n(s.width) / w; break;
    case "height":  if (n(s.height)) scale = n(s.height) / h; break;
    case "percent": if (n(s.percent)) scale = n(s.percent) / 100; break;
    case "box":
      if (n(s.width) && n(s.height)) scale = Math.min(n(s.width) / w, n(s.height) / h);
      break;
    case "fill": {
      const bw = n(s.width), bh = n(s.height);
      if (bw && bh){
        scale = Math.max(bw / w, bh / h);
        if (s.noEnlarge !== false && scale > 1) scale = 1;
        tw = Math.min(bw, Math.round(w * scale)); th = Math.min(bh, Math.round(h * scale));
        const cw = tw / scale, ch = th / scale;
        crop = { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
      }
      break;
    }
    default: break;
  }
  if (s.noEnlarge !== false && scale > 1) scale = 1;
  if (!crop){ tw = Math.round(w * scale); th = Math.round(h * scale); }
  tw = clamp(tw, 1, MAX_DIM); th = clamp(th, 1, MAX_DIM);
  return { w: tw, h: th, crop };
}

function hasAlpha(canvas){
  const px = canvasRGBA(canvas);
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return true;
  return false;
}

const BATCH_EXT = { jpeg: "jpg", png: "png", webp: "webp" };

export async function processImage(file, kind, s, opts){
  const src = await loadRaster(file, kind, opts || {});
  const srcW = src.width, srcH = src.height;
  const plan = planSize(srcW, srcH, s);
  let base = src;
  if (plan.crop){
    const c = plan.crop;
    base = new OffscreenCanvas(Math.max(1, Math.round(c.w)), Math.max(1, Math.round(c.h)));
    base.getContext("2d").drawImage(src, c.x, c.y, c.w, c.h, 0, 0, base.width, base.height);
  }
  let canvas = scaleCanvas(base, plan.w, plan.h);

  let fmt = s.format;
  if (fmt === "keep") fmt = BATCH_EXT[kind] ? kind : (hasAlpha(canvas) ? "png" : "jpeg");
  const flat = c => fmt === "jpeg" ? resizeCanvas(c, 0, s.background || "#ffffff") : c;

  let quality = clamp(+s.quality || 0.82, 0.05, 1);
  let bytes = await canvasToBytes(flat(canvas), fmt, quality);
  const target = Math.max(0, +s.targetKb || 0) * 1024;

  if (target && bytes.length > target){
    if (fmt !== "png"){
      // lower the quality first: six halvings land within about one percent
      let lo = 0.2, hi = quality, best = null;
      for (let i = 0; i < 6; i++){
        const mid = (lo + hi) / 2;
        const b = await canvasToBytes(flat(canvas), fmt, mid);
        if (b.length <= target){ best = { b, q: mid }; lo = mid; } else hi = mid;
      }
      if (!best){
        const b = await canvasToBytes(flat(canvas), fmt, 0.2);
        if (b.length <= target) best = { b, q: 0.2 };
        else { bytes = b; quality = 0.2; }
      }
      if (best){ bytes = best.b; quality = best.q; }
    }
    // then give up pixels, a little at a time
    for (let i = 0; i < 6 && bytes.length > target && Math.min(canvas.width, canvas.height) > 16; i++){
      const k = Math.max(0.5, Math.min(0.9, Math.sqrt(target / bytes.length)));
      canvas = scaleCanvas(canvas, canvas.width * k, canvas.height * k);
      bytes = await canvasToBytes(flat(canvas), fmt, quality);
    }
  }
  return {
    bytes, ext: BATCH_EXT[fmt], mime: "image/" + fmt, format: fmt, quality,
    w: canvas.width, h: canvas.height, srcW, srcH, missed: !!target && bytes.length > target
  };
}
