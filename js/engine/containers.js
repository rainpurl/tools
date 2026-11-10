// Zip and tar, read and write.

import { concatBytes, crc32, decodeText, deflateRaw, enc, inflateRaw, utf8 } from "./util.js";

export const SIG_EOCD = 0x06054b50;

export const SIG_EOCD64 = 0x06064b50;

export const SIG_LOC64 = 0x07064b50;

export const SIG_CEN = 0x02014b50;

export const SIG_LOC = 0x04034b50;

export class ZipReader {
  static WINDOW = 16 * 1024 * 1024;
  constructor(blob){
    this.file = blob;
    this.entries = [];
    this._off = new Map();
    this._buf = null; this._s = 0; this._e = 0;
  }
  async open(){
    const size = this.file.size;
    const tailLen = Math.min(size, 66000);
    const tail = new DataView(await this.file.slice(size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--){
      if (tail.getUint32(i, true) === SIG_EOCD){ eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip container");
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOff  = tail.getUint32(eocd + 16, true);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff){
      const loc = eocd - 20;
      if (loc >= 0 && tail.getUint32(loc, true) === SIG_LOC64){
        const o = Number(tail.getBigUint64(loc + 8, true));
        const z = new DataView(await this.file.slice(o, o + 56).arrayBuffer());
        if (z.getUint32(0, true) !== SIG_EOCD64) throw new Error("broken zip64 record");
        cdSize = Number(z.getBigUint64(40, true));
        cdOff  = Number(z.getBigUint64(48, true));
      }
    }
    const cdBuf = await this.file.slice(cdOff, cdOff + cdSize).arrayBuffer();
    const cd = new DataView(cdBuf), raw = new Uint8Array(cdBuf);
    let p = 0;
    while (p + 46 <= cd.byteLength){
      if (cd.getUint32(p, true) !== SIG_CEN) break;
      const method = cd.getUint16(p + 10, true);
      let cSize = cd.getUint32(p + 20, true);
      let uSize = cd.getUint32(p + 24, true);
      const fnLen = cd.getUint16(p + 28, true);
      const exLen = cd.getUint16(p + 30, true);
      const cmLen = cd.getUint16(p + 32, true);
      let locOff = cd.getUint32(p + 42, true);
      const name = utf8.decode(raw.subarray(p + 46, p + 46 + fnLen));
      if (uSize === 0xffffffff || cSize === 0xffffffff || locOff === 0xffffffff){
        let e = p + 46 + fnLen; const end = e + exLen;
        while (e + 4 <= end){
          const hid = cd.getUint16(e, true), hsz = cd.getUint16(e + 2, true);
          if (hid === 1){
            let q = e + 4;
            if (uSize   === 0xffffffff){ uSize   = Number(cd.getBigUint64(q, true)); q += 8; }
            if (cSize   === 0xffffffff){ cSize   = Number(cd.getBigUint64(q, true)); q += 8; }
            if (locOff === 0xffffffff){ locOff = Number(cd.getBigUint64(q, true)); q += 8; }
            break;
          }
          e += 4 + hsz;
        }
      }
      if (!name.endsWith("/")) this.entries.push({ name, method, cSize, uSize, locOff });
      p += 46 + fnLen + exLen + cmLen;
    }
    return this.entries.length;
  }
  async range(start, len){
    if (this._buf && start >= this._s && start + len <= this._e){
      const o = start - this._s;
      return this._buf.subarray(o, o + len);
    }
    if (len > ZipReader.WINDOW / 4) return new Uint8Array(await this.file.slice(start, start + len).arrayBuffer());
    const end = Math.min(this.file.size, start + ZipReader.WINDOW);
    this._buf = new Uint8Array(await this.file.slice(start, end).arrayBuffer());
    this._s = start; this._e = end;
    return this._buf.subarray(0, len);
  }
  async dataOffset(e){
    const hit = this._off.get(e.locOff);
    if (hit !== undefined) return hit;
    const u8 = await this.range(e.locOff, 30);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== SIG_LOC) throw new Error("bad local header: " + e.name);
    const off = e.locOff + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
    this._off.set(e.locOff, off);
    return off;
  }
  async bytes(e){
    const raw = await this.range(await this.dataOffset(e), e.cSize);
    if (e.method === 0) return raw.slice();
    if (e.method !== 8) throw new Error("unsupported zip method " + e.method);
    return inflateRaw(raw);
  }
  async text(e){ return decodeText(await this.bytes(e)); }
  find(name){
    const n = name.toLowerCase();
    return this.entries.find(e => e.name.toLowerCase() === n) || null;
  }
}

// Minimal zip writer. Deflates unless the payload is already compressed.
export const NO_DEFLATE = /\.(png|jpe?g|webp|gif|avif|mp3|m4a|aac|ogg|opus|flac|zip|gz|tgz|docx|xlsx|pptx|pdf)$/i;

export async function zipWrite(files){
  const chunks = [], central = [];
  let offset = 0, n = 0;
  for (const f of files){
    const nameBytes = enc.encode(f.name);
    const data = f.bytes;
    const crc = crc32(data);
    let method = 0, payload = data;
    if (data.length > 256 && !NO_DEFLATE.test(f.name)){
      const z = await deflateRaw(data);
      if (z.length < data.length){ method = 8; payload = z; }
    }
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, SIG_LOC, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    chunks.push(lh, payload);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, SIG_CEN, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + payload.length;
    n++;
  }
  const cdBytes = concatBytes(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, n, true);
  ev.setUint16(10, n, true);
  ev.setUint32(12, cdBytes.length, true);
  ev.setUint32(16, offset, true);
  return concatBytes([...chunks, cdBytes, eocd]);
}

export function tarRead(u8){
  const out = [];
  let p = 0, longName = null;
  const str = (o, l) => {
    let s = "";
    for (let i = o; i < o + l; i++){ if (!u8[i]) break; s += String.fromCharCode(u8[i]); }
    return s;
  };
  while (p + 512 <= u8.length){
    if (u8[p] === 0){ p += 512; continue; }
    const name = str(p, 100);
    const sizeOct = str(p + 124, 12).trim();
    const size = parseInt(sizeOct, 8) || 0;
    const type = String.fromCharCode(u8[p + 156] || 48);
    const prefix = str(p + 345, 155);
    p += 512;
    const data = u8.subarray(p, p + size);
    p += Math.ceil(size / 512) * 512;
    if (type === "L"){ longName = utf8.decode(data).replace(/\0+$/, ""); continue; }
    if (type === "0" || type === "\0" || type === "48"){
      const full = longName || (prefix ? prefix + "/" + name : name);
      longName = null;
      out.push({ name: full, bytes: data.slice() });
    } else {
      longName = null;
    }
  }
  return out;
}

export function tarWrite(files){
  const blocks = [];
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  for (const f of files){
    const h = new Uint8Array(512);
    const put = (s, o, l) => { const b = enc.encode(s); h.set(b.subarray(0, l), o); };
    const name = f.name.length > 100 ? f.name.slice(-100) : f.name;
    put(name, 0, 100);
    put(oct(0o644, 8), 100, 8);
    put(oct(0, 8), 108, 8);
    put(oct(0, 8), 116, 8);
    put(oct(f.bytes.length, 12), 124, 12);
    put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
    for (let i = 148; i < 156; i++) h[i] = 32;
    h[156] = 48;
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(h, f.bytes);
    const pad = (512 - (f.bytes.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024));
  return concatBytes(blocks);
}
