// Animation frames and the GIF writer.

import { canvasRGBA, resizeCanvas } from "./canvas.js";
import { concatBytes, enc } from "./util.js";

export const ANIM_MIME = { gif:"image/gif", webp:"image/webp", avif:"image/avif", png:"image/png" };

export async function decodeFrames(blob, kind, limit){
  if (typeof ImageDecoder === "undefined") throw new Error("this browser has no ImageDecoder");
  const type = ANIM_MIME[kind] || blob.type || "image/gif";
  const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type });
  try {
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    const count = Math.min(track ? track.frameCount : 1, limit || 2000);
    const frames = [];
    let stage = null, ctx = null;
    for (let i = 0; i < count; i++){
      let res;
      try { res = await dec.decode({ frameIndex: i }); }
      catch (e){ break; }
      const img = res.image;
      if (!stage){
        stage = new OffscreenCanvas(img.displayWidth, img.displayHeight);
        ctx = stage.getContext("2d");
      }
      ctx.drawImage(img, 0, 0);
      const snap = new OffscreenCanvas(stage.width, stage.height);
      snap.getContext("2d").drawImage(stage, 0, 0);
      frames.push({ canvas: snap, delay: Math.max(20, Math.round((img.duration || 100000) / 1000)) });
      img.close();
    }
    if (!frames.length) throw new Error("no frames could be decoded");
    return frames;
  } finally {
    dec.close && dec.close();
  }
}

export function medianCutPalette(samples, maxColors){
  if (!samples.length) return [[0, 0, 0]];
  const volume = box => {
    let lo = [255, 255, 255], hi = [0, 0, 0];
    for (const s of box) for (let c = 0; c < 3; c++){
      if (s[c] < lo[c]) lo[c] = s[c];
      if (s[c] > hi[c]) hi[c] = s[c];
    }
    return { span: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
  };
  let boxes = [samples];
  while (boxes.length < maxColors){
    let pick = -1, best = -1;
    for (let i = 0; i < boxes.length; i++){
      if (boxes[i].length < 2) continue;
      const sp = volume(boxes[i]).span;
      const score = Math.max(sp[0], sp[1], sp[2]) * Math.log(boxes[i].length + 1);
      if (score > best){ best = score; pick = i; }
    }
    if (pick < 0 || best <= 0) break;
    const box = boxes[pick];
    const sp = volume(box).span;
    const ch = sp[0] >= sp[1] && sp[0] >= sp[2] ? 0 : (sp[1] >= sp[2] ? 1 : 2);
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = box.length >> 1;
    boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.filter(b => b.length).map(b => {
    let r = 0, g = 0, bl = 0;
    for (const s of b){ r += s[0]; g += s[1]; bl += s[2]; }
    return [Math.round(r / b.length), Math.round(g / b.length), Math.round(bl / b.length)];
  });
}

export function buildQuantizer(frames, maxColors, transparent){
  const room = transparent ? maxColors - 1 : maxColors;
  const samples = [];
  const budget = 24000;
  let totalPx = 0;
  for (const f of frames) totalPx += f.canvas.width * f.canvas.height;
  const step = Math.max(1, Math.floor(totalPx / budget));

  const distinct = new Map();
  let overflow = false;
  let n = 0;
  for (const f of frames){
    const px = canvasRGBA(f.canvas);
    for (let i = 0; i < px.length; i += 4){
      if (px[i + 3] < 128) continue;
      const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      if (!overflow && !distinct.has(key)){
        if (distinct.size >= room) overflow = true;
        else distinct.set(key, [px[i], px[i + 1], px[i + 2]]);
      }
      if (n++ % step === 0) samples.push([px[i], px[i + 1], px[i + 2]]);
    }
  }

  let palette = (!overflow && distinct.size)
    ? Array.from(distinct.values())
    : medianCutPalette(samples, room);
  if (!palette.length) palette = [[0, 0, 0]];
  const transIndex = transparent ? palette.length : -1;
  if (transparent) palette = palette.concat([[0, 0, 0]]);

  const cache = new Int16Array(32768).fill(-1);
  const exact = new Map();
  if (!overflow) palette.forEach((p, i) => { if (i !== transIndex) exact.set((p[0] << 16) | (p[1] << 8) | p[2], i); });
  const nearest = (r, g, b) => {
    if (exact.size){
      const hit = exact.get((r << 16) | (g << 8) | b);
      if (hit !== undefined) return hit;
    }
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const cached = cache[key];
    if (cached >= 0) return cached;
    let best = 0, bestD = Infinity;
    const upto = transparent ? palette.length - 1 : palette.length;
    for (let i = 0; i < upto; i++){
      const p = palette[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const d = dr * dr * 3 + dg * dg * 6 + db * db;
      if (d < bestD){ bestD = d; best = i; }
    }
    cache[key] = best;
    return best;
  };
  return { palette, transIndex, nearest };
}

export function gifLzw(indices, minCodeSize){
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map();
  const bits = [];
  let acc = 0, accBits = 0;
  const emit = code => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8){ bits.push(acc & 255); acc >>= 8; accBits -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++){
    const k = indices[i];
    const key = prefix * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined){ prefix = hit; continue; }
    emit(prefix);
    if (next < 4096){
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (accBits > 0) bits.push(acc & 255);

  const out = [minCodeSize];
  for (let i = 0; i < bits.length; i += 255){
    const chunk = bits.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return Uint8Array.from(out);
}

export async function framesToGif(frames, opts){
  if (!frames.length) throw new Error("no frames to encode");
  const w = frames[0].canvas.width, h = frames[0].canvas.height;
  const maxColors = Math.max(2, Math.min(256, +(opts.gifColors || 256)));

  let transparent = false;
  for (const f of frames){
    const px = canvasRGBA(f.canvas);
    for (let i = 3; i < px.length; i += 4) if (px[i] < 128){ transparent = true; break; }
    if (transparent) break;
  }
  const q = buildQuantizer(frames, maxColors, transparent);

  let bitsNeeded = 1;
  while ((1 << bitsNeeded) < q.palette.length) bitsNeeded++;
  const tableSize = 1 << bitsNeeded;

  const parts = [];
  const head = new Uint8Array(13);
  head.set(enc.encode("GIF89a"), 0);
  new DataView(head.buffer).setUint16(6, w, true);
  new DataView(head.buffer).setUint16(8, h, true);
  head[10] = 0x80 | (bitsNeeded - 1);
  head[11] = 0;
  head[12] = 0;
  parts.push(head);

  const gct = new Uint8Array(tableSize * 3);
  q.palette.forEach((p, i) => { gct[i * 3] = p[0]; gct[i * 3 + 1] = p[1]; gct[i * 3 + 2] = p[2]; });
  parts.push(gct);

  if (frames.length > 1){
    const loop = new Uint8Array(19);
    loop.set([0x21, 0xff, 0x0b], 0);
    loop.set(enc.encode("NETSCAPE2.0"), 3);
    loop.set([0x03, 0x01], 14);
    new DataView(loop.buffer).setUint16(16, +(opts.gifLoop ?? 0), true);
    loop[18] = 0;
    parts.push(loop);
  }

  for (const f of frames){
    const src = f.canvas.width === w && f.canvas.height === h ? f.canvas : resizeCanvas(f.canvas, Math.max(w, h), null);
    const px = canvasRGBA(src);
    const count = w * h;
    const indices = new Uint8Array(count);
    for (let i = 0, k = 0; k < count; i += 4, k++){
      indices[k] = px[i + 3] < 128 && transparent ? q.transIndex : q.nearest(px[i], px[i + 1], px[i + 2]);
    }

    const delay = Math.max(2, Math.round((f.delay ?? opts.gifDelay ?? 100) / 10));
    const gce = new Uint8Array(8);
    gce.set([0x21, 0xf9, 0x04], 0);
    gce[3] = (transparent ? 0x01 : 0x00) | (0x02 << 2);
    new DataView(gce.buffer).setUint16(4, delay, true);
    gce[6] = transparent ? q.transIndex : 0;
    gce[7] = 0;
    parts.push(gce);

    const desc = new Uint8Array(10);
    desc[0] = 0x2c;
    const dv = new DataView(desc.buffer);
    dv.setUint16(1, 0, true);
    dv.setUint16(3, 0, true);
    dv.setUint16(5, w, true);
    dv.setUint16(7, h, true);
    desc[9] = 0;
    parts.push(desc);

    parts.push(gifLzw(indices, Math.max(2, bitsNeeded)));
  }

  parts.push(Uint8Array.from([0x3b]));
  return concatBytes(parts);
}
