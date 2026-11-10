// Bytes, text and stream helpers shared by every other module.

export const enc = new TextEncoder();

export const utf8 = new TextDecoder("utf-8");

export const idle = () => new Promise(r => setTimeout(r, 0));

export function escHtml(s){
  return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

export function fmtBytes(n){
  if (n < 1024) return n + " B";
  const u = ["KB","MB","GB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
}

export function baseName(name){
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export function extOf(name){
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function safeName(s){
  return String(s || "file")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/^\.+/, "").replace(/[. ]+$/, "")
    .slice(0, 120) || "file";
}

export function concatBytes(list){
  let n = 0;
  for (const a of list) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of list){ out.set(a, o); o += a.length; }
  return out;
}

export function bytesToB64(u8){
  let s = "";
  const C = 0x8000;
  for (let i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C));
  return btoa(s);
}

export function b64ToBytes(b64){
  const bin = atob(String(b64).replace(/[^A-Za-z0-9+/=]/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(u8, group){
  const H = "0123456789abcdef";
  let s = "", n = 0;
  for (let i = 0; i < u8.length; i++){
    s += H[u8[i] >> 4] + H[u8[i] & 15];
    if (group){
      n++;
      if (n % 16 === 0) s += "\n";
      else s += " ";
    }
  }
  return s;
}

export const latin1 = new TextDecoder("latin1");

// Decode bytes as text, honouring a BOM and falling back across encodings.
export function decodeText(u8){
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return utf8.decode(u8.subarray(3));
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder("utf-16le").decode(u8.subarray(2));
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder("utf-16be").decode(u8.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(u8);
  } catch (e){
    return new TextDecoder("windows-1252").decode(u8);
  }
}

export async function streamBytes(u8, transform){
  const src = new ReadableStream({ start(c){ c.enqueue(u8); c.close(); } });
  const res = new Response(transform ? src.pipeThrough(transform) : src);
  return new Uint8Array(await res.arrayBuffer());
}

export const gzip   = u8 => streamBytes(u8, new CompressionStream("gzip"));

export const gunzip = u8 => streamBytes(u8, new DecompressionStream("gzip"));

export const deflateRaw = u8 => streamBytes(u8, new CompressionStream("deflate-raw"));

export const inflateRaw = u8 => streamBytes(u8, new DecompressionStream("deflate-raw"));
// PDF FlateDecode streams carry a zlib wrapper, unlike zip's raw deflate.

export const inflate = u8 => streamBytes(u8, new DecompressionStream("deflate"));

export const deflateZlib = u8 => streamBytes(u8, new CompressionStream("deflate"));

export const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(u8){
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = (c >>> 8) ^ CRC_T[(c ^ u8[i]) & 255];
  return (c ^ -1) >>> 0;
}

export function xmlEsc(s){
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;" }[c]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}
