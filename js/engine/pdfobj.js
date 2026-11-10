// PDF object model, for lossless page edits.

import { concatBytes, deflateZlib, enc, inflate, latin1 } from "./util.js";

export class PdfName {
  constructor(name){ this.name = name; }
}

export class PdfRef {
  constructor(num, gen){ this.num = num; this.gen = gen || 0; }
}

export class PdfStream {
  constructor(dict, raw){ this.dict = dict; this.raw = raw; }
}

export function pdfLex(bytes){
  let p = 0;
  const isWs = c => c === 32 || c === 10 || c === 13 || c === 9 || c === 0 || c === 12;
  const isDelim = c => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 ||
                       c === 123 || c === 125 || c === 47 || c === 37;
  const skip = () => {
    for (;;){
      while (p < bytes.length && isWs(bytes[p])) p++;
      if (bytes[p] === 37){
        while (p < bytes.length && bytes[p] !== 10 && bytes[p] !== 13) p++;
        continue;
      }
      return;
    }
  };
  const token = () => {
    skip();
    if (p >= bytes.length) return null;
    const c = bytes[p];
    if (c === 47){
      p++;
      let s = "";
      while (p < bytes.length && !isWs(bytes[p]) && !isDelim(bytes[p])){
        if (bytes[p] === 35 && p + 2 < bytes.length){
          s += String.fromCharCode(parseInt(String.fromCharCode(bytes[p + 1], bytes[p + 2]), 16));
          p += 3;
        } else s += String.fromCharCode(bytes[p++]);
      }
      return { t: "name", v: s };
    }
    if (c === 40){
      p++;
      let depth = 1;
      const out = [];
      while (p < bytes.length){
        const b = bytes[p++];
        if (b === 92){ out.push(92, bytes[p++]); continue; }
        if (b === 40) depth++;
        if (b === 41){ depth--; if (!depth) break; }
        out.push(b);
      }
      return { t: "str", v: Uint8Array.from(out), literal: true };
    }
    if (c === 60 && bytes[p + 1] === 60){ p += 2; return { t: "<<" }; }
    if (c === 62 && bytes[p + 1] === 62){ p += 2; return { t: ">>" }; }
    if (c === 60){
      p++;
      let s = "";
      while (p < bytes.length && bytes[p] !== 62) s += String.fromCharCode(bytes[p++]);
      p++;
      return { t: "str", v: enc.encode(s), hex: true };
    }
    if (c === 91){ p++; return { t: "[" }; }
    if (c === 93){ p++; return { t: "]" }; }
    if (c === 123 || c === 125){ p++; return { t: "brace" }; }
    let s = "";
    while (p < bytes.length && !isWs(bytes[p]) && !isDelim(bytes[p])) s += String.fromCharCode(bytes[p++]);
    if (!s.length){ p++; return token(); }
    if (/^[-+]?[\d.]+$/.test(s)) return { t: "num", v: parseFloat(s) };
    return { t: "kw", v: s };
  };
  return {
    get pos(){ return p; },
    set pos(v){ p = v; },
    token, skip,
    parse(){
      const tk = token();
      return this.value(tk);
    },
    value(tk){
      if (!tk) return null;
      if (tk.t === "num"){
        const save = p;
        const t2 = token();
        if (t2 && t2.t === "num"){
          const t3 = token();
          if (t3 && t3.t === "kw" && t3.v === "R") return new PdfRef(tk.v, t2.v);
          p = save;
          return tk.v;
        }
        p = save;
        return tk.v;
      }
      if (tk.t === "name") return new PdfName(tk.v);
      if (tk.t === "str") return tk;
      if (tk.t === "["){
        const arr = [];
        for (;;){
          const t = token();
          if (!t || t.t === "]") break;
          arr.push(this.value(t));
        }
        return arr;
      }
      if (tk.t === "<<"){
        const d = new Map();
        for (;;){
          const t = token();
          if (!t || t.t === ">>") break;
          if (t.t !== "name") continue;
          d.set(t.v, this.parse());
        }
        const save = p;
        const nx = token();
        if (nx && nx.t === "kw" && nx.v === "stream"){
          if (bytes[p] === 13) p++;
          if (bytes[p] === 10) p++;
          return { t: "streamAt", dict: d, start: p };
        }
        p = save;
        return d;
      }
      if (tk.t === "kw"){
        if (tk.v === "true") return true;
        if (tk.v === "false") return false;
        if (tk.v === "null") return null;
        return { t: "kw", v: tk.v };
      }
      return null;
    }
  };
}

export async function pdfParse(u8){
  const objs = new Map();
  const lex = pdfLex(u8);
  const text = new TextDecoder("latin1").decode(u8);
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  const found = [];
  while ((m = re.exec(text))) found.push({ num: +m[1], gen: +m[2], at: m.index + m[0].length });
  if (!found.length) throw new Error("no pdf objects found, the file may not be a pdf");

  for (const f of found){
    lex.pos = f.at;
    let v;
    try { v = lex.parse(); } catch (e){ continue; }
    if (v && v.t === "streamAt"){
      let len = v.dict.get("Length");
      if (len instanceof PdfRef) len = null;
      let end;
      if (typeof len === "number" && len >= 0 && v.start + len <= u8.length){
        end = v.start + len;
        const tail = text.slice(end, end + 20);
        if (!/^\s*endstream/.test(tail)) end = null;
      }
      if (end == null){
        const idx = text.indexOf("endstream", v.start);
        end = idx < 0 ? u8.length : idx;
        while (end > v.start && (u8[end - 1] === 10 || u8[end - 1] === 13)) end--;
      }
      objs.set(f.num, new PdfStream(v.dict, u8.subarray(v.start, end)));
    } else {
      objs.set(f.num, v);
    }
  }

  const resolve = v => {
    let guard = 0;
    while (v instanceof PdfRef && guard++ < 64) v = objs.get(v.num);
    return v;
  };

  for (const [num, o] of objs){
    if (!(o instanceof PdfStream)) continue;
    const len = resolve(o.dict.get("Length"));
    if (typeof len === "number" && len >= 0 && len !== o.raw.length){
      if (o.raw.byteOffset - u8.byteOffset + len <= u8.length)
        objs.set(num, new PdfStream(o.dict, u8.subarray(o.raw.byteOffset - u8.byteOffset, o.raw.byteOffset - u8.byteOffset + len)));
    }
  }

  const streamData = async o => {
    const filters = [].concat(resolve(o.dict.get("Filter")) || []);
    let data = o.raw;
    for (const f of filters){
      const nm = f instanceof PdfName ? f.name : null;
      if (nm === "FlateDecode") data = await inflate(data);
      else if (nm === "ASCIIHexDecode"){
        const s = new TextDecoder("latin1").decode(data).replace(/[^0-9a-fA-F>]/g, "");
        const hex = s.slice(0, s.indexOf(">") < 0 ? s.length : s.indexOf(">"));
        data = Uint8Array.from((hex.match(/../g) || []).map(h => parseInt(h, 16)));
      }
      else if (nm === null) continue;
      else throw new Error("stream filter " + nm + " is unsupported here");
    }
    return data;
  };

  for (const [, o] of [...objs]){
    if (!(o instanceof PdfStream)) continue;
    const type = resolve(o.dict.get("Type"));
    if (!(type instanceof PdfName) || type.name !== "ObjStm") continue;
    let data;
    try { data = await streamData(o); } catch (e){ continue; }
    const n = resolve(o.dict.get("N")) || 0;
    const first = resolve(o.dict.get("First")) || 0;
    const headText = new TextDecoder("latin1").decode(data.subarray(0, first));
    const nums = headText.trim().split(/\s+/).map(Number);
    const inner = pdfLex(data);
    for (let i = 0; i < n; i++){
      const num = nums[i * 2], off = nums[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      if (objs.has(num) && !(objs.get(num) === undefined)) continue;
      inner.pos = first + off;
      try { objs.set(num, inner.parse()); } catch (e){ /* skip */ }
    }
  }

  let root = null;
  for (const [, o] of objs){
    const d = o instanceof PdfStream ? o.dict : o;
    if (!(d instanceof Map)) continue;
    const t = resolve(d.get("Type"));
    if (t instanceof PdfName && t.name === "Catalog"){ root = d; break; }
  }
  const pages = [];
  const walk = (node, depth, inherited) => {
    if (depth > 64) return;
    const d = resolve(node);
    if (!(d instanceof Map)) return;
    const inh = { ...inherited };
    for (const k of ["Resources","MediaBox","CropBox","Rotate"]) if (d.has(k)) inh[k] = d.get(k);
    const t = resolve(d.get("Type"));
    const kids = resolve(d.get("Kids"));
    if (Array.isArray(kids)){
      for (const k of kids) walk(k, depth + 1, inh);
      return;
    }
    if (t instanceof PdfName && t.name === "Page") pages.push({ dict: d, inherited: inh });
    else if (d.has("Contents")) pages.push({ dict: d, inherited: inh });
  };
  if (root) walk(root.get("Pages"), 0, {});
  if (!pages.length){
    for (const [, o] of objs){
      const d = o instanceof PdfStream ? o.dict : o;
      if (!(d instanceof Map)) continue;
      const t = resolve(d.get("Type"));
      if (t instanceof PdfName && t.name === "Page") pages.push({ dict: d, inherited: {} });
    }
  }
  if (!pages.length) throw new Error("no pages found in this pdf");
  return { objs, resolve, streamData, pages, root };
}

export function pdfSerialize(v, out){
  const put = s => out.push(enc.encode(s));
  if (v === null || v === undefined){ put("null"); return; }
  if (v instanceof PdfRef){ put(`${v.num} 0 R`); return; }
  if (v instanceof PdfName){ put("/" + v.name.replace(/[^\w.\-+]/g, c => "#" + c.charCodeAt(0).toString(16))); return; }
  if (typeof v === "boolean"){ put(v ? "true" : "false"); return; }
  if (typeof v === "number"){ put(Number.isInteger(v) ? String(v) : String(+v.toFixed(6))); return; }
  if (Array.isArray(v)){
    put("[");
    v.forEach((x, i) => { if (i) put(" "); pdfSerialize(x, out); });
    put("]");
    return;
  }
  if (v instanceof Map){
    put("<<");
    for (const [k, x] of v){
      put("/" + k + " ");
      pdfSerialize(x, out);
      put(" ");
    }
    put(">>");
    return;
  }
  if (v && v.t === "str"){
    if (v.hex){ put("<" + new TextDecoder("latin1").decode(v.v) + ">"); return; }
    put("(");
    out.push(v.v);
    put(")");
    return;
  }
  if (v && v.t === "kw"){ put(v.v); return; }
  put("null");
}

export async function pdfBuild(plan, opts){
  const chunks = [];
  let next = 1;
  const mapping = new Map();
  const bodies = new Map();

  const alloc = () => next++;

  const copy = (doc, val, depth) => {
    if (depth > 96) return null;
    if (val instanceof PdfRef){
      const key = doc.id + ":" + val.num;
      if (mapping.has(key)) return new PdfRef(mapping.get(key));
      const target = doc.objs.get(val.num);
      if (target === undefined) return null;
      const num = alloc();
      mapping.set(key, num);
      bodies.set(num, copy(doc, target, depth + 1));
      return new PdfRef(num);
    }
    if (Array.isArray(val)) return val.map(v => copy(doc, v, depth + 1));
    if (val instanceof Map){
      const d = new Map();
      for (const [k, v] of val){
        if (k === "Parent") continue;
        d.set(k, copy(doc, v, depth + 1));
      }
      return d;
    }
    if (val instanceof PdfStream){
      const d = new Map();
      for (const [k, v] of val.dict) if (k !== "Parent") d.set(k, copy(doc, v, depth + 1));
      return new PdfStream(d, val.raw);
    }
    return val;
  };

  const pagesNum = alloc();
  const catalogNum = alloc();
  const kids = [];

  for (const step of plan){
    const { doc, page, rotate, crop } = step;
    const num = alloc();
    const src = page.dict;
    const d = new Map();
    for (const [k, v] of src){
      if (k === "Parent") continue;
      d.set(k, copy(doc, v, 0));
    }
    for (const k of ["Resources","MediaBox","CropBox","Rotate"]){
      if (!d.has(k) && page.inherited[k] !== undefined) d.set(k, copy(doc, page.inherited[k], 0));
    }
    if (!d.has("Type")) d.set("Type", new PdfName("Page"));
    d.set("Parent", new PdfRef(pagesNum));

    let box = doc.resolve(d.get("MediaBox"));
    if (Array.isArray(box)) box = box.map(x => typeof x === "number" ? x : doc.resolve(x));
    if (!Array.isArray(box) || box.length !== 4) box = [0, 0, 612, 792];
    if (crop){
      const [x0, y0, x1, y1] = [Math.min(box[0], box[2]), Math.min(box[1], box[3]),
                                Math.max(box[0], box[2]), Math.max(box[1], box[3])];
      const w = x1 - x0, h = y1 - y0;
      const nb = [x0 + w * crop.left, y0 + h * crop.bottom, x1 - w * crop.right, y1 - h * crop.top];
      if (nb[2] - nb[0] > 1 && nb[3] - nb[1] > 1) d.set("CropBox", nb.map(x => +x.toFixed(3)));
    }
    if (rotate){
      const cur = doc.resolve(d.get("Rotate"));
      d.set("Rotate", (((typeof cur === "number" ? cur : 0) + rotate) % 360 + 360) % 360);
    }
    bodies.set(num, d);
    kids.push(new PdfRef(num));
  }

  const pagesDict = new Map([
    ["Type", new PdfName("Pages")],
    ["Kids", kids],
    ["Count", kids.length]
  ]);
  bodies.set(pagesNum, pagesDict);
  bodies.set(catalogNum, new Map([
    ["Type", new PdfName("Catalog")],
    ["Pages", new PdfRef(pagesNum)]
  ]));

  const header = enc.encode("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
  chunks.push(header);
  let pos = header.length;
  const offsets = new Map();
  const maxNum = next - 1;
  for (let n = 1; n <= maxNum; n++){
    let v = bodies.get(n);
    if (v === undefined) continue;
    offsets.set(n, pos);
    const parts = [];
    parts.push(enc.encode(`${n} 0 obj\n`));
    if (v instanceof PdfStream){
      const d = new Map(v.dict);
      let raw = v.raw;
      if (opts && opts.recompress && !d.has("Filter") && raw.length > 64){
        try {
          const z = await deflateZlib(raw);
          if (z.length < raw.length){ raw = z; d.set("Filter", new PdfName("FlateDecode")); }
        } catch (e){ }
      }
      v = new PdfStream(d, raw);
      d.set("Length", raw.length);
      const dd = [];
      pdfSerialize(d, dd);
      parts.push(...dd, enc.encode("\nstream\n"), v.raw, enc.encode("\nendstream"));
    } else {
      const dd = [];
      pdfSerialize(v, dd);
      parts.push(...dd);
    }
    parts.push(enc.encode("\nendobj\n"));
    for (const b of parts){ chunks.push(b); pos += b.length; }
  }
  const xrefAt = pos;
  const lines = [`xref\n0 ${maxNum + 1}\n`, "0000000000 65535 f \n"];
  for (let n = 1; n <= maxNum; n++){
    const off = offsets.get(n);
    lines.push(off === undefined
      ? "0000000000 65535 f \n"
      : String(off).padStart(10, "0") + " 00000 n \n");
  }
  lines.push(`trailer\n<< /Size ${maxNum + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  for (const l of lines) chunks.push(enc.encode(l));
  return concatBytes(chunks);
}
