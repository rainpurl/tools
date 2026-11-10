// Image formats the browser cannot read by itself.

import { canvasFromRGBA, canvasRGBA } from "./canvas.js";
import { concatBytes, enc, latin1, safeName, utf8 } from "./util.js";

export function packBits(src, expected){
  const out = new Uint8Array(expected);
  let p = 0, o = 0;
  while (p < src.length && o < expected){
    const n = src[p] > 127 ? src[p] - 256 : src[p];
    p++;
    if (n >= 0){
      const count = n + 1;
      for (let i = 0; i < count && o < expected; i++) out[o++] = src[p + i];
      p += count;
    } else if (n !== -128){
      const count = 1 - n;
      const b = src[p++];
      for (let i = 0; i < count && o < expected; i++) out[o++] = b;
    }
  }
  return out;
}

export function tiffLzw(src, expected){
  const out = new Uint8Array(expected);
  let o = 0;
  let table = [], next = 258, width = 9, prev = null;
  const reset = () => {
    table = new Array(4096);
    for (let i = 0; i < 256; i++) table[i] = [i];
    next = 258; width = 9; prev = null;
  };
  reset();
  let bitPos = 0;
  const read = () => {
    if ((bitPos + width) > src.length * 8) return 257;
    let v = 0;
    for (let i = 0; i < width; i++){
      const b = bitPos + i;
      v = (v << 1) | ((src[b >> 3] >> (7 - (b & 7))) & 1);
    }
    bitPos += width;
    return v;
  };
  const emit = arr => { for (const b of arr){ if (o < expected) out[o++] = b; } };
  for (;;){
    const code = read();
    if (code === 257) break;
    if (code === 256){ reset(); continue; }
    let entry;
    if (prev === null){
      entry = table[code];
      if (!entry) break;
    } else if (code < next && table[code]){
      entry = table[code];
    } else {
      entry = table[prev].concat(table[prev][0]);
    }
    emit(entry);
    if (prev !== null && next < 4096){
      table[next++] = table[prev].concat(entry[0]);
      if (next + 1 >= (1 << width) && width < 12) width++;
    }
    prev = code;
    if (o >= expected) break;
  }
  return out;
}

export function tiffDecode(u8){
  const le = u8[0] === 0x49 && u8[1] === 0x49;
  const be = u8[0] === 0x4d && u8[1] === 0x4d;
  if (!le && !be) throw new Error("not a tiff file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = o => dv.getUint16(o, le);
  const u32 = o => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error("not a baseline tiff, big tiff is unsupported");

  const SIZES = { 1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8, 11:4, 12:8 };
  const readIfd = start => {
    const tags = new Map();
    const n = u16(start);
    for (let i = 0; i < n; i++){
      const p = start + 2 + i * 12;
      const tag = u16(p), type = u16(p + 2), count = u32(p + 4);
      const unit = SIZES[type] || 1;
      const base = (unit * count <= 4) ? p + 8 : u32(p + 8);
      const vals = [];
      for (let k = 0; k < count && k < 100000; k++){
        const q = base + k * unit;
        if (q + unit > u8.length) break;
        if (type === 1 || type === 2 || type === 7) vals.push(u8[q]);
        else if (type === 3) vals.push(u16(q));
        else if (type === 4) vals.push(u32(q));
        else if (type === 5) vals.push(u32(q) / (u32(q + 4) || 1));
        else if (type === 6) vals.push(dv.getInt8(q));
        else if (type === 8) vals.push(dv.getInt16(q, le));
        else if (type === 9) vals.push(dv.getInt32(q, le));
        else vals.push(0);
      }
      tags.set(tag, vals);
    }
    return { tags, next: u32(start + 2 + n * 12) };
  };

  const { tags } = readIfd(u32(4));
  const g = (t, d) => (tags.has(t) ? tags.get(t)[0] : d);
  const w = g(256, 0), h = g(257, 0);
  if (!w || !h) throw new Error("tiff has no dimensions");
  const bitsArr = tags.get(258) || [1];
  const bits = bitsArr[0];
  const comp = g(259, 1);
  const photo = g(262, 1);
  const spp = g(277, bitsArr.length || 1);
  const rowsPerStrip = g(278, h);
  const offsets = tags.get(273) || [];
  const counts = tags.get(279) || [];
  const planar = g(284, 1);
  const predictor = g(317, 1);
  const cmap = tags.get(320);
  const extra = tags.get(338) || [];

  if (planar !== 1) throw new Error("planar tiff layout is unsupported");
  if (![1, 5, 32773].includes(comp)) throw new Error("tiff compression " + comp + " is unsupported");
  if (![1, 4, 8, 16].includes(bits)) throw new Error(bits + " bits per sample is unsupported");
  if (!offsets.length) throw new Error("tiff has no strip offsets");

  const bytesPerRow = Math.ceil(w * spp * bits / 8);
  const raw = new Uint8Array(bytesPerRow * h);
  let filled = 0;
  for (let s = 0; s < offsets.length; s++){
    const rows = Math.min(rowsPerStrip, h - s * rowsPerStrip);
    if (rows <= 0) break;
    const want = bytesPerRow * rows;
    const chunk = u8.subarray(offsets[s], offsets[s] + (counts[s] ?? want));
    let dataChunk;
    if (comp === 1) dataChunk = chunk.subarray(0, want);
    else if (comp === 32773) dataChunk = packBits(chunk, want);
    else dataChunk = tiffLzw(chunk, want);
    raw.set(dataChunk.subarray(0, Math.min(want, raw.length - filled)), filled);
    filled += want;
  }

  if (predictor === 2 && bits === 8){
    for (let y = 0; y < h; y++){
      const base = y * bytesPerRow;
      for (let x = spp; x < w * spp; x++) raw[base + x] = (raw[base + x] + raw[base + x - spp]) & 255;
    }
  }

  const rgba = new Uint8ClampedArray(w * h * 4);
  const maxv = (1 << bits) - 1;
  const sample = (row, i) => {
    if (bits === 8) return raw[row + i];
    if (bits === 16) return raw[row + i * 2 + (le ? 1 : 0)];
    const bitIndex = i * bits;
    const byte = raw[row + (bitIndex >> 3)];
    const shift = 8 - bits - (bitIndex & 7);
    return (byte >> shift) & maxv;
  };
  const hasAlpha = spp === 4 || (spp === 2 && photo <= 1) || extra[0] === 1 || extra[0] === 2;
  for (let y = 0; y < h; y++){
    const row = y * bytesPerRow;
    for (let x = 0; x < w; x++){
      const o = (y * w + x) * 4;
      const i = x * spp;
      if (photo === 3 && cmap){
        const idx = sample(row, i);
        const n = cmap.length / 3;
        rgba[o]     = (cmap[idx] || 0) >> 8;
        rgba[o + 1] = (cmap[n + idx] || 0) >> 8;
        rgba[o + 2] = (cmap[2 * n + idx] || 0) >> 8;
        rgba[o + 3] = 255;
      } else if (photo === 2){
        const scale = bits === 8 || bits === 16 ? 1 : 255 / maxv;
        rgba[o]     = sample(row, i) * scale;
        rgba[o + 1] = sample(row, i + 1) * scale;
        rgba[o + 2] = sample(row, i + 2) * scale;
        rgba[o + 3] = hasAlpha ? sample(row, i + 3) * scale : 255;
      } else {
        let v = sample(row, i);
        if (bits !== 8 && bits !== 16) v = Math.round(v * 255 / maxv);
        if (photo === 0) v = 255 - v;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = hasAlpha ? sample(row, i + 1) : 255;
      }
    }
  }
  return canvasFromRGBA(w, h, rgba);
}

export function tiffEncode(canvas){
  const w = canvas.width, h = canvas.height;
  const px = canvasRGBA(canvas);
  const spp = 4;
  const dataLen = w * h * spp;
  const entries = [
    [256, 3, 1, w], [257, 3, 1, h], [258, 3, 4, 0], [259, 3, 1, 1],
    [262, 3, 1, 2], [273, 4, 1, 0], [277, 3, 1, spp], [278, 4, 1, h],
    [279, 4, 1, dataLen], [284, 3, 1, 1], [338, 3, 1, 2]
  ];
  const ifdCount = entries.length;
  const headerLen = 8;
  const ifdLen = 2 + ifdCount * 12 + 4;
  const bitsOff = headerLen + ifdLen;
  const dataOff = bitsOff + 8;
  const total = dataOff + dataLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, headerLen, true);
  dv.setUint16(headerLen, ifdCount, true);
  entries.forEach(([tag, type, count, value], i) => {
    const p = headerLen + 2 + i * 12;
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true);
    if (tag === 258) dv.setUint32(p + 8, bitsOff, true);
    else if (tag === 273) dv.setUint32(p + 8, dataOff, true);
    else if (type === 3) dv.setUint16(p + 8, value, true);
    else dv.setUint32(p + 8, value, true);
  });
  dv.setUint32(headerLen + 2 + ifdCount * 12, 0, true);
  for (let i = 0; i < 4; i++) dv.setUint16(bitsOff + i * 2, 8, true);
  out.set(px, dataOff);
  return out;
}

export function tgaDecode(u8){
  if (u8.length < 18) throw new Error("file too short to be a tga");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const idLen = u8[0], cmapType = u8[1], type = u8[2];
  const cmapLen = dv.getUint16(5, true), cmapDepth = u8[7];
  const w = dv.getUint16(12, true), h = dv.getUint16(14, true);
  const depth = u8[16], desc = u8[17];
  if (!w || !h) throw new Error("tga has no dimensions");
  if (![1, 2, 3, 9, 10, 11].includes(type)) throw new Error("tga image type " + type + " is unsupported");

  let p = 18 + idLen;
  const cmapBytes = cmapType ? cmapLen * Math.ceil(cmapDepth / 8) : 0;
  const cmap = u8.subarray(p, p + cmapBytes);
  p += cmapBytes;

  const bpp = Math.ceil(depth / 8);
  const pixels = new Uint8Array(w * h * bpp);
  const rle = type >= 9;
  if (!rle){
    pixels.set(u8.subarray(p, p + pixels.length));
  } else {
    let o = 0;
    while (o < pixels.length && p < u8.length){
      const packet = u8[p++];
      const count = (packet & 127) + 1;
      if (packet & 128){
        for (let i = 0; i < count && o < pixels.length; i++){
          for (let b = 0; b < bpp; b++) pixels[o++] = u8[p + b];
        }
        p += bpp;
      } else {
        const n = count * bpp;
        for (let i = 0; i < n && o < pixels.length; i++) pixels[o++] = u8[p + i];
        p += n;
      }
    }
  }

  const rgba = new Uint8ClampedArray(w * h * 4);
  const topDown = !!(desc & 0x20);
  const cdepth = Math.ceil(cmapDepth / 8);
  for (let y = 0; y < h; y++){
    const srcY = topDown ? y : h - 1 - y;
    for (let x = 0; x < w; x++){
      const s = (srcY * w + x) * bpp;
      const o = (y * w + x) * 4;
      if (type === 1 || type === 9){
        const idx = pixels[s] * cdepth;
        rgba[o] = cmap[idx + 2] ?? 0;
        rgba[o + 1] = cmap[idx + 1] ?? 0;
        rgba[o + 2] = cmap[idx] ?? 0;
        rgba[o + 3] = cdepth === 4 ? (cmap[idx + 3] ?? 255) : 255;
      } else if (type === 3 || type === 11){
        rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[s];
        rgba[o + 3] = 255;
      } else if (depth === 16){
        const v = pixels[s] | (pixels[s + 1] << 8);
        rgba[o] = ((v >> 10) & 31) * 255 / 31;
        rgba[o + 1] = ((v >> 5) & 31) * 255 / 31;
        rgba[o + 2] = (v & 31) * 255 / 31;
        rgba[o + 3] = (v & 0x8000) ? 255 : 255;
      } else {
        rgba[o] = pixels[s + 2];
        rgba[o + 1] = pixels[s + 1];
        rgba[o + 2] = pixels[s];
        rgba[o + 3] = bpp === 4 ? pixels[s + 3] : 255;
      }
    }
  }
  return canvasFromRGBA(w, h, rgba);
}

export function tgaEncode(canvas){
  const w = canvas.width, h = canvas.height;
  const px = canvasRGBA(canvas);
  const out = new Uint8Array(18 + w * h * 4);
  const dv = new DataView(out.buffer);
  out[2] = 2;
  dv.setUint16(12, w, true);
  dv.setUint16(14, h, true);
  out[16] = 32;
  out[17] = 0x28;
  for (let i = 0, o = 18; i < px.length; i += 4, o += 4){
    out[o] = px[i + 2]; out[o + 1] = px[i + 1]; out[o + 2] = px[i]; out[o + 3] = px[i + 3];
  }
  return out;
}

export function pnmDecode(u8){
  if (u8[0] !== 0x50) throw new Error("not a netpbm file");
  const kind = u8[1] - 0x30;
  if (kind < 1 || kind > 6) throw new Error("unsupported netpbm variant P" + kind);
  let p = 2;
  const tokens = [];
  const wantTokens = kind === 1 || kind === 4 ? 2 : 3;
  while (tokens.length < wantTokens && p < u8.length){
    while (p < u8.length && /\s/.test(String.fromCharCode(u8[p]))) p++;
    if (u8[p] === 0x23){ while (p < u8.length && u8[p] !== 10) p++; continue; }
    let t = "";
    while (p < u8.length && !/\s/.test(String.fromCharCode(u8[p]))) t += String.fromCharCode(u8[p++]);
    if (t) tokens.push(t);
  }
  p++;
  const w = +tokens[0], h = +tokens[1];
  const maxv = wantTokens === 3 ? (+tokens[2] || 255) : 1;
  if (!w || !h) throw new Error("netpbm header has no dimensions");
  const rgba = new Uint8ClampedArray(w * h * 4);
  const scale = 255 / maxv;

  if (kind <= 3){
    const text = utf8.decode(u8.subarray(p)).split(/\s+/).filter(s => s !== "" && !s.startsWith("#")).map(Number);
    let i = 0;
    for (let k = 0; k < w * h; k++){
      const o = k * 4;
      if (kind === 1){ const v = text[i++] ? 0 : 255; rgba[o] = rgba[o + 1] = rgba[o + 2] = v; }
      else if (kind === 2){ const v = text[i++] * scale; rgba[o] = rgba[o + 1] = rgba[o + 2] = v; }
      else { rgba[o] = text[i++] * scale; rgba[o + 1] = text[i++] * scale; rgba[o + 2] = text[i++] * scale; }
      rgba[o + 3] = 255;
    }
  } else if (kind === 4){
    const rowBytes = Math.ceil(w / 8);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
      const bit = (u8[p + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const o = (y * w + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = bit ? 0 : 255;
      rgba[o + 3] = 255;
    }
  } else {
    const wide = maxv > 255;
    const step = wide ? 2 : 1;
    const chans = kind === 5 ? 1 : 3;
    for (let k = 0; k < w * h; k++){
      const s = p + k * chans * step;
      const o = k * 4;
      const val = i => {
        const q = s + i * step;
        return (wide ? (u8[q] << 8 | u8[q + 1]) : u8[q]) * scale;
      };
      if (chans === 1) rgba[o] = rgba[o + 1] = rgba[o + 2] = val(0);
      else { rgba[o] = val(0); rgba[o + 1] = val(1); rgba[o + 2] = val(2); }
      rgba[o + 3] = 255;
    }
  }
  return canvasFromRGBA(w, h, rgba);
}

export function pnmEncode(canvas, gray){
  const w = canvas.width, h = canvas.height;
  const px = canvasRGBA(canvas);
  const header = enc.encode(`P${gray ? 5 : 6}\n# written by convert.html\n${w} ${h}\n255\n`);
  const body = new Uint8Array(w * h * (gray ? 1 : 3));
  for (let i = 0, o = 0; i < px.length; i += 4){
    const a = px[i + 3] / 255;
    const r = px[i] * a + 255 * (1 - a), g = px[i + 1] * a + 255 * (1 - a), b = px[i + 2] * a + 255 * (1 - a);
    if (gray) body[o++] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    else { body[o++] = Math.round(r); body[o++] = Math.round(g); body[o++] = Math.round(b); }
  }
  return concatBytes([header, body]);
}

export function qoiDecode(u8){
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "qoif") throw new Error("not a qoi file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const w = dv.getUint32(4), h = dv.getUint32(8), channels = u8[12];
  if (!w || !h) throw new Error("qoi has no dimensions");
  const rgba = new Uint8ClampedArray(w * h * 4);
  const index = new Int32Array(64 * 4);
  let r = 0, g = 0, b = 0, a = 255;
  let p = 14, px = 0, run = 0;
  const total = w * h;
  while (px < total){
    if (run > 0){ run--; }
    else if (p < u8.length){
      const b1 = u8[p++];
      if (b1 === 0xfe){ r = u8[p++]; g = u8[p++]; b = u8[p++]; }
      else if (b1 === 0xff){ r = u8[p++]; g = u8[p++]; b = u8[p++]; a = u8[p++]; }
      else if ((b1 & 0xc0) === 0x00){
        const i = (b1 & 0x3f) * 4;
        r = index[i]; g = index[i + 1]; b = index[i + 2]; a = index[i + 3];
      }
      else if ((b1 & 0xc0) === 0x40){
        r = (r + ((b1 >> 4) & 3) - 2) & 255;
        g = (g + ((b1 >> 2) & 3) - 2) & 255;
        b = (b + (b1 & 3) - 2) & 255;
      }
      else if ((b1 & 0xc0) === 0x80){
        const b2 = u8[p++];
        const dg = (b1 & 0x3f) - 32;
        g = (g + dg) & 255;
        r = (r + dg - 8 + ((b2 >> 4) & 15)) & 255;
        b = (b + dg - 8 + (b2 & 15)) & 255;
      }
      else { run = (b1 & 0x3f); }
      const hash = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
      index[hash] = r; index[hash + 1] = g; index[hash + 2] = b; index[hash + 3] = a;
    }
    const o = px * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = channels === 3 ? 255 : a;
    px++;
  }
  return canvasFromRGBA(w, h, rgba);
}

export function qoiEncode(canvas){
  const w = canvas.width, h = canvas.height;
  const src = canvasRGBA(canvas);
  const out = new Uint8Array(14 + w * h * 5 + 8);
  const dv = new DataView(out.buffer);
  out[0] = 113; out[1] = 111; out[2] = 105; out[3] = 102;
  dv.setUint32(4, w); dv.setUint32(8, h);
  out[12] = 4; out[13] = 0;
  let p = 14;
  const index = new Int32Array(64 * 4);
  let pr = 0, pg = 0, pb = 0, pa = 255, run = 0;
  const total = w * h;
  for (let i = 0; i < total; i++){
    const o = i * 4;
    const r = src[o], g = src[o + 1], b = src[o + 2], a = src[o + 3];
    if (r === pr && g === pg && b === pb && a === pa){
      run++;
      if (run === 62 || i === total - 1){ out[p++] = 0xc0 | (run - 1); run = 0; }
    } else {
      if (run > 0){ out[p++] = 0xc0 | (run - 1); run = 0; }
      const hash = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
      if (index[hash] === r && index[hash + 1] === g && index[hash + 2] === b && index[hash + 3] === a){
        out[p++] = (hash / 4) & 0x3f;
      } else {
        index[hash] = r; index[hash + 1] = g; index[hash + 2] = b; index[hash + 3] = a;
        if (a === pa){
          const dr = ((r - pr + 128) & 255) - 128, dg = ((g - pg + 128) & 255) - 128, db = ((b - pb + 128) & 255) - 128;
          const dgr = dr - dg, dgb = db - dg;
          if (dr > -3 && dr < 2 && dg > -3 && dg < 2 && db > -3 && db < 2){
            out[p++] = 0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2);
          } else if (dgr > -9 && dgr < 8 && dg > -33 && dg < 32 && dgb > -9 && dgb < 8){
            out[p++] = 0x80 | (dg + 32);
            out[p++] = ((dgr + 8) << 4) | (dgb + 8);
          } else {
            out[p++] = 0xfe; out[p++] = r; out[p++] = g; out[p++] = b;
          }
        } else {
          out[p++] = 0xff; out[p++] = r; out[p++] = g; out[p++] = b; out[p++] = a;
        }
      }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  if (run > 0) out[p++] = 0xc0 | (run - 1);
  for (let i = 0; i < 7; i++) out[p++] = 0;
  out[p++] = 1;
  return out.subarray(0, p);
}

export function pcxDecode(u8){
  if (u8[0] !== 10) throw new Error("not a pcx file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const bpp = u8[3];
  const xmin = dv.getUint16(4, true), ymin = dv.getUint16(6, true);
  const xmax = dv.getUint16(8, true), ymax = dv.getUint16(10, true);
  const planes = u8[65];
  const bytesPerLine = dv.getUint16(66, true);
  const w = xmax - xmin + 1, h = ymax - ymin + 1;
  if (w <= 0 || h <= 0) throw new Error("pcx has no dimensions");
  if (bpp !== 8 && bpp !== 1) throw new Error(bpp + " bit pcx is unsupported");

  const total = bytesPerLine * planes * h;
  const raw = new Uint8Array(total);
  let p = 128, o = 0;
  if (u8[2] === 1){
    while (o < total && p < u8.length){
      const b = u8[p++];
      if ((b & 0xc0) === 0xc0){
        const n = b & 0x3f, v = u8[p++];
        for (let i = 0; i < n && o < total; i++) raw[o++] = v;
      } else raw[o++] = b;
    }
  } else {
    raw.set(u8.subarray(p, p + total));
  }

  let pal = null;
  if (bpp === 8 && planes === 1){
    const tail = u8.length - 769;
    if (tail > 0 && u8[tail] === 12) pal = u8.subarray(tail + 1);
    else pal = u8.subarray(16, 64);
  }

  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++){
    const rowBase = y * bytesPerLine * planes;
    for (let x = 0; x < w; x++){
      const o2 = (y * w + x) * 4;
      if (planes >= 3){
        rgba[o2] = raw[rowBase + x];
        rgba[o2 + 1] = raw[rowBase + bytesPerLine + x];
        rgba[o2 + 2] = raw[rowBase + bytesPerLine * 2 + x];
      } else if (bpp === 1){
        const bit = (raw[rowBase + (x >> 3)] >> (7 - (x & 7))) & 1;
        rgba[o2] = rgba[o2 + 1] = rgba[o2 + 2] = bit ? 0 : 255;
      } else {
        const idx = raw[rowBase + x] * 3;
        rgba[o2] = pal ? pal[idx] : raw[rowBase + x];
        rgba[o2 + 1] = pal ? pal[idx + 1] : raw[rowBase + x];
        rgba[o2 + 2] = pal ? pal[idx + 2] : raw[rowBase + x];
      }
      rgba[o2 + 3] = 255;
    }
  }
  return canvasFromRGBA(w, h, rgba);
}

export function icnsEntries(u8){
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "icns") throw new Error("not an icns file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const total = Math.min(dv.getUint32(4), u8.length);
  const out = [];
  let p = 8;
  while (p + 8 <= total){
    const type = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    const size = dv.getUint32(p + 4);
    if (size < 8 || p + size > total) break;
    const data = u8.subarray(p + 8, p + size);
    const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    const isJp2 = data[0] === 0x00 && data[4] === 0x6a && data[5] === 0x50;
    if (isPng) out.push({ type, ext: "png", bytes: data.slice(), mime: "image/png" });
    else if (isJp2) out.push({ type, ext: "jp2", bytes: data.slice(), mime: "image/jp2" });
    p += size;
  }
  if (!out.length) throw new Error("no embedded png images in this icns file");
  return out;
}

export function ddsDecode(u8){
  if (latin1.decode(u8.subarray(0, 4)) !== "DDS ") throw new Error("not a dds file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
  if (!w || !h) throw new Error("dds has no dimensions");
  const pfFlags = dv.getUint32(80, true);
  const four = latin1.decode(u8.subarray(84, 88));
  const bits = dv.getUint32(88, true);
  let off = 128, fmt = null;
  if (pfFlags & 4){
    if (four === "DXT1") fmt = "bc1";
    else if (four === "DXT2" || four === "DXT3") fmt = "bc2";
    else if (four === "DXT4" || four === "DXT5") fmt = "bc3";
    else if (four === "DX10"){
      const dxgi = dv.getUint32(128, true);
      off = 148;
      fmt = { 71:"bc1", 72:"bc1", 74:"bc2", 75:"bc2", 77:"bc3", 78:"bc3",
              28:"rgba8", 29:"rgba8", 87:"bgra8", 91:"bgra8", 88:"bgrx8" }[dxgi];
      if (!fmt) throw new Error("dds DXGI format " + dxgi + " is unsupported");
    } else throw new Error("dds compression " + four.trim() + " is unsupported");
  }
  const rgba = new Uint8ClampedArray(w * h * 4);

  if (fmt && fmt.startsWith("bc")){
    const c565 = v => [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0];
    const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
    let p = off;
    const alpha = new Uint8Array(16);
    for (let by = 0; by < bh; by++){
      for (let bx = 0; bx < bw; bx++){
        let hasA = false;
        if (fmt === "bc2"){
          for (let i = 0; i < 16; i++){
            const b = u8[p + (i >> 1)];
            alpha[i] = ((i & 1) ? b >> 4 : b & 15) * 17;
          }
          hasA = true; p += 8;
        } else if (fmt === "bc3"){
          const a0 = u8[p], a1 = u8[p + 1];
          const tab = [a0, a1];
          if (a0 > a1) for (let k = 1; k < 7; k++) tab.push(((7 - k) * a0 + k * a1) / 7 | 0);
          else { for (let k = 1; k < 5; k++) tab.push(((5 - k) * a0 + k * a1) / 5 | 0); tab.push(0, 255); }
          const lo = u8[p + 2] | (u8[p + 3] << 8) | (u8[p + 4] << 16);
          const hi = u8[p + 5] | (u8[p + 6] << 8) | (u8[p + 7] << 16);
          for (let i = 0; i < 8; i++){ alpha[i] = tab[(lo >> (3 * i)) & 7]; alpha[8 + i] = tab[(hi >> (3 * i)) & 7]; }
          hasA = true; p += 8;
        }
        const v0 = u8[p] | (u8[p + 1] << 8), v1 = u8[p + 2] | (u8[p + 3] << 8);
        const idx = dv.getUint32(p + 4, true);
        p += 8;
        const a = c565(v0), b = c565(v1);
        const pal = [[...a, 255], [...b, 255]];
        if (v0 > v1 || fmt !== "bc1"){
          pal.push([(2 * a[0] + b[0]) / 3 | 0, (2 * a[1] + b[1]) / 3 | 0, (2 * a[2] + b[2]) / 3 | 0, 255]);
          pal.push([(a[0] + 2 * b[0]) / 3 | 0, (a[1] + 2 * b[1]) / 3 | 0, (a[2] + 2 * b[2]) / 3 | 0, 255]);
        } else {
          pal.push([(a[0] + b[0]) >> 1, (a[1] + b[1]) >> 1, (a[2] + b[2]) >> 1, 255]);
          pal.push([0, 0, 0, 0]);
        }
        for (let i = 0; i < 16; i++){
          const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
          if (x >= w || y >= h) continue;
          const c = pal[(idx >>> (2 * i)) & 3];
          const o = (y * w + x) * 4;
          rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2];
          rgba[o + 3] = hasA ? alpha[i] : c[3];
        }
      }
    }
    return canvasFromRGBA(w, h, rgba);
  }

  const bpp = fmt ? 4 : bits / 8;
  if (!bpp || bpp > 4) throw new Error("dds with " + bits + " bits per pixel is unsupported");
  const masks = fmt === "rgba8" ? [0xff, 0xff00, 0xff0000, 0xff000000]
    : fmt === "bgra8" ? [0xff0000, 0xff00, 0xff, 0xff000000]
    : fmt === "bgrx8" ? [0xff0000, 0xff00, 0xff, 0]
    : [dv.getUint32(92, true), dv.getUint32(96, true), dv.getUint32(100, true), (pfFlags & 1) ? dv.getUint32(104, true) : 0];
  const field = m => {
    m = m >>> 0;
    if (!m) return null;
    let s = 0; while (!((m >>> s) & 1)) s++;
    let n = 0; while (s + n < 32 && ((m >>> (s + n)) & 1)) n++;
    return { m, s, max: Math.pow(2, n) - 1 };
  };
  const F = masks.map(field);
  const lum = !!(pfFlags & 0x20000);
  const get = (v, f, d) => f ? Math.round(((v & f.m) >>> f.s) * 255 / f.max) : d;
  for (let i = 0; i < w * h; i++){
    let v = 0;
    for (let k = 0; k < bpp; k++) v |= u8[off + i * bpp + k] << (8 * k);
    v = v >>> 0;
    const o = i * 4;
    const r = get(v, F[0], 0);
    rgba[o] = r;
    rgba[o + 1] = lum ? r : get(v, F[1], 0);
    rgba[o + 2] = lum ? r : get(v, F[2], 0);
    rgba[o + 3] = get(v, F[3], 255);
  }
  return canvasFromRGBA(w, h, rgba);
}

export function sgiDecode(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint16(0) !== 474) throw new Error("not an sgi image");
  const rle = u8[2], bpc = u8[3];
  const dim = dv.getUint16(4);
  const w = dv.getUint16(6), h = dim > 1 ? dv.getUint16(8) : 1, z = dim > 2 ? dv.getUint16(10) : 1;
  if (!w || !h) throw new Error("sgi image has no dimensions");
  if (bpc !== 1 && bpc !== 2) throw new Error(bpc * 8 + " bit sgi is unsupported");
  if (rle && bpc !== 1) throw new Error("16 bit run length sgi is unsupported");
  const planes = [];
  for (let c = 0; c < z; c++){
    const plane = new Uint8Array(w * h);
    for (let y = 0; y < h; y++){
      const row = plane.subarray(y * w, y * w + w);
      if (!rle){
        const base = 512 + (c * h + y) * w * bpc;
        for (let x = 0; x < w; x++) row[x] = u8[base + x * bpc];
      } else {
        let p = dv.getUint32(512 + (c * h + y) * 4);
        let x = 0;
        while (x < w && p < u8.length){
          const b = u8[p++];
          const n = b & 0x7f;
          if (!n) break;
          if (b & 0x80){ for (let k = 0; k < n && x < w; k++) row[x++] = u8[p++]; }
          else { const v = u8[p++]; for (let k = 0; k < n && x < w; k++) row[x++] = v; }
        }
      }
    }
    planes.push(plane);
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++){
    const sy = h - 1 - y;
    for (let x = 0; x < w; x++){
      const s = sy * w + x, o = (y * w + x) * 4;
      if (z >= 3){
        rgba[o] = planes[0][s]; rgba[o + 1] = planes[1][s]; rgba[o + 2] = planes[2][s];
        rgba[o + 3] = z >= 4 ? planes[3][s] : 255;
      } else {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = planes[0][s];
        rgba[o + 3] = z === 2 ? planes[1][s] : 255;
      }
    }
  }
  return canvasFromRGBA(w, h, rgba);
}

export function rasDecode(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0) !== 0x59a66a95) throw new Error("not a sun raster file");
  const w = dv.getUint32(4), h = dv.getUint32(8), depth = dv.getUint32(12);
  const type = dv.getUint32(20), mapLen = dv.getUint32(28);
  if (!w || !h) throw new Error("sun raster has no dimensions");
  if (![1, 8, 24, 32].includes(depth)) throw new Error(depth + " bit sun raster is unsupported");
  let p = 32;
  const cmap = mapLen ? u8.subarray(p, p + mapLen) : null;
  p += mapLen;
  const rowBytes = Math.ceil(w * depth / 8);
  const pitch = rowBytes + (rowBytes & 1);
  let data = u8.subarray(p);
  if (type === 2){
    const out = new Uint8Array(pitch * h);
    let o = 0, q = 0;
    while (o < out.length && q < data.length){
      const b = data[q++];
      if (b === 0x80){
        const n = data[q++];
        if (n === 0) out[o++] = 0x80;
        else { const v = data[q++]; for (let k = 0; k <= n && o < out.length; k++) out[o++] = v; }
      } else out[o++] = b;
    }
    data = out;
  }
  const n3 = cmap ? mapLen / 3 : 0;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++){
    const row = y * pitch;
    for (let x = 0; x < w; x++){
      const o = (y * w + x) * 4;
      let r, g, b;
      if (depth === 1){
        const bit = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (cmap){ r = cmap[bit]; g = cmap[n3 + bit]; b = cmap[2 * n3 + bit]; }
        else r = g = b = bit ? 0 : 255;
      } else if (depth === 8){
        const i = data[row + x];
        if (cmap){ r = cmap[i]; g = cmap[n3 + i]; b = cmap[2 * n3 + i]; }
        else r = g = b = i;
      } else if (depth === 24){
        const q = row + x * 3;
        if (type === 3){ r = data[q]; g = data[q + 1]; b = data[q + 2]; }
        else { b = data[q]; g = data[q + 1]; r = data[q + 2]; }
      } else {
        const q = row + x * 4;
        if (type === 3){ r = data[q + 1]; g = data[q + 2]; b = data[q + 3]; }
        else { b = data[q + 1]; g = data[q + 2]; r = data[q + 3]; }
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  return canvasFromRGBA(w, h, rgba);
}

export function toneMapFloat(w, h, f, ch){
  const n = w * h;
  const lum = i => ch === 3 ? 0.2126 * f[i * 3] + 0.7152 * f[i * 3 + 1] + 0.0722 * f[i * 3 + 2] : f[i];
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++){
    const L = lum(i);
    if (L > 0 && Number.isFinite(L)){ sum += Math.log(1e-6 + L); count++; }
  }
  const avg = count ? Math.exp(sum / count) : 1;
  const k = 0.18 / (avg || 1);
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++){
    const L = lum(i);
    const Ls = L * k;
    const s = L > 0 && Number.isFinite(L) ? (Ls / (1 + Ls)) / L : 0;
    for (let c = 0; c < 3; c++){
      const v = (ch === 3 ? f[i * 3 + c] : f[i]) * s;
      rgba[i * 4 + c] = 255 * Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2);
    }
    rgba[i * 4 + 3] = 255;
  }
  return canvasFromRGBA(w, h, rgba);
}

export function hdrDecode(u8){
  let p = 0;
  const line = () => {
    let s = "";
    while (p < u8.length && u8[p] !== 10) s += String.fromCharCode(u8[p++]);
    p++;
    return s;
  };
  if (!line().startsWith("#?")) throw new Error("not a radiance hdr file");
  for (;;){ const l = line(); if (!l.trim() || p >= u8.length) break; }
  const res = line().trim().match(/^([-+])Y\s+(\d+)\s+([-+])X\s+(\d+)$/);
  if (!res) throw new Error("hdr resolution line is unsupported");
  const h = +res[2], w = +res[4], flipY = res[1] === "+", flipX = res[3] === "-";
  const f = new Float32Array(w * h * 3);
  const scan = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++){
    if (w >= 8 && w < 32768 && u8[p] === 2 && u8[p + 1] === 2 && ((u8[p + 2] << 8) | u8[p + 3]) === w){
      p += 4;
      for (let c = 0; c < 4; c++){
        let x = 0;
        while (x < w && p < u8.length){
          let n = u8[p++];
          if (n > 128){ n -= 128; const v = u8[p++]; while (n-- && x < w) scan[(x++) * 4 + c] = v; }
          else { while (n-- && x < w) scan[(x++) * 4 + c] = u8[p++]; }
        }
      }
    } else {
      for (let x = 0; x < w; x++){ scan.set(u8.subarray(p, p + 4), x * 4); p += 4; }
    }
    const ty = flipY ? h - 1 - y : y;
    for (let x = 0; x < w; x++){
      const e = scan[x * 4 + 3];
      const tx = flipX ? w - 1 - x : x;
      const o = (ty * w + tx) * 3;
      if (!e){ f[o] = f[o + 1] = f[o + 2] = 0; continue; }
      const s = Math.pow(2, e - 136);
      f[o] = scan[x * 4] * s; f[o + 1] = scan[x * 4 + 1] * s; f[o + 2] = scan[x * 4 + 2] * s;
    }
  }
  return toneMapFloat(w, h, f, 3);
}

export function pfmDecode(u8){
  const head = latin1.decode(u8.subarray(0, 256));
  const m = head.match(/^(P[Ff])\s+(\d+)\s+(\d+)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s/);
  if (!m) throw new Error("not a pfm file");
  const ch = m[1] === "PF" ? 3 : 1, w = +m[2], h = +m[3], le = parseFloat(m[4]) < 0;
  const off = m[0].length;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (off + w * h * ch * 4 > u8.length) throw new Error("pfm is truncated");
  const f = new Float32Array(w * h * ch);
  for (let y = 0; y < h; y++){
    const sy = h - 1 - y;
    for (let i = 0; i < w * ch; i++) f[y * w * ch + i] = dv.getFloat32(off + (sy * w * ch + i) * 4, le);
  }
  return toneMapFloat(w, h, f, ch);
}

export function farbfeldDecode(u8){
  if (latin1.decode(u8.subarray(0, 8)) !== "farbfeld") throw new Error("not a farbfeld file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const w = dv.getUint32(8), h = dv.getUint32(12);
  if (!w || !h || 16 + w * h * 8 > u8.length) throw new Error("farbfeld header is invalid");
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h * 4; i++) rgba[i] = u8[16 + i * 2];
  return canvasFromRGBA(w, h, rgba);
}

export function wbmpDecode(u8){
  let p = 0;
  const vi = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while ((b & 0x80) && p < u8.length); return v; };
  if (vi() !== 0) throw new Error("only type 0 wbmp is supported");
  p++;
  const w = vi(), h = vi();
  if (!w || !h || w > 65535 || h > 65535) throw new Error("wbmp header is invalid");
  const rowBytes = Math.ceil(w / 8);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
    const bit = (u8[p + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
    const o = (y * w + x) * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = bit ? 255 : 0;
    rgba[o + 3] = 255;
  }
  return canvasFromRGBA(w, h, rgba);
}

export function xbmDecode(text){
  const w = +(text.match(/#define\s+\S*_?width\s+(\d+)/i) || [])[1];
  const h = +(text.match(/#define\s+\S*_?height\s+(\d+)/i) || [])[1];
  if (!w || !h) throw new Error("no width or height define in this xbm");
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close < 0) throw new Error("no bitmap data in this xbm");
  const bytes = text.slice(open + 1, close).split(",")
    .map(s => s.trim()).filter(Boolean)
    .map(s => parseInt(s, s.startsWith("0x") || s.startsWith("0X") ? 16 : 10) & 255);
  const rowBytes = Math.ceil(w / 8);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      const byte = bytes[y * rowBytes + (x >> 3)] || 0;
      const on = (byte >> (x & 7)) & 1;
      const o = (y * w + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = on ? 0 : 255;
      rgba[o + 3] = 255;
    }
  }
  return canvasFromRGBA(w, h, rgba);
}

export function xbmEncode(canvas, name){
  const w = canvas.width, h = canvas.height;
  const px = canvasRGBA(canvas);
  const rowBytes = Math.ceil(w / 8);
  const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      const o = (y * w + x) * 4;
      const a = px[o + 3] / 255;
      const lum = (0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]) * a + 255 * (1 - a);
      if (lum < 128) out[y * rowBytes + (x >> 3)] |= 1 << (x & 7);
    }
  }
  const id = safeName(name || "image").replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1") || "image";
  const hex = [...out].map(b => "0x" + b.toString(16).padStart(2, "0"));
  const lines = [];
  for (let i = 0; i < hex.length; i += 12) lines.push("  " + hex.slice(i, i + 12).join(", "));
  return enc.encode(`#define ${id}_width ${w}\n#define ${id}_height ${h}\nstatic unsigned char ${id}_bits[] = {\n${lines.join(",\n")}\n};\n`);
}

export function xpmDecode(text){
  const rows = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
  if (!rows.length) throw new Error("no string data in this xpm");
  const head = rows[0].trim().split(/\s+/).map(Number);
  const [w, h, nColors, cpp] = head;
  if (!w || !h || !nColors || !cpp) throw new Error("bad xpm header: " + rows[0]);
  const NAMED = { white:"#ffffff", black:"#000000", red:"#ff0000", green:"#00ff00",
    blue:"#0000ff", yellow:"#ffff00", cyan:"#00ffff", magenta:"#ff00ff", gray:"#808080",
    grey:"#808080", none:null };
  const map = new Map();
  for (let i = 0; i < nColors; i++){
    const line = rows[1 + i];
    if (line === undefined) break;
    const key = line.slice(0, cpp);
    const spec = line.slice(cpp);
    const m = spec.match(/\bc\s+(#[0-9a-fA-F]+|\S+)/) || spec.match(/\b[msg]\s+(#[0-9a-fA-F]+|\S+)/);
    let col = m ? m[1] : "#000000";
    if (!col.startsWith("#")){
      const nm = col.toLowerCase();
      col = nm in NAMED ? NAMED[nm] : "#000000";
    }
    if (col === null){ map.set(key, [0, 0, 0, 0]); continue; }
    let hex = col.slice(1);
    if (hex.length === 3) hex = [...hex].map(c => c + c).join("");
    if (hex.length === 12) hex = hex[0] + hex[1] + hex[4] + hex[5] + hex[8] + hex[9];
    const v = parseInt(hex.slice(0, 6), 16) || 0;
    map.set(key, [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255]);
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++){
    const line = rows[1 + nColors + y] || "";
    for (let x = 0; x < w; x++){
      const key = line.slice(x * cpp, x * cpp + cpp);
      const c = map.get(key) || [0, 0, 0, 0];
      const o = (y * w + x) * 4;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
    }
  }
  return canvasFromRGBA(w, h, rgba);
}

export function psdDecode(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== "8BPS") throw new Error("not a photoshop file");
  const version = dv.getUint16(4);
  if (version !== 1 && version !== 2) throw new Error("unknown psd version " + version);
  const big = version === 2;
  const channels = dv.getUint16(12);
  const height = dv.getUint32(14), width = dv.getUint32(18);
  const depth = dv.getUint16(22), mode = dv.getUint16(24);
  if (!width || !height) throw new Error("psd has no dimensions");
  if (![8, 16].includes(depth)) throw new Error(depth + " bit psd is unsupported");

  let p = 26;
  const cmdLen = dv.getUint32(p); p += 4;
  const palette = mode === 2 ? u8.subarray(p, p + cmdLen) : null;
  p += cmdLen;
  p += 4 + dv.getUint32(p);
  const layerLen = big ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
  p += (big ? 8 : 4) + layerLen;

  const compression = dv.getUint16(p); p += 2;
  if (compression !== 0 && compression !== 1)
    throw new Error("psd compression " + compression + " is unsupported, only raw and RLE are handled");

  const step = depth === 16 ? 2 : 1;
  const planeLen = width * height * step;
  const planes = [];
  if (compression === 0){
    for (let c = 0; c < channels; c++) planes.push(u8.subarray(p + c * planeLen, p + (c + 1) * planeLen));
  } else {
    const counts = [];
    for (let c = 0; c < channels; c++){
      for (let y = 0; y < height; y++){
        counts.push(big ? dv.getUint32(p) : dv.getUint16(p));
        p += big ? 4 : 2;
      }
    }
    let k = 0;
    for (let c = 0; c < channels; c++){
      const rows = [];
      for (let y = 0; y < height; y++){
        const n = counts[k++];
        rows.push(packBits(u8.subarray(p, p + n), width * step));
        p += n;
      }
      planes.push(concatBytes(rows));
    }
  }

  const at = (plane, i) => {
    const o = i * step;
    if (o >= plane.length) return 0;
    return depth === 16 ? plane[o] : plane[o];
  };
  const rgba = new Uint8ClampedArray(width * height * 4);
  const n = width * height;
  for (let i = 0; i < n; i++){
    const o = i * 4;
    if (mode === 3){
      rgba[o] = at(planes[0], i);
      rgba[o + 1] = at(planes[1] || planes[0], i);
      rgba[o + 2] = at(planes[2] || planes[0], i);
      rgba[o + 3] = channels > 3 ? at(planes[3], i) : 255;
    } else if (mode === 1 || mode === 8){
      const v = at(planes[0], i);
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      rgba[o + 3] = channels > 1 ? at(planes[1], i) : 255;
    } else if (mode === 0){
      const byte = planes[0][Math.floor(i / 8)] || 0;
      const on = (byte >> (7 - (i & 7))) & 1;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = on ? 0 : 255;
      rgba[o + 3] = 255;
    } else if (mode === 2 && palette){
      const idx = at(planes[0], i);
      rgba[o] = palette[idx] ?? 0;
      rgba[o + 1] = palette[256 + idx] ?? 0;
      rgba[o + 2] = palette[512 + idx] ?? 0;
      rgba[o + 3] = 255;
    } else if (mode === 4){
      const c = 255 - at(planes[0], i), m = 255 - at(planes[1], i);
      const y = 255 - at(planes[2], i), k2 = 255 - at(planes[3], i);
      rgba[o] = 255 - Math.min(255, c + k2);
      rgba[o + 1] = 255 - Math.min(255, m + k2);
      rgba[o + 2] = 255 - Math.min(255, y + k2);
      rgba[o + 3] = channels > 4 ? at(planes[4], i) : 255;
    } else {
      const v = at(planes[0], i);
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
  }
  if (mode === 0){
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++){
      const byte = planes[0][y * rowBytes + (x >> 3)] || 0;
      const on = (byte >> (7 - (x & 7))) & 1;
      const o = (y * width + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = on ? 0 : 255;
      rgba[o + 3] = 255;
    }
  }
  return canvasFromRGBA(width, height, rgba);
}
