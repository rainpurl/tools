// Nested data: YAML, XML, TOML, INI, JSON with comments.

import { coerce, jsonToTable } from "./table.js";
import { xmlEsc } from "./util.js";

export function yamlDump(v, indent){
  indent = indent || 0;
  const pad = "  ".repeat(indent);
  const key = k => (/^[A-Za-z0-9_][\w.-]*$/.test(k) ? k : JSON.stringify(k));
  const lit = s => {
    if (s === "") return '""';
    if (/^[\s]|[\s]$|[:#\-?*&!|>%@`{}\[\],'"]|^(true|false|null|yes|no|on|off|~)$|^-?\d+(\.\d+)?$/i.test(s) || s.includes("\n")){
      if (s.includes("\n")) return "|-\n" + s.split("\n").map(l => pad + "  " + l).join("\n");
      return JSON.stringify(s);
    }
    return s;
  };
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return lit(v);
  if (Array.isArray(v)){
    if (!v.length) return "[]";
    return "\n" + v.map(x => {
      const s = yamlDump(x, indent + 1);
      return pad + "- " + (s.startsWith("\n") ? s.slice(1).replace(new RegExp("^" + "  ".repeat(indent + 1)), "") : s);
    }).join("\n");
  }
  const ks = Object.keys(v);
  if (!ks.length) return "{}";
  return "\n" + ks.map(k => {
    const s = yamlDump(v[k], indent + 1);
    return pad + key(k) + ":" + (s.startsWith("\n") ? s : " " + s);
  }).join("\n");
}

export function toYaml(v){
  const s = yamlDump(v, 0);
  return (s.startsWith("\n") ? s.slice(1) : s) + "\n";
}

export function yamlParse(text){
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const clean = [];
  for (let raw of lines){
    if (/^\s*#/.test(raw) || !raw.trim()) { clean.push({ indent: -1, raw: "" }); continue; }
    const indent = raw.match(/^ */)[0].length;
    clean.push({ indent, raw: raw.trim(), full: raw });
  }
  let i = 0;
  const scalarOf = s => {
    if (s === "" || s === "~" || /^null$/i.test(s)) return null;
    if (/^(true|yes|on)$/i.test(s)) return true;
    if (/^(false|no|off)$/i.test(s)) return false;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
    if (/^".*"$/.test(s) || /^'.*'$/.test(s)){
      try { return JSON.parse(s.replace(/^'|'$/g, '"')); } catch (e){ return s.slice(1, -1); }
    }
    if (/^\[.*\]$/.test(s) || /^\{.*\}$/.test(s)){
      try { return JSON.parse(s.replace(/([{,]\s*)([A-Za-z0-9_-]+)\s*:/g, '$1"$2":').replace(/'/g, '"')); } catch (e){ return s; }
    }
    return s;
  };
  const block = (marker, indent) => {
    const buf = [];
    while (i < clean.length && (clean[i].indent === -1 || clean[i].indent > indent)){
      buf.push(clean[i].indent === -1 ? "" : clean[i].full.slice(indent + 2));
      i++;
    }
    while (buf.length && !buf[buf.length - 1]) buf.pop();
    const s = buf.join(marker === ">" ? " " : "\n");
    return s;
  };
  const parseAt = (indent) => {
    let result = null;
    while (i < clean.length){
      const ln = clean[i];
      if (ln.indent === -1){ i++; continue; }
      if (ln.indent < indent) break;
      if (ln.raw.startsWith("- ") || ln.raw === "-"){
        if (result === null) result = [];
        if (!Array.isArray(result)) break;
        const rest = ln.raw === "-" ? "" : ln.raw.slice(2).trim();
        i++;
        if (!rest){ result.push(parseAt(ln.indent + 1)); continue; }
        const m = rest.match(/^([^:]+):\s*(.*)$/);
        if (m && !/^["']/.test(rest)){
          const obj = {};
          obj[m[1].trim()] = m[2] ? scalarOf(m[2]) : parseAt(ln.indent + 2);
          const sub = parseAt(ln.indent + 2);
          if (sub && typeof sub === "object" && !Array.isArray(sub)) Object.assign(obj, sub);
          result.push(obj);
        } else {
          result.push(scalarOf(rest));
        }
        continue;
      }
      const m = ln.raw.match(/^(.+?):\s*(.*)$/);
      if (!m){ i++; continue; }
      if (result === null) result = {};
      if (Array.isArray(result)) break;
      const k = m[1].replace(/^["']|["']$/g, "").trim();
      const v = m[2];
      i++;
      if (v === "|" || v === "|-" || v === ">" || v === ">-") result[k] = block(v[0], ln.indent);
      else if (v === "") result[k] = (i < clean.length && clean[i].indent > ln.indent) ? parseAt(ln.indent + 1) : null;
      else result[k] = scalarOf(v);
    }
    return result === null ? null : result;
  };
  return parseAt(0);
}

export function xmlToTree(doc){
  const walk = el => {
    const out = {};
    for (const a of el.attributes || []) out["@" + a.name] = a.value;
    const kids = Array.from(el.children);
    if (!kids.length){
      const t = el.textContent.trim();
      if (!Object.keys(out).length) return t === "" ? null : coerce(t);
      if (t) out["#text"] = t;
      return out;
    }
    for (const c of kids){
      const v = walk(c);
      if (c.tagName in out){
        if (!Array.isArray(out[c.tagName])) out[c.tagName] = [out[c.tagName]];
        out[c.tagName].push(v);
      } else out[c.tagName] = v;
    }
    return out;
  };
  const root = doc.documentElement;
  return { [root.tagName]: walk(root) };
}

export function treeToXml(v, rootName){
  const tag = s => (String(s).replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/^[^A-Za-z_]/, "_") || "item");
  const emit = (val, name, depth) => {
    const pad = "  ".repeat(depth);
    if (Array.isArray(val)) return val.map(x => emit(x, name, depth)).join("\n");
    if (val && typeof val === "object"){
      const attrs = [], kids = [];
      for (const [k, x] of Object.entries(val)){
        if (k.startsWith("@")) attrs.push(` ${tag(k.slice(1))}="${xmlEsc(x)}"`);
        else if (k === "#text") kids.push(pad + "  " + xmlEsc(x));
        else kids.push(emit(x, k, depth + 1));
      }
      if (!kids.length) return `${pad}<${tag(name)}${attrs.join("")}/>`;
      return `${pad}<${tag(name)}${attrs.join("")}>\n${kids.join("\n")}\n${pad}</${tag(name)}>`;
    }
    return `${pad}<${tag(name)}>${xmlEsc(val ?? "")}</${tag(name)}>`;
  };
  const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n';
  if (Array.isArray(v)) return PROLOG + emit({ item: v }, rootName || "root", 0) + "\n";
  const keys = v && typeof v === "object" ? Object.keys(v) : null;
  if (keys && keys.length === 1 && !Array.isArray(v[keys[0]])) return PROLOG + emit(v[keys[0]], keys[0], 0) + "\n";
  return PROLOG + emit(v, rootName || "root", 0) + "\n";
}

export function treeToTable(v, name){ return jsonToTable(v, name); }

export function parseXml(text, what){
  const d = new DOMParser().parseFromString(text, "application/xml");
  if (d.getElementsByTagName("parsererror").length) throw new Error("invalid xml in " + (what || "document"));
  return d;
}

export function tomlParse(text){
  const root = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cur = root, i = 0;

  const dig = (path, arrayOf) => {
    let node = root;
    for (let k = 0; k < path.length; k++){
      const key = path[k];
      const last = k === path.length - 1;
      if (Array.isArray(node[key])) node = node[key][node[key].length - 1];
      else if (node[key] === undefined || typeof node[key] !== "object"){
        node[key] = (last && arrayOf) ? [{}] : {};
        node = (last && arrayOf) ? node[key][0] : node[key];
      } else if (last && arrayOf){
        node = node[key];
      } else {
        node = node[key];
      }
      if (last && arrayOf && Array.isArray(node)) node = node[node.length - 1];
    }
    return node;
  };
  const splitKey = s => {
    const parts = [];
    let buf = "", q = null;
    for (const ch of s.trim()){
      if (q){ if (ch === q) q = null; else buf += ch; continue; }
      if (ch === '"' || ch === "'"){ q = ch; continue; }
      if (ch === "."){ parts.push(buf.trim()); buf = ""; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
  };
  const value = s => {
    s = s.trim();
    if (s.startsWith('"""') || s.startsWith("'''")){
      const q = s.slice(0, 3);
      const end = s.indexOf(q, 3);
      const body = end < 0 ? s.slice(3) : s.slice(3, end);
      return body.replace(/^\n/, "");
    }
    if (s.startsWith('"')){
      try { return JSON.parse(s.slice(0, lastQuote(s, '"') + 1)); }
      catch (e){ return s.replace(/^"|"$/g, ""); }
    }
    if (s.startsWith("'")) return s.slice(1, lastQuote(s, "'"));
    if (s.startsWith("[")){
      const inner = s.slice(1, s.lastIndexOf("]"));
      return splitTop(inner).map(value);
    }
    if (s.startsWith("{")){
      const inner = s.slice(1, s.lastIndexOf("}"));
      const o = {};
      for (const pair of splitTop(inner)){
        const eq = pair.indexOf("=");
        if (eq < 0) continue;
        const path = splitKey(pair.slice(0, eq));
        let n = o;
        path.forEach((k, j) => { if (j === path.length - 1) n[k] = value(pair.slice(eq + 1)); else n = n[k] = n[k] || {}; });
      }
      return o;
    }
    if (/^(true|false)$/.test(s)) return s === "true";
    if (/^[+-]?(inf|nan)$/.test(s)) return s.includes("nan") ? NaN : (s[0] === "-" ? -Infinity : Infinity);
    if (/^[+-]?\d[\d_]*$/.test(s)) return parseInt(s.replace(/_/g, ""), 10);
    if (/^0x[0-9a-fA-F_]+$/.test(s)) return parseInt(s.replace(/_/g, "").slice(2), 16);
    if (/^0o[0-7_]+$/.test(s)) return parseInt(s.replace(/_/g, "").slice(2), 8);
    if (/^0b[01_]+$/.test(s)) return parseInt(s.replace(/_/g, "").slice(2), 2);
    if (/^[+-]?(\d[\d_]*)?\.?\d[\d_]*([eE][+-]?\d+)?$/.test(s)) return parseFloat(s.replace(/_/g, ""));
    return s;
  };
  const lastQuote = (s, q) => {
    for (let k = 1; k < s.length; k++){
      if (s[k] === "\\"){ k++; continue; }
      if (s[k] === q) return k;
    }
    return s.length - 1;
  };
  const splitTop = s => {
    const out = [];
    let buf = "", depth = 0, q = null;
    for (let k = 0; k < s.length; k++){
      const ch = s[k];
      if (q){ buf += ch; if (ch === q && s[k - 1] !== "\\") q = null; continue; }
      if (ch === '"' || ch === "'"){ q = ch; buf += ch; continue; }
      if (ch === "[" || ch === "{") depth++;
      if (ch === "]" || ch === "}") depth--;
      if (ch === "," && depth === 0){ if (buf.trim()) out.push(buf.trim()); buf = ""; continue; }
      buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  };
  const stripComment = s => {
    let q = null, out = "";
    for (let k = 0; k < s.length; k++){
      const ch = s[k];
      if (q){ out += ch; if (ch === q && s[k - 1] !== "\\") q = null; continue; }
      if (ch === '"' || ch === "'"){ q = ch; out += ch; continue; }
      if (ch === "#") break;
      out += ch;
    }
    return out;
  };

  while (i < lines.length){
    let line = stripComment(lines[i]).trim();
    i++;
    if (!line) continue;

    let m = line.match(/^\[\[(.+?)\]\]$/);
    if (m){
      const path = splitKey(m[1]);
      let node = root;
      path.forEach((k, j) => {
        const last = j === path.length - 1;
        if (last){
          if (!Array.isArray(node[k])) node[k] = [];
          node[k].push({});
          node = node[k][node[k].length - 1];
        } else {
          if (Array.isArray(node[k])) node = node[k][node[k].length - 1];
          else node = node[k] = (typeof node[k] === "object" && node[k]) || {};
        }
      });
      cur = node;
      continue;
    }
    m = line.match(/^\[(.+?)\]$/);
    if (m){ cur = dig(splitKey(m[1]), false); continue; }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let rhs = line.slice(eq + 1).trim();
    if (rhs.startsWith('"""') || rhs.startsWith("'''")){
      const q = rhs.slice(0, 3);
      while (rhs.indexOf(q, 3) < 0 && i < lines.length) rhs += "\n" + lines[i++];
    } else {
      const open = (s, a, b) => (s.split(a).length - 1) - (s.split(b).length - 1);
      while ((open(rhs, "[", "]") > 0 || open(rhs, "{", "}") > 0) && i < lines.length) rhs += " " + stripComment(lines[i++]).trim();
    }
    const path = splitKey(line.slice(0, eq));
    let node = cur;
    path.forEach((k, j) => {
      if (j === path.length - 1) node[k] = value(rhs);
      else node = node[k] = (typeof node[k] === "object" && node[k]) || {};
    });
  }
  return root;
}

export function toToml(v){
  const out = [];
  const keyStr = k => /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
  const scalarStr = x => {
    if (x === null || x === undefined) return '""';
    if (typeof x === "boolean") return String(x);
    if (typeof x === "number") return Number.isFinite(x) ? String(x) : (Number.isNaN(x) ? "nan" : (x > 0 ? "inf" : "-inf"));
    if (Array.isArray(x)) return "[" + x.map(scalarStr).join(", ") + "]";
    if (typeof x === "object") return "{ " + Object.entries(x).map(([k, y]) => `${keyStr(k)} = ${scalarStr(y)}`).join(", ") + " }";
    return JSON.stringify(String(x));
  };
  const isTable = x => x && typeof x === "object" && !Array.isArray(x);
  const isTableArray = x => Array.isArray(x) && x.length && x.every(isTable);
  const emit = (obj, path) => {
    const simple = [], tables = [], arrays = [];
    for (const [k, x] of Object.entries(obj)){
      if (isTableArray(x)) arrays.push([k, x]);
      else if (isTable(x)) tables.push([k, x]);
      else simple.push([k, x]);
    }
    if (path.length && (simple.length || (!tables.length && !arrays.length))) out.push(`[${path.map(keyStr).join(".")}]`);
    for (const [k, x] of simple) out.push(`${keyStr(k)} = ${scalarStr(x)}`);
    if (simple.length) out.push("");
    for (const [k, x] of tables){
      emit(x, [...path, k]);
    }
    for (const [k, list] of arrays){
      for (const item of list){
        out.push(`[[${[...path, k].map(keyStr).join(".")}]]`);
        for (const [k2, x2] of Object.entries(item)){
          if (isTable(x2) || isTableArray(x2)) continue;
          out.push(`${keyStr(k2)} = ${scalarStr(x2)}`);
        }
        out.push("");
      }
    }
  };
  if (!isTable(v)) return scalarStr(v) + "\n";
  emit(v, []);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function iniParse(text){
  const root = {};
  let cur = root;
  for (let raw of text.replace(/\r\n?/g, "\n").split("\n")){
    const line = raw.replace(/^\s+/, "");
    if (!line || /^[;#]/.test(line)) continue;
    const sec = line.match(/^\[(.+?)\]\s*$/);
    if (sec){
      const path = sec[1].split(/[.\\\/]/).map(s => s.trim()).filter(Boolean);
      let n = root;
      for (const k of path) n = n[k] = (typeof n[k] === "object" && n[k]) || {};
      cur = n;
      continue;
    }
    const m = line.match(/^([^=:]+)[=:](.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+[;#].*$/, "");
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    cur[m[1].trim()] = coerce(v);
  }
  if (!Object.keys(root).length) throw new Error("no keys found");
  return root;
}

export function toIni(v){
  const out = [];
  const flat = [], sections = [];
  const line = (k, x) => `${k} = ${Array.isArray(x) ? x.map(String).join(", ") : (x === null || x === undefined ? "" : String(x))}`;
  if (!v || typeof v !== "object") return String(v) + "\n";
  for (const [k, x] of Object.entries(v)) if (!(x && typeof x === "object" && !Array.isArray(x))) out.push(line(k, x));
  const emitSection = (obj, path) => {
    const own = Object.entries(obj).filter(([, x]) => !(x && typeof x === "object" && !Array.isArray(x)));
    if (own.length || !Object.keys(obj).length){
      out.push("", `[${path.join(".")}]`);
      for (const [k, x] of own) out.push(line(k, x));
    }
    for (const [k, x] of Object.entries(obj)) if (x && typeof x === "object" && !Array.isArray(x)) emitSection(x, [...path, k]);
  };
  for (const [k, x] of Object.entries(v)) if (x && typeof x === "object" && !Array.isArray(x)) emitSection(x, [k]);
  return out.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function stripJsonComments(text){
  let out = "", q = false, esc = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i], n = text[i + 1];
    if (q){
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') q = false;
      continue;
    }
    if (c === '"'){ q = true; out += c; continue; }
    if (c === "/" && n === "/"){ while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*"){ i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
