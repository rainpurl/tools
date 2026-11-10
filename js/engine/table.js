// Rows and columns: delimited text, sheets, and the plain renderings of them.

import { htmlDoc } from "./rich.js";
import { escHtml, xmlEsc } from "./util.js";

export function parseDelimited(text, delim){
  if (!delim){
    const line = text.slice(0, 8000).split(/\r?\n/).find(l => l.trim()) || "";
    const counts = { ",": 0, "\t": 0, ";": 0, "|": 0 };
    let q = false;
    for (const ch of line){
      if (ch === '"') q = !q;
      else if (!q && ch in counts) counts[ch]++;
    }
    delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
  }
  const rows = [];
  let row = [], cell = "", q = false, i = 0;
  const s = text.replace(/\r\n?/g, "\n");
  while (i < s.length){
    const c = s[i];
    if (q){
      if (c === '"'){
        if (s[i + 1] === '"'){ cell += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === ""){ q = true; i++; continue; }
    if (c === delim){ row.push(cell); cell = ""; i++; continue; }
    if (c === "\n"){ row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += c; i++;
  }
  if (cell !== "" || row.length){ row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every(c => c === "")) rows.pop();
  return rows;
}

export function rowsToSheet(rows, name, hasHeader){
  if (!rows.length) return { name, headers: [], rows: [] };
  if (hasHeader === false){
    const w = Math.max(...rows.map(r => r.length));
    return { name, headers: Array.from({ length: w }, (_, i) => "column " + (i + 1)), rows };
  }
  return { name, headers: rows[0].map((h, i) => String(h || "column " + (i + 1))), rows: rows.slice(1) };
}

export function objectsToSheet(arr, name){
  const headers = [];
  const seen = new Set();
  for (const o of arr){
    if (o && typeof o === "object" && !Array.isArray(o)){
      for (const k of Object.keys(o)) if (!seen.has(k)){ seen.add(k); headers.push(k); }
    }
  }
  if (!headers.length) return { name, headers: ["value"], rows: arr.map(v => [scalar(v)]) };
  const rows = arr.map(o => headers.map(h => scalar(o && typeof o === "object" ? o[h] : undefined)));
  return { name, headers, rows };
}

export function scalar(v){
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function jsonToTable(value, name){
  if (Array.isArray(value)){
    if (value.every(r => Array.isArray(r))) return [rowsToSheet(value.map(r => r.map(scalar)), name, false)];
    return [objectsToSheet(value, name)];
  }
  if (value && typeof value === "object"){
    const vals = Object.values(value);
    if (vals.length && vals.every(v => Array.isArray(v) && v.length && typeof v[0] === "object")){
      return Object.entries(value).map(([k, v]) => objectsToSheet(v, k));
    }
    return [{ name, headers: ["key","value"], rows: Object.entries(value).map(([k, v]) => [k, scalar(v)]) }];
  }
  return [{ name, headers: ["value"], rows: [[scalar(value)]] }];
}

export function tableToObjects(sheet){
  return sheet.rows.map(r => {
    const o = {};
    sheet.headers.forEach((h, i) => { o[h] = coerce(r[i]); });
    return o;
  });
}

export function coerce(v){
  if (v === undefined || v === "") return "";
  const s = String(v).trim();
  if (/^-?\d+$/.test(s) && s.length < 16) return parseInt(s, 10);
  if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(s)) return parseFloat(s);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
  if (/^null$/i.test(s)) return null;
  return v;
}

export function sheetsToDelimited(sheets, delim, header){
  const q = v => {
    const s = String(v ?? "");
    return (s.includes(delim) || s.includes('"') || /[\n\r]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [];
  sheets.forEach((sh, i) => {
    if (sheets.length > 1) out.push("# " + sh.name);
    if (header !== false && sh.headers.length) out.push(sh.headers.map(q).join(delim));
    for (const r of sh.rows) out.push(r.map(q).join(delim));
    if (i < sheets.length - 1) out.push("");
  });
  return out.join("\n") + "\n";
}

export function sheetsToMarkdown(sheets){
  const out = [];
  for (const sh of sheets){
    if (sheets.length > 1) out.push("## " + sh.name, "");
    const esc = v => String(v ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
    const heads = sh.headers.length ? sh.headers : (sh.rows[0] || []).map((_, i) => "column " + (i + 1));
    out.push("| " + heads.map(esc).join(" | ") + " |");
    out.push("| " + heads.map(() => "---").join(" | ") + " |");
    for (const r of sh.rows){
      const cells = heads.map((_, i) => esc(r[i]));
      out.push("| " + cells.join(" | ") + " |");
    }
    out.push("");
  }
  return out.join("\n");
}

export function sheetsToHtml(sheets, title){
  const esc = v => escHtml(String(v ?? ""));
  const parts = [];
  for (const sh of sheets){
    if (sheets.length > 1) parts.push(`<h2>${esc(sh.name)}</h2>`);
    parts.push("<table>");
    if (sh.headers.length) parts.push("<thead><tr>" + sh.headers.map(h => `<th>${esc(h)}</th>`).join("") + "</tr></thead>");
    parts.push("<tbody>");
    for (const r of sh.rows) parts.push("<tr>" + sh.headers.map((_, i) => `<td>${esc(r[i])}</td>`).join("") + "</tr>");
    parts.push("</tbody></table>");
  }
  return htmlDoc(title, parts.join("\n"));
}

export function sheetsToXml(sheets){
  const tag = s => (String(s || "item").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z_]/, "_") || "item");
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', "<data>"];
  for (const sh of sheets){
    out.push(`  <sheet name="${xmlEsc(sh.name)}">`);
    for (const r of sh.rows){
      out.push("    <row>");
      sh.headers.forEach((h, i) => out.push(`      <${tag(h)}>${xmlEsc(r[i] ?? "")}</${tag(h)}>`));
      out.push("    </row>");
    }
    out.push("  </sheet>");
  }
  out.push("</data>");
  return out.join("\n") + "\n";
}

export function sheetsToText(sheets){
  const out = [];
  for (const sh of sheets){
    if (sheets.length > 1) out.push(sh.name, "=".repeat(sh.name.length), "");
    const all = [sh.headers, ...sh.rows];
    const w = [];
    for (const r of all) r.forEach((c, i) => { w[i] = Math.max(w[i] || 0, String(c ?? "").length); });
    const line = r => r.map((c, i) => String(c ?? "").padEnd(w[i] || 0)).join("  ").trimEnd();
    if (sh.headers.length){
      out.push(line(sh.headers));
      out.push(w.map(n => "-".repeat(n)).join("  "));
    }
    for (const r of sh.rows) out.push(line(r));
    out.push("");
  }
  return out.join("\n");
}
