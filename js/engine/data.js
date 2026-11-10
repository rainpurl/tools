// dBase, SQLite, SQL, HAR and the binary interchange formats.

import { concatBytes, enc, utf8 } from "./util.js";

export function dbfToSheets(u8, name){
  if (u8.length < 32) throw new Error("file too short to be a dbf");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const nRecords = dv.getUint32(4, true);
  const headerLen = dv.getUint16(8, true);
  const recordLen = dv.getUint16(10, true);
  if (headerLen < 33 || recordLen < 1) throw new Error("not a dbf file");

  const fields = [];
  for (let p = 32; p + 32 <= headerLen && u8[p] !== 0x0d && u8[p] !== 0x00; p += 32){
    let nm = "";
    for (let i = 0; i < 11 && u8[p + i]; i++) nm += String.fromCharCode(u8[p + i]);
    fields.push({ name: nm.trim(), type: String.fromCharCode(u8[p + 11]), len: u8[p + 16], dec: u8[p + 17] });
  }
  if (!fields.length) throw new Error("no field descriptors in this dbf");

  const dec = new TextDecoder("windows-1252");
  const rows = [];
  let off = headerLen;
  for (let r = 0; r < nRecords && off + recordLen <= u8.length; r++, off += recordLen){
    if (u8[off] === 0x2a) continue;
    let p = off + 1;
    const row = [];
    for (const f of fields){
      const raw = dec.decode(u8.subarray(p, p + f.len)).trim();
      p += f.len;
      if (f.type === "L") row.push(/^[YyTt]$/.test(raw) ? "TRUE" : /^[NnFf]$/.test(raw) ? "FALSE" : "");
      else if (f.type === "D" && /^\d{8}$/.test(raw)) row.push(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
      else row.push(raw);
    }
    rows.push(row);
  }
  return [{ name: name || "Records", headers: fields.map(f => f.name), rows }];
}

export function sheetsToSql(sheets, opts){
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const lit = v => {
    if (v === "" || v === null || v === undefined) return "NULL";
    const s = String(v).trim();
    if (/^-?\d+$/.test(s) && s.length < 16) return s;
    if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(s)) return s;
    return "'" + String(v).replace(/'/g, "''") + "'";
  };
  const typeOf = (sh, i) => {
    const vals = sh.rows.map(r => String(r[i] ?? "").trim()).filter(Boolean);
    if (!vals.length) return "TEXT";
    if (vals.every(v => /^-?\d+$/.test(v) && v.length < 16)) return "INTEGER";
    if (vals.every(v => /^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(v))) return "REAL";
    return "TEXT";
  };
  const out = [];
  for (const sh of sheets){
    const tbl = (sh.name || "data").replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "t$1") || "data";
    const cols = sh.headers.length ? sh.headers : (sh.rows[0] || []).map((_, i) => "column_" + (i + 1));
    if (opts.sqlDrop !== false) out.push(`DROP TABLE IF EXISTS ${q(tbl)};`);
    out.push(`CREATE TABLE ${q(tbl)} (\n` + cols.map((c, i) => `  ${q(c)} ${typeOf(sh, i)}`).join(",\n") + "\n);");
    out.push("");
    for (const r of sh.rows){
      out.push(`INSERT INTO ${q(tbl)} (${cols.map(q).join(", ")}) VALUES (${cols.map((_, i) => lit(r[i])).join(", ")});`);
    }
    out.push("");
  }
  return out.join("\n");
}

export function harToSheets(text){
  const har = JSON.parse(text);
  const entries = ((har.log || {}).entries) || [];
  if (!entries.length) throw new Error("no entries in this HAR file");
  const headers = ["started","method","url","status","statusText","mimeType","bodySize","headerSize","time","serverIP"];
  return [{ name: "Requests", headers, rows: entries.map(e => [
    e.startedDateTime || "", (e.request || {}).method || "", (e.request || {}).url || "",
    String((e.response || {}).status ?? ""), (e.response || {}).statusText || "",
    (((e.response || {}).content) || {}).mimeType || "",
    String((e.response || {}).bodySize ?? ""), String((e.response || {}).headersSize ?? ""),
    String(Math.round(e.time ?? 0)), e.serverIPAddress || ""
  ]) }];
}

export function sqliteRead(u8, opts){
  if (utf8.decode(u8.subarray(0, 15)) !== "SQLite format 3")
    throw new Error("not a sqlite database");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pageSize = dv.getUint16(16);
  if (pageSize === 1) pageSize = 65536;
  const reserved = u8[20];
  const usable = pageSize - reserved;
  const encoding = dv.getUint32(56) || 1;
  const decoder = encoding === 2 ? new TextDecoder("utf-16le")
    : encoding === 3 ? new TextDecoder("utf-16be") : utf8;

  const page = n => {
    const off = (n - 1) * pageSize;
    if (off < 0 || off + 1 > u8.length) throw new Error("page " + n + " is outside the file");
    return off;
  };
  const varint = (off) => {
    let v = 0n, i = 0;
    for (; i < 8; i++){
      const b = u8[off + i];
      v = (v << 7n) | BigInt(b & 0x7f);
      if (!(b & 0x80)) return [v, i + 1];
    }
    v = (v << 8n) | BigInt(u8[off + 8]);
    return [v, 9];
  };

  const payload = (off, size, isTableLeaf) => {
    const maxLocal = isTableLeaf ? usable - 35 : ((usable - 12) * 64 / 255 | 0) - 23;
    const minLocal = ((usable - 12) * 32 / 255 | 0) - 23;
    if (size <= maxLocal) return u8.subarray(off, off + size);
    let local = minLocal + ((size - minLocal) % (usable - 4));
    if (local > maxLocal) local = minLocal;
    const parts = [u8.subarray(off, off + local)];
    let next = dv.getUint32(off + local);
    let left = size - local;
    const seen = new Set();
    while (next && left > 0){
      if (seen.has(next)) throw new Error("overflow page loop at page " + next);
      seen.add(next);
      const p = page(next);
      const take = Math.min(left, usable - 4);
      parts.push(u8.subarray(p + 4, p + 4 + take));
      left -= take;
      next = dv.getUint32(p);
    }
    return concatBytes(parts);
  };

  const record = (bytes, rowid) => {
    let [hdrLen, n] = varint(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const vi = off => {
      let v = 0n, i = 0;
      for (; i < 8; i++){
        const b = bytes[off + i];
        v = (v << 7n) | BigInt(b & 0x7f);
        if (!(b & 0x80)) return [v, i + 1];
      }
      v = (v << 8n) | BigInt(bytes[off + 8]);
      return [v, 9];
    };
    [hdrLen, n] = vi(0);
    const types = [];
    let p = n;
    const hdrEnd = Number(hdrLen);
    while (p < hdrEnd){
      const [t, used] = vi(p);
      types.push(Number(t));
      p += used;
    }
    let d = hdrEnd;
    const vals = [];
    for (const t of types){
      if (t === 0){ vals.push(null); continue; }
      if (t >= 1 && t <= 6){
        const len = [0, 1, 2, 3, 4, 6, 8][t];
        let v = 0n;
        for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(bytes[d + i]);
        const bits = BigInt(len * 8);
        if (v >> (bits - 1n)) v -= 1n << bits;
        vals.push(v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString());
        d += len;
        continue;
      }
      if (t === 7){ vals.push(view.getFloat64(d)); d += 8; continue; }
      if (t === 8){ vals.push(0); continue; }
      if (t === 9){ vals.push(1); continue; }
      if (t >= 12 && t % 2 === 0){
        const len = (t - 12) / 2;
        vals.push(`<blob ${len} bytes>`);
        d += len;
        continue;
      }
      if (t >= 13){
        const len = (t - 13) / 2;
        vals.push(decoder.decode(bytes.subarray(d, d + len)));
        d += len;
        continue;
      }
      vals.push(null);
    }
    return { vals, rowid };
  };

  const rows = (root, limit) => {
    const out = [];
    const seen = new Set();
    const visit = pno => {
      if (out.length >= limit || seen.has(pno)) return;
      seen.add(pno);
      const base = page(pno);
      const hdr = pno === 1 ? base + 100 : base;
      const type = u8[hdr];
      const nCells = dv.getUint16(hdr + 3);
      const cellPtr = hdr + (type === 2 || type === 5 ? 12 : 8);
      if (type === 5){
        for (let i = 0; i < nCells; i++){
          const c = base + dv.getUint16(cellPtr + i * 2);
          visit(dv.getUint32(c));
          if (out.length >= limit) return;
        }
        visit(dv.getUint32(hdr + 8));
        return;
      }
      if (type !== 13) return;
      for (let i = 0; i < nCells; i++){
        if (out.length >= limit) return;
        let c = base + dv.getUint16(cellPtr + i * 2);
        const [size, n1] = varint(c); c += n1;
        const [rowid, n2] = varint(c); c += n2;
        out.push(record(payload(c, Number(size), true), Number(rowid)));
      }
    };
    visit(root);
    return out;
  };

  const columnsOf = (sql, tbl) => {
    const open = sql.indexOf("(");
    if (open < 0) return null;
    let depth = 0, end = -1;
    for (let i = open; i < sql.length; i++){
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")"){ depth--; if (!depth){ end = i; break; } }
    }
    if (end < 0) return null;
    const body = sql.slice(open + 1, end);
    const parts = [];
    let buf = "", d = 0, q = null;
    for (const ch of body){
      if (q){ buf += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`" || ch === "["){ q = ch === "[" ? "]" : ch; buf += ch; continue; }
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0){ parts.push(buf); buf = ""; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    const cols = [], rowidAliases = [];
    for (const raw of parts){
      const t = raw.trim();
      if (!t || /^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(t)) continue;
      const m = t.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/);
      if (!m) continue;
      const name = m[1] ?? m[2] ?? m[3] ?? m[4];
      cols.push(name);
      if (/\bintegers?\s+primary\s+key\b/i.test(t)) rowidAliases.push(cols.length - 1);
    }
    return cols.length ? { cols, rowidAliases } : null;
  };

  const master = rows(1, 100000);
  const sheets = [];
  const limit = +opts.sqliteLimit > 0 ? +opts.sqliteLimit : 200000;
  for (const r of master){
    const [type, name, tblName, rootpage, sql] = r.vals;
    if (type !== "table" || !rootpage) continue;
    if (/^sqlite_/i.test(String(name)) && opts.sqliteInternal !== true) continue;
    const info = columnsOf(String(sql || ""), name);
    let data;
    try { data = rows(Number(rootpage), limit); }
    catch (e){ continue; }
    const width = Math.max(info ? info.cols.length : 0, ...data.map(d => d.vals.length), 1);
    const headers = info && info.cols.length >= width
      ? info.cols.slice(0, width)
      : Array.from({ length: width }, (_, i) => (info && info.cols[i]) || "column_" + (i + 1));
    const outRows = data.map(d => {
      const vals = Array.from({ length: width }, (_, i) => d.vals[i]);
      if (info) for (const idx of info.rowidAliases) if (vals[idx] === null || vals[idx] === undefined) vals[idx] = d.rowid;
      return vals.map(v => v === null || v === undefined ? "" : String(v));
    });
    sheets.push({ name: String(name).slice(0, 31), headers, rows: outRows });
  }
  if (!sheets.length) throw new Error("no readable tables in this database");
  return sheets;
}

export function msgpackDecode(u8){
  let p = 0;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = n => { const s = utf8.decode(u8.subarray(p, p + n)); p += n; return s; };
  const bin = n => { p += n; return `<bin ${n} bytes>`; };
  const read = () => {
    if (p >= u8.length) throw new Error("truncated messagepack data");
    const b = u8[p++];
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 256;
    if ((b & 0xf0) === 0x80){ const n = b & 15, o = {}; for (let i = 0; i < n; i++){ const k = read(); o[String(k)] = read(); } return o; }
    if ((b & 0xf0) === 0x90){ const n = b & 15, a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
    if ((b & 0xe0) === 0xa0) return str(b & 31);
    switch (b){
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u8[p++]);
      case 0xc5: { const n = dv.getUint16(p); p += 2; return bin(n); }
      case 0xc6: { const n = dv.getUint32(p); p += 4; return bin(n); }
      case 0xca: { const v = dv.getFloat32(p); p += 4; return v; }
      case 0xcb: { const v = dv.getFloat64(p); p += 8; return v; }
      case 0xcc: return u8[p++];
      case 0xcd: { const v = dv.getUint16(p); p += 2; return v; }
      case 0xce: { const v = dv.getUint32(p); p += 4; return v; }
      case 0xcf: { const v = dv.getBigUint64(p); p += 8; return v <= 9007199254740991n ? Number(v) : v.toString(); }
      case 0xd0: { const v = dv.getInt8(p); p += 1; return v; }
      case 0xd1: { const v = dv.getInt16(p); p += 2; return v; }
      case 0xd2: { const v = dv.getInt32(p); p += 4; return v; }
      case 0xd3: { const v = dv.getBigInt64(p); p += 8; return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : v.toString(); }
      case 0xd9: return str(u8[p++]);
      case 0xda: { const n = dv.getUint16(p); p += 2; return str(n); }
      case 0xdb: { const n = dv.getUint32(p); p += 4; return str(n); }
      case 0xdc: { const n = dv.getUint16(p); p += 2; const a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
      case 0xdd: { const n = dv.getUint32(p); p += 4; const a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
      case 0xde: { const n = dv.getUint16(p); p += 2; const o = {}; for (let i = 0; i < n; i++){ const k = read(); o[String(k)] = read(); } return o; }
      case 0xdf: { const n = dv.getUint32(p); p += 4; const o = {}; for (let i = 0; i < n; i++){ const k = read(); o[String(k)] = read(); } return o; }
      case 0xc1: throw new Error("messagepack byte 0xc1 is never valid");
      default: {
        const fixed = { 0xd4:1, 0xd5:2, 0xd6:4, 0xd7:8, 0xd8:16 };
        if (fixed[b] !== undefined){
          const type = dv.getInt8(p); p += 1;
          const n = fixed[b];
          if (type === -1){
            if (n === 4){ const t = dv.getUint32(p); p += 4; return new Date(t * 1000).toISOString(); }
            if (n === 8){ const hi = dv.getUint32(p), lo = dv.getUint32(p + 4); p += 8;
              const secs = ((BigInt(hi) & 0x3n) << 32n) | BigInt(lo);
              return new Date(Number(secs) * 1000).toISOString(); }
          }
          p += n;
          return `<ext ${type}, ${n} bytes>`;
        }
        if (b === 0xc7 || b === 0xc8 || b === 0xc9){
          const n = b === 0xc7 ? u8[p++] : b === 0xc8 ? (dv.getUint16(p) + (p += 2, 0)) : (dv.getUint32(p) + (p += 4, 0));
          const type = dv.getInt8(p); p += 1;
          if (type === -1 && n === 12){
            const ns = dv.getUint32(p), secs = dv.getBigInt64(p + 4); p += 12;
            return new Date(Number(secs) * 1000 + ns / 1e6).toISOString();
          }
          p += n;
          return `<ext ${type}, ${n} bytes>`;
        }
        throw new Error("unsupported messagepack byte 0x" + b.toString(16));
      }
    }
  };
  return read();
}

export function msgpackEncode(value){
  const parts = [];
  const u8n = (...b) => parts.push(Uint8Array.from(b));
  const be = (n, bytes) => {
    const a = new Uint8Array(bytes);
    const dv = new DataView(a.buffer);
    if (bytes === 2) dv.setUint16(0, n); else if (bytes === 4) dv.setUint32(0, n); else dv.setFloat64(0, n);
    parts.push(a);
  };
  const write = v => {
    if (v === null || v === undefined) return u8n(0xc0);
    if (typeof v === "boolean") return u8n(v ? 0xc3 : 0xc2);
    if (typeof v === "number"){
      if (Number.isInteger(v)){
        if (v >= 0 && v <= 0x7f) return u8n(v);
        if (v < 0 && v >= -32) return u8n(v + 256);
        if (v >= 0 && v <= 0xff) return u8n(0xcc, v);
        if (v >= 0 && v <= 0xffff){ u8n(0xcd); return be(v, 2); }
        if (v >= 0 && v <= 0xffffffff){ u8n(0xce); return be(v, 4); }
        if (v >= 0 && Number.isSafeInteger(v)){
          u8n(0xcf);
          const a = new Uint8Array(8);
          new DataView(a.buffer).setBigUint64(0, BigInt(v));
          return parts.push(a);
        }
        if (v < 0 && v >= -128) return u8n(0xd0, v & 0xff);
        if (v < 0 && v >= -32768){ u8n(0xd1); const a = new Uint8Array(2); new DataView(a.buffer).setInt16(0, v); return parts.push(a); }
        if (v < 0 && v >= -2147483648){ u8n(0xd2); const a = new Uint8Array(4); new DataView(a.buffer).setInt32(0, v); return parts.push(a); }
        if (v < 0 && Number.isSafeInteger(v)){
          u8n(0xd3);
          const a = new Uint8Array(8);
          new DataView(a.buffer).setBigInt64(0, BigInt(v));
          return parts.push(a);
        }
      }
      u8n(0xcb);
      return be(v, 8);
    }
    if (typeof v === "string"){
      const b = enc.encode(v);
      if (b.length < 32) u8n(0xa0 | b.length);
      else if (b.length < 256) u8n(0xd9, b.length);
      else if (b.length < 65536){ u8n(0xda); be(b.length, 2); }
      else { u8n(0xdb); be(b.length, 4); }
      return parts.push(b);
    }
    if (Array.isArray(v)){
      if (v.length < 16) u8n(0x90 | v.length);
      else if (v.length < 65536){ u8n(0xdc); be(v.length, 2); }
      else { u8n(0xdd); be(v.length, 4); }
      for (const x of v) write(x);
      return;
    }
    const ks = Object.keys(v);
    if (ks.length < 16) u8n(0x80 | ks.length);
    else if (ks.length < 65536){ u8n(0xde); be(ks.length, 2); }
    else { u8n(0xdf); be(ks.length, 4); }
    for (const k of ks){ write(k); write(v[k]); }
  };
  write(value);
  return concatBytes(parts);
}

export function cborDecode(u8){
  let p = 0;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = ai => {
    if (ai < 24) return ai;
    if (ai === 24) return u8[p++];
    if (ai === 25){ const v = dv.getUint16(p); p += 2; return v; }
    if (ai === 26){ const v = dv.getUint32(p); p += 4; return v; }
    if (ai === 27){ const v = dv.getBigUint64(p); p += 8; return Number(v); }
    if (ai === 31) return -1;
    throw new Error("bad cbor additional info " + ai);
  };
  const read = () => {
    if (p >= u8.length) throw new Error("truncated cbor data");
    const b = u8[p++];
    const major = b >> 5, ai = b & 31;
    switch (major){
      case 0: return len(ai);
      case 1: return -1 - len(ai);
      case 2: {
        const n = len(ai);
        if (n < 0){ let total = 0; while (u8[p] !== 0xff){ const c = read(); total += String(c).length; } p++; return `<bin chunks>`; }
        p += n; return `<bin ${n} bytes>`;
      }
      case 3: {
        const n = len(ai);
        if (n < 0){ let s = ""; while (u8[p] !== 0xff) s += read(); p++; return s; }
        const s = utf8.decode(u8.subarray(p, p + n)); p += n; return s;
      }
      case 4: {
        const n = len(ai);
        const a = [];
        if (n < 0){ while (u8[p] !== 0xff) a.push(read()); p++; return a; }
        for (let i = 0; i < n; i++) a.push(read());
        return a;
      }
      case 5: {
        const n = len(ai);
        const o = {};
        if (n < 0){ while (u8[p] !== 0xff){ const k = read(); o[String(k)] = read(); } p++; return o; }
        for (let i = 0; i < n; i++){ const k = read(); o[String(k)] = read(); }
        return o;
      }
      case 6: {
        const tag = len(ai);
        const v = read();
        if (tag === 0) return v;
        if (tag === 1) return new Date(Number(v) * 1000).toISOString();
        return v;
      }
      case 7: {
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        if (ai === 23) return null;
        if (ai === 25){ const h = dv.getUint16(p); p += 2; return halfFloat(h); }
        if (ai === 26){ const v = dv.getFloat32(p); p += 4; return v; }
        if (ai === 27){ const v = dv.getFloat64(p); p += 8; return v; }
        if (ai === 31) return undefined;
        return null;
      }
    }
  };
  return read();
}

export function halfFloat(h){
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 31;
  const frac = h & 1023;
  if (exp === 0) return sign * frac * Math.pow(2, -24);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (frac + 1024) * Math.pow(2, exp - 25);
}

export function cborEncode(value){
  const parts = [];
  const head = (major, n) => {
    if (n < 24) parts.push(Uint8Array.from([(major << 5) | n]));
    else if (n < 256) parts.push(Uint8Array.from([(major << 5) | 24, n]));
    else if (n < 65536){ const a = new Uint8Array(3); a[0] = (major << 5) | 25; new DataView(a.buffer).setUint16(1, n); parts.push(a); }
    else if (n <= 0xffffffff){ const a = new Uint8Array(5); a[0] = (major << 5) | 26; new DataView(a.buffer).setUint32(1, n); parts.push(a); }
    else { const a = new Uint8Array(9); a[0] = (major << 5) | 27; new DataView(a.buffer).setBigUint64(1, BigInt(n)); parts.push(a); }
  };
  const write = v => {
    if (v === null || v === undefined) return parts.push(Uint8Array.from([0xf6]));
    if (typeof v === "boolean") return parts.push(Uint8Array.from([v ? 0xf5 : 0xf4]));
    if (typeof v === "number"){
      if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
      const a = new Uint8Array(9);
      a[0] = 0xfb;
      new DataView(a.buffer).setFloat64(1, v);
      return parts.push(a);
    }
    if (typeof v === "string"){ const b = enc.encode(v); head(3, b.length); return parts.push(b); }
    if (Array.isArray(v)){ head(4, v.length); v.forEach(write); return; }
    const ks = Object.keys(v);
    head(5, ks.length);
    for (const k of ks){ write(k); write(v[k]); }
  };
  write(value);
  return concatBytes(parts);
}

export function bsonDecode(u8, top){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const readDoc = (off) => {
    const size = dv.getInt32(off, true);
    const end = off + size - 1;
    let p = off + 4;
    const out = {};
    const keys = [];
    while (p < end){
      const type = u8[p++];
      if (!type) break;
      let z = p;
      while (z < u8.length && u8[z]) z++;
      const key = utf8.decode(u8.subarray(p, z));
      p = z + 1;
      let v;
      switch (type){
        case 0x01: v = dv.getFloat64(p, true); p += 8; break;
        case 0x02: { const n = dv.getInt32(p, true); p += 4; v = utf8.decode(u8.subarray(p, p + n - 1)); p += n; break; }
        case 0x03: { const r = readDoc(p); v = r.value; p += r.size; break; }
        case 0x04: { const r = readDoc(p); v = Object.values(r.value); p += r.size; break; }
        case 0x05: { const n = dv.getInt32(p, true); p += 4 + 1 + n; v = `<binary ${n} bytes>`; break; }
        case 0x07: { v = [...u8.subarray(p, p + 12)].map(x => x.toString(16).padStart(2, "0")).join(""); p += 12; break; }
        case 0x08: v = !!u8[p]; p += 1; break;
        case 0x09: { const ms = dv.getBigInt64(p, true); p += 8; v = new Date(Number(ms)).toISOString(); break; }
        case 0x0a: v = null; break;
        case 0x0b: { let a = p; while (u8[a]) a++; const re = utf8.decode(u8.subarray(p, a)); p = a + 1;
                     let b2 = p; while (u8[b2]) b2++; const fl = utf8.decode(u8.subarray(p, b2)); p = b2 + 1;
                     v = `/${re}/${fl}`; break; }
        case 0x10: v = dv.getInt32(p, true); p += 4; break;
        case 0x11: { const t = dv.getBigUint64(p, true); p += 8; v = t.toString(); break; }
        case 0x12: { const n = dv.getBigInt64(p, true); p += 8;
                     v = (n >= -9007199254740991n && n <= 9007199254740991n) ? Number(n) : n.toString(); break; }
        case 0x13: { p += 16; v = "<decimal128>"; break; }
        case 0xff: v = null; p += 0; break;
        case 0x7f: v = null; break;
        default: throw new Error("unsupported bson type 0x" + type.toString(16));
      }
      out[key] = v;
      keys.push(key);
    }
    return { value: out, size, keys };
  };
  if (u8.length < 5) throw new Error("file too short to be bson");
  const first = readDoc(0);
  const docs = [first.value];
  let p = first.size;
  while (p + 5 <= u8.length){
    const size = dv.getInt32(p, true);
    if (size < 5 || p + size > u8.length) break;
    docs.push(readDoc(p).value);
    p += size;
  }
  return docs.length > 1 ? docs : first.value;
}

export function bplistDecode(u8){
  if (utf8.decode(u8.subarray(0, 6)) !== "bplist") throw new Error("not a binary property list");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const trailer = u8.length - 32;
  const offSize = u8[trailer + 6];
  const refSize = u8[trailer + 7];
  const numObjects = Number(dv.getBigUint64(trailer + 8));
  const topObject = Number(dv.getBigUint64(trailer + 16));
  const offsetTableOffset = Number(dv.getBigUint64(trailer + 24));
  const readSized = (off, size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + u8[off + i];
    return v;
  };
  const offsets = [];
  for (let i = 0; i < numObjects; i++) offsets.push(readSized(offsetTableOffset + i * offSize, offSize));

  const seen = new Set();
  const obj = idx => {
    if (idx >= offsets.length) return null;
    if (seen.has(idx)) return "<cycle>";
    const off = offsets[idx];
    const marker = u8[off];
    const type = marker >> 4, info = marker & 15;
    const lengthAt = p => {
      if (info !== 15) return [info, p];
      const m = u8[p];
      const n = 1 << (m & 15);
      return [readSized(p + 1, n), p + 1 + n];
    };
    switch (type){
      case 0x0:
        return info === 0 ? null : info === 8 ? false : info === 9 ? true : null;
      case 0x1: { const n = 1 << info; let v = 0n;
        for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(u8[off + 1 + i]);
        if (n === 8 && (v >> 63n)) v -= 1n << 64n;
        return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString(); }
      case 0x2: return info === 2 ? dv.getFloat32(off + 1) : dv.getFloat64(off + 1);
      case 0x3: return new Date(Date.UTC(2001, 0, 1) + dv.getFloat64(off + 1) * 1000).toISOString();
      case 0x4: { const [n] = lengthAt(off + 1); return `<data ${n} bytes>`; }
      case 0x5: { const [n, p] = lengthAt(off + 1); return utf8.decode(u8.subarray(p, p + n)); }
      case 0x6: { const [n, p] = lengthAt(off + 1);
        let s = "";
        for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + i * 2));
        return s; }
      case 0x8: return "<uid>";
      case 0xa: case 0xc: { const [n, p] = lengthAt(off + 1);
        seen.add(idx);
        const a = [];
        for (let i = 0; i < n; i++) a.push(obj(readSized(p + i * refSize, refSize)));
        seen.delete(idx);
        return a; }
      case 0xd: { const [n, p] = lengthAt(off + 1);
        seen.add(idx);
        const o = {};
        for (let i = 0; i < n; i++){
          const k = obj(readSized(p + i * refSize, refSize));
          o[String(k)] = obj(readSized(p + n * refSize + i * refSize, refSize));
        }
        seen.delete(idx);
        return o; }
      default: return null;
    }
  };
  return obj(topObject);
}
