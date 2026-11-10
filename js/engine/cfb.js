// Files from Office 97 to 2003 and Outlook: a small file system in one file
// (the compound file), and readers for the XLS, DOC, PPT and MSG stored in it.

import { htmlDoc } from "./rich.js";
import { rowsToSheet } from "./table.js";
import { escHtml, latin1 } from "./util.js";

const utf16 = new TextDecoder("utf-16le");
let cp1252 = latin1;
try { cp1252 = new TextDecoder("windows-1252"); } catch (e){ /* latin1 is close enough */ }

/* ---- the compound file -------------------------------------------------- */

export function isCfb(u8){
  return u8.length > 8 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0;
}

export function cfbOpen(u8){
  if (!isCfb(u8)) throw new Error("not an Office 97 to 2003 file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ss = 1 << dv.getUint16(30, true), mss = 1 << dv.getUint16(32, true);
  const cutoff = dv.getUint32(56, true);
  const END = 0xfffffffe;
  const sector = n => (n + 1) * ss;
  const per = ss / 4;

  // the table of sector tables
  const difat = [];
  for (let i = 0; i < 109; i++) difat.push(dv.getUint32(76 + i * 4, true));
  let next = dv.getUint32(68, true);
  for (let guard = 0; next < END && guard < 10000; guard++){
    const o = sector(next);
    for (let i = 0; i < per - 1; i++) difat.push(dv.getUint32(o + i * 4, true));
    next = dv.getUint32(o + (per - 1) * 4, true);
  }
  const fat = [];
  for (const s of difat){
    if (s >= END - 1) continue;
    const o = sector(s);
    if (o + ss > u8.length) break;
    for (let i = 0; i < per; i++) fat.push(dv.getUint32(o + i * 4, true));
  }
  const chain = start => {
    const out = [];
    for (let s = start, guard = 0; s < END && s < fat.length && guard < fat.length + 1; s = fat[s], guard++) out.push(s);
    return out;
  };
  const readBig = (start, size) => {
    const secs = chain(start);
    const out = new Uint8Array(secs.length * ss);
    secs.forEach((s, i) => out.set(u8.subarray(sector(s), Math.min(u8.length, sector(s) + ss)), i * ss));
    return size !== undefined && size < out.length ? out.subarray(0, size) : out;
  };

  const dir = readBig(dv.getUint32(48, true));
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const raw = [];
  for (let o = 0; o + 128 <= dir.length; o += 128){
    const len = ddv.getUint16(o + 64, true);
    raw.push({
      name: len > 2 ? utf16.decode(dir.subarray(o, o + len - 2)) : "",
      type: dir[o + 66], left: ddv.getInt32(o + 68, true), right: ddv.getInt32(o + 72, true), child: ddv.getInt32(o + 76, true),
      start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true)
    });
  }
  const root = raw[0] || { start: END, size: 0 };
  const mini = readBig(root.start, root.size);
  const minifat = [];
  {
    const mf = readBig(dv.getUint32(60, true));
    const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    for (let i = 0; i + 4 <= mf.length; i += 4) minifat.push(mdv.getUint32(i, true));
  }
  const readMini = (start, size) => {
    const out = new Uint8Array(size);
    let p = 0;
    for (let s = start, guard = 0; s < END && s < minifat.length && p < size && guard < minifat.length + 1; s = minifat[s], guard++){
      out.set(mini.subarray(s * mss, Math.min(mini.length, s * mss + Math.min(mss, size - p))), p);
      p += mss;
    }
    return out;
  };

  // walk the tree to give every entry its path
  const entries = [];
  const visit = (i, path, seen) => {
    if (i < 0 || i >= raw.length || seen.has(i)) return;
    seen.add(i);
    const e = raw[i];
    visit(e.left, path, seen);
    const full = path ? path + "/" + e.name : e.name;
    entries.push({ name: e.name, path: full, type: e.type, start: e.start, size: e.size });
    if (e.type === 1) visit(e.child, full, seen);
    visit(e.right, path, seen);
  };
  if (raw.length) visit(raw[0].child, "", new Set());

  return {
    entries,
    find: name => entries.find(e => e.type === 2 && (name instanceof RegExp ? name.test(e.path) : e.path === name)),
    read: e => e.size < cutoff ? readMini(e.start, e.size) : readBig(e.start, e.size)
  };
}

// Which Office format a compound file holds.
export function cfbKind(u8){
  try {
    const c = cfbOpen(u8);
    const has = n => c.entries.some(e => e.name === n);
    if (has("WordDocument")) return "doc";
    if (has("Workbook") || has("Book")) return "xls";
    if (has("PowerPoint Document")) return "ppt";
    if (c.entries.some(e => /^__substg1\.0_/.test(e.name))) return "msg";
  } catch (e){ /* unreadable */ }
  return null;
}

/* ---- XLS ---------------------------------------------------------------- */

const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const looksLikeDate = fmt => /[dmyhs]/i.test(fmt.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")) && !/^General$/i.test(fmt);

function serialToDate(n, base1904){
  const ms = Math.round((n - (base1904 ? -1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  if (isNaN(d)) return String(n);
  const iso = d.toISOString();
  if (n < 1) return iso.slice(11, 19);
  return Number.isInteger(n) || iso.slice(11, 19) === "00:00:00" ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

export function xlsToSheets(u8, opts){
  const cfb = cfbOpen(u8);
  const entry = cfb.find("Workbook") || cfb.find("Book");
  if (!entry) throw new Error("this file has no workbook in it");
  const wb = cfb.read(entry);
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);

  // every record, with CONTINUE records joined on but their seams remembered
  const records = [];
  for (let p = 0; p + 4 <= wb.length;){
    const type = dv.getUint16(p, true), len = dv.getUint16(p + 2, true);
    if (type === 0x3c && records.length) records[records.length - 1].parts.push([p + 4, len]);
    else records.push({ type, at: p, parts: [[p + 4, len]] });
    p += 4 + len;
  }

  // A string reader that copes with a string running across a seam: after the
  // seam comes a fresh flag byte saying whether the rest is one or two bytes a character.
  const reader = rec => {
    let part = 0, pos = rec.parts[0][0], end = pos + rec.parts[0][1];
    const more = () => { part++; if (part >= rec.parts.length) return false; pos = rec.parts[part][0]; end = pos + rec.parts[part][1]; return true; };
    const r = {
      left: () => part < rec.parts.length && (pos < end || part + 1 < rec.parts.length),
      u8: () => { if (pos >= end && !more()) return 0; return wb[pos++]; },
      u16: () => { if (pos >= end && !more()) return 0; const v = dv.getUint16(pos, true); pos += 2; return v; },
      u32: () => { if (pos >= end && !more()) return 0; const v = dv.getUint32(pos, true); pos += 4; return v; },
      skip: n => { while (n > 0){ if (pos >= end && !more()) return; const k = Math.min(n, end - pos); pos += k; n -= k; } },
      chars: (cch, wide) => {
        let s = "";
        while (cch > 0){
          if (pos >= end){ if (!more()) break; wide = (wb[pos++] & 1) === 1; }
          const k = Math.min(cch, wide ? (end - pos) >> 1 : end - pos);
          if (k <= 0){ pos = end; continue; }
          s += wide ? utf16.decode(wb.subarray(pos, pos + k * 2)) : cp1252.decode(wb.subarray(pos, pos + k));
          pos += wide ? k * 2 : k;
          cch -= k;
        }
        return s;
      },
      str: lenBytes => {
        const cch = lenBytes === 1 ? r.u8() : r.u16();
        const flags = r.u8();
        const runs = flags & 8 ? r.u16() : 0;
        const ext = flags & 4 ? r.u32() : 0;
        const s = r.chars(cch, (flags & 1) === 1);
        r.skip(runs * 4 + ext);
        return s;
      }
    };
    return r;
  };

  const biff8 = records.length && records[0].type === 0x809 && dv.getUint16(records[0].parts[0][0], true) >= 0x600;
  const sst = [], sheets = [], formats = new Map(), xfs = [];
  let base1904 = false;
  for (const rec of records){
    const r = reader(rec);
    if (rec.type === 0xfc){ r.u32(); const n = r.u32(); for (let i = 0; i < n && r.left(); i++) sst.push(r.str(2)); }
    else if (rec.type === 0x85){
      const at = r.u32(); r.u8(); const type = r.u8();
      const name = biff8 ? r.str(1) : cp1252.decode(wb.subarray(rec.parts[0][0] + 7, rec.parts[0][0] + 7 + wb[rec.parts[0][0] + 6]));
      if (type === 0) sheets.push({ at, name });
    }
    else if (rec.type === 0x41e){ const id = r.u16(); formats.set(id, biff8 ? r.str(2) : ""); }
    else if (rec.type === 0xe0){ r.u16(); xfs.push(r.u16()); }
    else if (rec.type === 0x22) base1904 = r.u16() === 1;
    else if (rec.type === 0x0a && sheets.length) break;       // end of the workbook globals
  }
  const dateXf = xfs.map(f => DATE_IDS.has(f) || (formats.has(f) && looksLikeDate(formats.get(f))));
  const num = (v, xf) => dateXf[xf] && v > 0 && v < 2958466 ? serialToDate(v, base1904) : String(+v.toPrecision(15));
  const rk = v => {
    let n;
    if (v & 2) n = v >> 2;
    else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, v & 0xfffffffc, true); n = b.getFloat64(0, true); }
    return v & 1 ? n / 100 : n;
  };

  const out = [];
  const starts = new Map(records.map((rec, i) => [rec.at, i]));
  for (const sh of sheets){
    const grid = [];
    const put = (row, col, v) => {
      if (row > 1048576 || col > 16384) return;
      while (grid.length <= row) grid.push([]);
      const line = grid[row];
      while (line.length < col) line.push("");
      line[col] = v;
    };
    let pendingFormula = null;
    for (let i = (starts.get(sh.at) ?? -1) + 1; i > 0 && i < records.length; i++){
      const rec = records[i];
      if (rec.type === 0x0a) break;
      const o = rec.parts[0][0];
      const row = dv.getUint16(o, true), col = dv.getUint16(o + 2, true), xf = dv.getUint16(o + 4, true);
      switch (rec.type){
        case 0xfd: put(row, col, sst[dv.getUint32(o + 6, true)] ?? ""); break;
        case 0x203: put(row, col, num(dv.getFloat64(o + 6, true), xf)); break;
        case 0x27e: put(row, col, num(rk(dv.getUint32(o + 6, true)), xf)); break;
        case 0xbd: {
          const n = (rec.parts[0][1] - 6) / 6;
          for (let k = 0; k < n; k++) put(row, col + k, num(rk(dv.getUint32(o + 4 + k * 6 + 2, true)), dv.getUint16(o + 4 + k * 6, true)));
          break;
        }
        case 0x204: case 0xd6: {
          const r = reader(rec); r.skip(6);
          put(row, col, biff8 ? r.str(2) : cp1252.decode(wb.subarray(o + 8, o + 8 + dv.getUint16(o + 6, true))));
          break;
        }
        case 0x205: put(row, col, wb[o + 7] ? "#ERR" : (wb[o + 6] ? "TRUE" : "FALSE")); break;
        case 0x06: {
          if (dv.getUint16(o + 12, true) === 0xffff){
            const t = wb[o + 6];
            if (t === 0) pendingFormula = { row, col };
            else if (t === 1) put(row, col, wb[o + 8] ? "TRUE" : "FALSE");
            else if (t === 2) put(row, col, "#ERR");
          } else put(row, col, num(dv.getFloat64(o + 6, true), xf));
          break;
        }
        case 0x207: {
          if (pendingFormula){
            const r = reader(rec);
            put(pendingFormula.row, pendingFormula.col, biff8 ? r.str(2) : cp1252.decode(wb.subarray(o + 2, o + 2 + dv.getUint16(o, true))));
            pendingFormula = null;
          }
          break;
        }
        default: break;
      }
    }
    while (grid.length && grid[grid.length - 1].every(c => c === "" || c === undefined)) grid.pop();
    const w = Math.max(0, ...grid.map(r => r.length));
    for (const r of grid) while (r.length < w) r.push("");
    if (grid.length) out.push(rowsToSheet(grid, sh.name, !opts || opts.hasHeader !== false));
  }
  if (!out.length) throw new Error("no cells could be read from this workbook");
  return out;
}

/* ---- DOC ---------------------------------------------------------------- */

export function docToHtml(u8, title){
  const cfb = cfbOpen(u8);
  const main = cfb.find("WordDocument");
  if (!main) throw new Error("this file has no Word document in it");
  const wd = cfb.read(main);
  const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
  if (dv.getUint16(0, true) !== 0xa5ec) throw new Error("this Word file is older than Word 97 and cannot be read");
  const flags = dv.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error("this Word file is password protected");
  const table = cfb.find(flags & 0x0200 ? "1Table" : "0Table") || cfb.find("1Table") || cfb.find("0Table");
  if (!table) throw new Error("this Word file is missing its table stream");
  const tb = cfb.read(table);
  const tdv = new DataView(tb.buffer, tb.byteOffset, tb.byteLength);
  const ccpText = dv.getUint32(0x4c, true);
  const fcClx = dv.getUint32(0x1a2, true), lcbClx = dv.getUint32(0x1a6, true);

  // the piece table says where each run of text sits and how it is stored
  let text = "";
  let p = fcClx;
  const stop = Math.min(tb.length, fcClx + lcbClx);
  while (p < stop && tb[p] === 1) p += 3 + tdv.getUint16(p + 1, true);
  if (p < stop && tb[p] === 2){
    const lcb = tdv.getUint32(p + 1, true);
    const base = p + 5, n = (lcb - 4) / 12;
    for (let i = 0; i < n && text.length < ccpText; i++){
      const cp0 = tdv.getUint32(base + i * 4, true), cp1 = tdv.getUint32(base + (i + 1) * 4, true);
      const fc = tdv.getUint32(base + (n + 1) * 4 + i * 8 + 2, true);
      const count = Math.max(0, Math.min(cp1 - cp0, ccpText - text.length));
      if (fc & 0x40000000){
        const at = (fc & 0x3fffffff) >> 1;
        text += cp1252.decode(wd.subarray(at, at + count));
      } else text += utf16.decode(wd.subarray(fc, fc + count * 2));
    }
  }
  if (!text) throw new Error("no text could be read from this Word file");

  // fields keep their shown result and lose their code
  let clean = "", depth = 0, inCode = [];
  for (const ch of text){
    const c = ch.charCodeAt(0);
    if (c === 0x13){ depth++; inCode.push(true); continue; }
    if (c === 0x14){ inCode[inCode.length - 1] = false; continue; }
    if (c === 0x15){ depth = Math.max(0, depth - 1); inCode.pop(); continue; }
    if (depth && inCode[inCode.length - 1]) continue;
    if (c === 0x01 || c === 0x08 || c === 0x02 || c === 0x05) continue;
    clean += c === 0x1e ? "-" : c === 0x1f ? "" : c === 0xa0 ? " " : ch;
  }

  const parts = [];
  let row = null, rows = null;
  const closeTable = () => {
    if (!rows) return;
    if (row && row.length) rows.push(row);
    const w = Math.max(...rows.map(r => r.length));
    parts.push("<table>" + rows.map(r => "<tr>" + Array.from({ length: w }, (_, i) => `<td>${r[i] || ""}</td>`).join("") + "</tr>").join("\n") + "</table>");
    rows = null; row = null;
  };
  const inline = s => escHtml(s).replace(/\u000b/g, "<br>").replace(/\t/g, "&emsp;");
  let buf = "";
  for (let i = 0; i < clean.length; i++){
    const c = clean.charCodeAt(i);
    if (c === 0x07){
      // a cell ends here; a second mark straight after ends the row
      if (!rows){ rows = []; row = []; }
      if (!row) row = [];
      if (buf === "" && row.length && clean.charCodeAt(i - 1) === 0x07){ rows.push(row); row = null; }
      else row.push(inline(buf));
      buf = "";
    } else if (c === 0x0d || c === 0x0c){
      if (rows && row === null && buf === ""){ if (c === 0x0c) closeTable(); continue; }
      if (rows && row && row.length){ buf += " "; continue; }      // a paragraph break inside a cell
      closeTable();                                                // text after a finished row is no longer the table
      if (buf.trim()) parts.push(`<p>${inline(buf)}</p>`);
      if (c === 0x0c && parts.length) parts.push(`<p style="page-break-before:always"></p>`);
      buf = "";
    } else buf += clean[i];
  }
  closeTable();
  if (buf.trim()) parts.push(`<p>${inline(buf)}</p>`);
  return htmlDoc(title || "Document", parts.join("\n"));
}

/* ---- PPT ---------------------------------------------------------------- */

export function pptToHtml(u8){
  const cfb = cfbOpen(u8);
  const main = cfb.find("PowerPoint Document");
  if (!main) throw new Error("this file has no PowerPoint document in it");
  const ps = cfb.read(main);
  const dv = new DataView(ps.buffer, ps.byteOffset, ps.byteLength);
  const slides = [];              // { title, body: [], other: [] }
  const extra = [];               // text boxes found inside each slide's own drawing
  let cur = null, list = -1, role = 4, inSlide = -1, slideNo = -1;

  const walk = (from, to, depth) => {
    for (let p = from; p + 8 <= to;){
      const ver = dv.getUint16(p, true), type = dv.getUint16(p + 2, true), len = dv.getUint32(p + 4, true);
      const body = p + 8, end = Math.min(to, body + len);
      if (type === 0x0ff0){ list = ver >> 4; walk(body, end, depth + 1); list = -1; cur = null; }
      else if (type === 0x03ee){ slideNo++; inSlide = slideNo; extra[inSlide] = []; walk(body, end, depth + 1); inSlide = -1; }
      else if (type === 0x03f3 && list === 0){ cur = { title: "", body: [], other: [] }; slides.push(cur); }
      else if (type === 0x0f9f) role = dv.getUint32(body, true);
      else if (type === 0x0fa0 || type === 0x0fa8){
        const t = (type === 0x0fa0 ? utf16.decode(ps.subarray(body, end)) : cp1252.decode(ps.subarray(body, end))).replace(/\u000b/g, "\n");
        const paras = t.split("\r").map(s => s.trim()).filter(Boolean);
        if (list === 0 && cur){
          if ((role === 0 || role === 6) && !cur.title) cur.title = paras.join(" ");
          else if (role !== 2) cur.body.push(...paras);
        } else if (inSlide >= 0 && list < 0) extra[inSlide].push(...paras);
      }
      else if ((ver & 0xf) === 0xf && depth < 40) walk(body, end, depth + 1);
      p = body + len;
    }
  };
  walk(0, ps.length, 0);

  const n = Math.max(slides.length, extra.length);
  if (!n) throw new Error("no slides could be read from this presentation");
  const out = [];
  for (let i = 0; i < n; i++){
    const s = slides[i] || { title: "", body: [] };
    const lines = [...s.body, ...((extra[i] || []).filter(t => t !== s.title && !s.body.includes(t)))];
    out.push(`<h2>Slide ${i + 1}</h2>`);
    if (s.title) out.push(`<h3>${escHtml(s.title)}</h3>`);
    if (lines.length) out.push("<ul>" + lines.map(t => `<li>${escHtml(t).replace(/\n/g, "<br>")}</li>`).join("") + "</ul>");
    else if (!s.title) out.push("<p><em>no text on this slide</em></p>");
  }
  return htmlDoc("Presentation", out.join("\n"));
}

/* ---- MSG ---------------------------------------------------------------- */

// Read an Outlook message into the same shape the EML reader gives.
export function parseMsg(u8){
  const cfb = cfbOpen(u8);
  const prop = (dir, id) => {
    const pre = (dir ? dir + "/" : "") + "__substg1.0_" + id;
    const e = cfb.entries.find(x => x.type === 2 && x.path.toUpperCase().startsWith(pre.toUpperCase()));
    if (!e) return null;
    const b = cfb.read(e);
    const type = e.name.slice(-4).toUpperCase();
    return type === "001F" ? utf16.decode(b).replace(/\0+$/, "") : type === "001E" ? cp1252.decode(b).replace(/\0+$/, "") : b;
  };
  const text = (dir, id) => { const v = prop(dir, id); return typeof v === "string" ? v : ""; };
  const headers = new Map();
  const raw = text("", "007D");
  const fromName = text("", "0C1A"), fromAddr = text("", "5D01") || text("", "0C1F") || text("", "0065");
  headers.set("from", fromName && fromAddr && /@/.test(fromAddr) && fromAddr !== fromName ? `${fromName} <${fromAddr}>` : fromName || fromAddr);
  headers.set("to", text("", "0E04"));
  headers.set("cc", text("", "0E03"));
  headers.set("subject", text("", "0037"));
  const date = /^Date:\s*(.+)$/im.exec(raw);
  if (date) headers.set("date", date[1].trim());
  let html = prop("", "1013");
  if (html && typeof html !== "string") html = new TextDecoder("utf-8").decode(html);
  const attachments = [];
  const dirs = new Set(cfb.entries.filter(e => e.type === 1 && /^__attach_version1\.0_/.test(e.name)).map(e => e.path));
  for (const d of dirs){
    const data = prop(d, "3701");
    if (!(data instanceof Uint8Array)) continue;
    attachments.push({ name: text(d, "3707") || text(d, "3704") || "attachment", bytes: data, mime: text(d, "370E") || "application/octet-stream" });
  }
  return { headers, plain: text("", "1000"), html: html || "", attachments };
}
