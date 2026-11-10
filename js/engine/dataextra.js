// More data formats: NumPy arrays, Parquet, and the BibTeX and RIS reference lists.

import { useModule } from "./modules.js";
import { objectsToSheet, rowsToSheet } from "./table.js";
import { latin1 } from "./util.js";

/* ---- NumPy .npy --------------------------------------------------------- */

export function npyToSheets(u8, name){
  if (u8[0] !== 0x93 || latin1.decode(u8.subarray(1, 6)) !== "NUMPY") throw new Error("not a NumPy file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const major = u8[6];
  const hlen = major >= 2 ? dv.getUint32(8, true) : dv.getUint16(8, true);
  const start = (major >= 2 ? 12 : 10) + hlen;
  const header = latin1.decode(u8.subarray(major >= 2 ? 12 : 10, start));
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header);
  const shapeM = /'shape'\s*:\s*\(([^)]*)\)/.exec(header);
  if (!descr || !shapeM) throw new Error("this NumPy file holds a structured array, which is not supported");
  const fortran = /'fortran_order'\s*:\s*True/.test(header);
  const shape = shapeM[1].split(",").map(s => s.trim()).filter(Boolean).map(Number);
  const m = /^([<>|=]?)([biufcSUO?])(\d*)$/.exec(descr[1]);
  if (!m || m[2] === "O" || m[2] === "c") throw new Error(`NumPy type ${descr[1]} is not supported`);
  const le = m[1] !== ">", type = m[2], size = type === "?" ? 1 : +m[3] || 1;
  const total = shape.reduce((a, b) => a * b, 1);
  const step = type === "U" ? size * 4 : size;
  const read = i => {
    const o = start + i * step;
    switch (type){
      case "?": return u8[o] ? "True" : "False";
      case "b": return u8[o] ? "True" : "False";
      case "i": return String(size === 1 ? dv.getInt8(o) : size === 2 ? dv.getInt16(o, le) : size === 4 ? dv.getInt32(o, le) : dv.getBigInt64(o, le));
      case "u": return String(size === 1 ? u8[o] : size === 2 ? dv.getUint16(o, le) : size === 4 ? dv.getUint32(o, le) : dv.getBigUint64(o, le));
      case "f": {
        if (size === 2){
          const h = dv.getUint16(o, le), e = (h >> 10) & 31, f = h & 1023, s = h >> 15 ? -1 : 1;
          return String(e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15));
        }
        return String(size === 4 ? +dv.getFloat32(o, le).toPrecision(7) : dv.getFloat64(o, le));
      }
      case "S": return latin1.decode(u8.subarray(o, o + size)).replace(/\0+$/, "");
      case "U": {
        let s = "";
        for (let k = 0; k < size; k++){ const cp = dv.getUint32(o + k * 4, le); if (cp) s += String.fromCodePoint(cp); }
        return s;
      }
      default: return "";
    }
  };
  if (start + total * step > u8.length) throw new Error("this NumPy file is cut short");
  // rows are the first axis; everything after it is spread across the columns
  const nrows = shape.length ? shape[0] : 1;
  const ncols = shape.length > 1 ? total / nrows : 1;
  const rows = [];
  for (let r = 0; r < nrows; r++){
    const line = [];
    for (let c = 0; c < ncols; c++) line.push(read(fortran && shape.length === 2 ? c * nrows + r : r * ncols + c));
    rows.push(line);
  }
  return [rowsToSheet(rows, name, false)];
}

/* ---- Parquet ------------------------------------------------------------ */

export async function parquetToSheets(u8, name, opts){
  const lib = await useModule("parquet", opts);
  const file = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  let rows;
  try { rows = await lib.parquetReadObjects({ file }); }
  catch (e){
    if (/compress|codec/i.test(e.message || "")) throw new Error("this Parquet file uses a compression other than Snappy, which is not supported yet");
    throw e;
  }
  const flat = v => v === null || v === undefined ? "" : typeof v === "bigint" ? v.toString()
    : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() : x) : v;
  return [objectsToSheet(rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, flat(v)]))), name)];
}

/* ---- BibTeX ------------------------------------------------------------- */

export function bibToSheets(text, name){
  const rows = [];
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && /[\s,]/.test(text[i])) i++; };
  const value = () => {
    // a value is one or more pieces joined by #
    let out = "";
    for (;;){
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === "{"){
        let depth = 0, s = "";
        do {
          const ch = text[i++];
          if (ch === "{"){ if (depth) s += ch; depth++; }
          else if (ch === "}"){ depth--; if (depth) s += ch; }
          else s += ch;
        } while (i < n && depth > 0);
        out += s;
      } else if (text[i] === '"'){
        i++;
        let s = "", depth = 0;
        while (i < n && (text[i] !== '"' || depth)){ if (text[i] === "{") depth++; if (text[i] === "}") depth--; s += text[i++]; }
        i++;
        out += s;
      } else {
        let s = "";
        while (i < n && /[^\s,#}]/.test(text[i])) s += text[i++];
        out += s;
      }
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === "#"){ i++; continue; }
      return out.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    }
  };
  while (i < n){
    const at = text.indexOf("@", i);
    if (at < 0) break;
    i = at + 1;
    let type = "";
    while (i < n && /[A-Za-z]/.test(text[i])) type += text[i++];
    while (i < n && /\s/.test(text[i])) i++;
    if (text[i] !== "{" && text[i] !== "(") continue;
    i++;
    type = type.toLowerCase();
    if (type === "comment" || type === "preamble" || type === "string"){
      let depth = 1;
      while (i < n && depth){ if (text[i] === "{") depth++; else if (text[i] === "}") depth--; i++; }
      continue;
    }
    let key = "";
    while (i < n && !/[,}\s]/.test(text[i])) key += text[i++];
    const row = { type, key };
    for (;;){
      ws();
      if (i >= n || text[i] === "}" || text[i] === ")"){ i++; break; }
      let field = "";
      while (i < n && /[^\s=,}]/.test(text[i])) field += text[i++];
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] !== "="){ if (!field) i++; continue; }
      i++;
      row[field.toLowerCase()] = value();
    }
    rows.push(row);
  }
  if (!rows.length) throw new Error("no BibTeX entries were found");
  return [objectsToSheet(rows, name)];
}

const pick = (sheet, row, names) => {
  for (const nm of names){
    const k = sheet.headers.findIndex(h => String(h).toLowerCase().trim() === nm);
    if (k >= 0 && row[k] !== undefined && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return "";
};

export function sheetsToBib(sheets){
  const out = [];
  const used = new Set();
  for (const sh of sheets) sh.rows.forEach((row, n) => {
    const type = (pick(sh, row, ["type", "entrytype"]) || "misc").toLowerCase().replace(/[^a-z]/g, "") || "misc";
    let key = pick(sh, row, ["key", "id", "citekey", "citationkey"]);
    if (!key){
      const author = (pick(sh, row, ["author"]).split(/,| and /)[0] || "ref").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");
      key = (author || "ref") + (pick(sh, row, ["year"]) || n + 1);
    }
    key = key.replace(/[\s,{}]/g, "");
    let k = key, c = 1;
    while (used.has(k)) k = key + String.fromCharCode(96 + ++c);
    used.add(k);
    const fields = [];
    sh.headers.forEach((h, i) => {
      const name = String(h).toLowerCase().trim().replace(/\s+/g, "");
      const v = row[i] === undefined || row[i] === null ? "" : String(row[i]).trim();
      if (!v || ["type", "entrytype", "key", "id", "citekey", "citationkey"].includes(name) || !/^[a-z][a-z0-9_-]*$/.test(name)) return;
      fields.push(`  ${name} = {${v}}`);
    });
    out.push(`@${type}{${k},\n${fields.join(",\n")}\n}`);
  });
  return out.join("\n\n") + "\n";
}

/* ---- RIS ---------------------------------------------------------------- */

const RIS_TYPE = { JOUR: "article", BOOK: "book", CHAP: "incollection", CONF: "inproceedings", CPAPER: "inproceedings",
  THES: "phdthesis", RPRT: "techreport", GEN: "misc", ELEC: "misc", MGZN: "article", NEWS: "article", UNPB: "unpublished" };
const BIB_TYPE = { article: "JOUR", book: "BOOK", incollection: "CHAP", inbook: "CHAP", inproceedings: "CONF", conference: "CONF",
  phdthesis: "THES", mastersthesis: "THES", techreport: "RPRT", misc: "GEN", unpublished: "UNPB", online: "ELEC" };
const RIS_FIELD = { TI: "title", T1: "title", PY: "year", Y1: "year", JO: "journal", JF: "journal", T2: "journal", VL: "volume",
  IS: "number", DO: "doi", UR: "url", AB: "abstract", N2: "abstract", PB: "publisher", SN: "issn", ID: "key", CY: "address",
  LA: "language", ED: "editor", N1: "note", BT: "booktitle" };

export function risToSheets(text, name){
  const rows = [];
  let cur = null, sp = "", ep = "";
  const end = () => {
    if (!cur) return;
    if (cur._au.length) cur.author = cur._au.join(" and ");
    if (cur._kw.length) cur.keywords = cur._kw.join(", ");
    if (sp) cur.pages = ep && ep !== sp ? `${sp}--${ep}` : sp;
    delete cur._au; delete cur._kw;
    if (cur.year) cur.year = (/\d{4}/.exec(cur.year) || [cur.year])[0];
    rows.push(cur);
    cur = null; sp = ""; ep = "";
  };
  for (const line of text.split(/\r?\n/)){
    const m = /^([A-Z][A-Z0-9])\s\s?-\s?(.*)$/.exec(line);
    if (!m) continue;
    const tagName = m[1], v = m[2].trim();
    if (tagName === "TY"){ end(); cur = { type: RIS_TYPE[v] || "misc", key: "", _au: [], _kw: [] }; continue; }
    if (!cur) continue;
    if (tagName === "ER"){ end(); continue; }
    if (!v) continue;
    if (tagName === "AU" || tagName === "A1" || tagName === "A2") cur._au.push(v);
    else if (tagName === "KW") cur._kw.push(v);
    else if (tagName === "SP") sp = v;
    else if (tagName === "EP") ep = v;
    else if (RIS_FIELD[tagName]){ if (!cur[RIS_FIELD[tagName]]) cur[RIS_FIELD[tagName]] = v; }
    else cur[tagName.toLowerCase()] = v;
  }
  end();
  if (!rows.length) throw new Error("no RIS records were found");
  return [objectsToSheet(rows, name)];
}

export function sheetsToRis(sheets){
  const out = [];
  for (const sh of sheets) for (const row of sh.rows){
    const g = (...names) => pick(sh, row, names);
    const lines = [`TY  - ${BIB_TYPE[(g("type", "entrytype") || "misc").toLowerCase()] || "GEN"}`];
    for (const a of g("author", "authors").split(/\s+and\s+|;\s*/).filter(Boolean)) lines.push(`AU  - ${a.trim()}`);
    const add = (tagName, v) => { if (v) lines.push(`${tagName}  - ${v}`); };
    add("TI", g("title"));
    add("PY", g("year", "date"));
    add("JO", g("journal", "journaltitle"));
    add("BT", g("booktitle"));
    add("VL", g("volume"));
    add("IS", g("number", "issue"));
    const pages = g("pages").split(/-+|–/).map(s => s.trim()).filter(Boolean);
    add("SP", pages[0]);
    add("EP", pages[1]);
    add("PB", g("publisher"));
    add("CY", g("address"));
    add("DO", g("doi"));
    add("UR", g("url"));
    add("SN", g("issn", "isbn"));
    add("AB", g("abstract"));
    for (const k of g("keywords").split(/[,;]\s*/).filter(Boolean)) lines.push(`KW  - ${k}`);
    add("ID", g("key", "id", "citekey"));
    lines.push("ER  - ");
    out.push(lines.join("\n"));
  }
  return out.join("\n\n") + "\n";
}
