// Fonts: TTF and OTF, their web wrappers WOFF and WOFF2, and collections.
// A font file is a set of tables; WOFF is the same tables, each compressed.

import { useModule } from "./modules.js";
import { concatBytes, deflateZlib, inflate, latin1 } from "./util.js";

const tag = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
const pad4 = n => (n + 3) & ~3;

function checksum(u8){
  let sum = 0;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const whole = u8.length & ~3;
  for (let i = 0; i < whole; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  if (u8.length > whole){
    const last = new Uint8Array(4);
    last.set(u8.subarray(whole));
    sum = (sum + new DataView(last.buffer).getUint32(0)) >>> 0;
  }
  return sum;
}

// Tables of one plain font, starting at `at` in the file.
function sfntTables(u8, at){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint16(at + 4);
  const tables = [];
  for (let i = 0; i < n; i++){
    const o = at + 12 + i * 16;
    const off = dv.getUint32(o + 8), len = dv.getUint32(o + 12);
    if (off + len > u8.length) throw new Error("this font file is cut short");
    tables.push({ tag: tag(u8, o), data: u8.subarray(off, off + len) });
  }
  return { version: dv.getUint32(at), tables };
}

function buildSfnt(font){
  // the head table holds a checksum of the whole file, so it is cleared here and set at the end
  const tables = font.tables.slice().sort((a, b) => a.tag < b.tag ? -1 : 1).map(t => {
    if (t.tag !== "head" || t.data.length < 12) return t;
    const data = t.data.slice();
    data.fill(0, 8, 12);
    return { tag: t.tag, data };
  });
  const n = tables.length;
  const head = new Uint8Array(12 + n * 16);
  const dv = new DataView(head.buffer);
  const pow = 2 ** Math.floor(Math.log2(n));
  dv.setUint32(0, font.version);
  dv.setUint16(4, n);
  dv.setUint16(6, pow * 16);
  dv.setUint16(8, Math.log2(pow));
  dv.setUint16(10, n * 16 - pow * 16);
  const parts = [head];
  let off = head.length, headAt = 0;
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++) head[o + k] = t.tag.charCodeAt(k);
    dv.setUint32(o + 4, checksum(t.data));
    dv.setUint32(o + 8, off);
    dv.setUint32(o + 12, t.data.length);
    const padded = new Uint8Array(pad4(t.data.length));
    padded.set(t.data);
    parts.push(padded);
    if (t.tag === "head") headAt = off;
    off += padded.length;
  });
  const out = concatBytes(parts);
  if (headAt) new DataView(out.buffer).setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

async function woffTables(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint16(12);
  const tables = [];
  for (let i = 0; i < n; i++){
    const o = 44 + i * 20;
    const off = dv.getUint32(o + 4), comp = dv.getUint32(o + 8), orig = dv.getUint32(o + 12);
    const raw = u8.subarray(off, off + comp);
    tables.push({ tag: tag(u8, o), data: comp < orig ? await inflate(raw) : raw });
  }
  return { version: dv.getUint32(4), tables };
}

// Every font in the file as plain table sets. Collections hold several.
export async function readFonts(u8, opts){
  const sig = tag(u8, 0);
  if (sig === "wOFF") return [await woffTables(u8)];
  if (sig === "wOF2"){
    const lib = await useModule("woff2", opts);
    const out = lib.decompress(u8);
    if (!out) throw new Error("this WOFF2 file could not be unpacked");
    return readFonts(new Uint8Array(out), opts);
  }
  if (sig === "ttcf"){
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint32(8);
    return Array.from({ length: n }, (_, i) => sfntTables(u8, dv.getUint32(12 + i * 4)));
  }
  if (sig === "OTTO" || sig === "true" || sig === "typ1" || (u8[0] === 0 && u8[1] === 1 && u8[2] === 0 && u8[3] === 0)) return [sfntTables(u8, 0)];
  throw new Error("this is not a TTF, OTF, WOFF or WOFF2 font");
}

export const fontExt = font => font.tables.some(t => t.tag === "CFF " || t.tag === "CFF2") ? "otf" : "ttf";

// The name the font gives itself.
export function fontName(font){
  const t = font.tables.find(x => x.tag === "name");
  if (!t) return "";
  const u8 = t.data, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const count = dv.getUint16(2), strings = dv.getUint16(4);
  let best = "", rank = -1;
  for (let i = 0; i < count; i++){
    const o = 6 + i * 12;
    const platform = dv.getUint16(o), id = dv.getUint16(o + 6), len = dv.getUint16(o + 8), off = dv.getUint16(o + 10);
    if (id !== 4 && id !== 1) continue;
    const bytes = u8.subarray(strings + off, strings + off + len);
    const s = platform === 3 || platform === 0 ? new TextDecoder("utf-16be").decode(bytes) : latin1.decode(bytes);
    const r = (id === 4 ? 2 : 0) + (platform === 3 ? 1 : 0);
    if (s && r > rank){ rank = r; best = s; }
  }
  return best;
}

export async function fontTo(font, target, opts){
  const sfnt = buildSfnt(font);
  if (target === "sfnt") return sfnt;
  if (target === "woff2"){
    const lib = await useModule("woff2", opts);
    const out = lib.compress(sfnt);
    if (!out) throw new Error("this font could not be packed as WOFF2");
    return new Uint8Array(out);
  }
  // WOFF: the same tables, each deflated when that makes it smaller
  const tables = font.tables.slice().sort((a, b) => a.tag < b.tag ? -1 : 1);
  const n = tables.length;
  const head = new Uint8Array(44 + n * 20);
  const dv = new DataView(head.buffer);
  const parts = [head];
  let off = head.length, plain = 12 + n * 16;
  for (const [i, t] of tables.entries()){
    const packed = await deflateZlib(t.data);
    const data = packed.length < t.data.length ? packed : t.data;
    const o = 44 + i * 20;
    for (let k = 0; k < 4; k++) head[o + k] = t.tag.charCodeAt(k);
    dv.setUint32(o + 4, off);
    dv.setUint32(o + 8, data.length);
    dv.setUint32(o + 12, t.data.length);
    dv.setUint32(o + 16, checksum(t.data));
    const padded = new Uint8Array(pad4(data.length));
    padded.set(data);
    parts.push(padded);
    off += padded.length;
    plain += pad4(t.data.length);
  }
  head.set([0x77, 0x4f, 0x46, 0x46]);
  dv.setUint32(4, font.version);
  dv.setUint32(8, off);
  dv.setUint16(12, n);
  dv.setUint32(16, plain);
  dv.setUint16(20, 1);
  return concatBytes(parts);
}

// A sample sheet, so a font can be looked at and turned into a picture.
let faceSeq = 0;
export async function fontSpecimen(u8, opts){
  const fonts = await readFonts(u8, opts);
  const name = fontName(fonts[0]) || "Font";
  const family = "specimen" + (++faceSeq);
  const face = new FontFace(family, buildSfnt(fonts[0]));
  await face.load();
  const set = typeof document !== "undefined" ? document.fonts : self.fonts;
  set.add(face);
  try {
    const W = 1600, pad = 70;
    const lines = [
      [name, 30, "#666"],
      ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", 76, "#000"],
      ["abcdefghijklmnopqrstuvwxyz", 76, "#000"],
      ["0123456789 . , ; : ! ? & @ # $ % ( )", 64, "#000"],
      ["Sphinx of black quartz, judge my vow.", 96, "#000"],
      ["The quick brown fox jumps over the lazy dog.", 48, "#000"],
      ["The quick brown fox jumps over the lazy dog.", 28, "#000"],
      ["The quick brown fox jumps over the lazy dog.", 18, "#000"]
    ];
    const H = pad * 2 + lines.reduce((a, l) => a + l[1] * 1.5, 0);
    const c = new OffscreenCanvas(W, Math.ceil(H));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    let y = pad;
    lines.forEach(([text, size, color], i) => {
      ctx.fillStyle = color;
      ctx.font = `${size}px ${i === 0 ? "sans-serif" : family}`;
      ctx.textBaseline = "top";
      ctx.fillText(text, pad, y, W - pad * 2);
      y += size * 1.5;
    });
    return c;
  } finally { set.delete(face); }
}
