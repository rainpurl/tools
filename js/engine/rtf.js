// RTF reading.

import { htmlDoc } from "./rich.js";
import { escHtml } from "./util.js";

export const RTF_SKIP = new Set(["fonttbl","filetbl","colortbl","stylesheet","listtable",
  "listoverridetable","revtbl","rsidtbl","generator","info","pict","object","objdata",
  "themedata","colorschememapping","latentstyles","datastore","xmlnstbl","pgptbl",
  "header","headerl","headerr","headerf","footer","footerl","footerr","footerf",
  "fldinst","bkmkstart","bkmkend","atnid","atnauthor","annotation","mmath"]);

export function rtfStyleNames(text){
  const at = text.indexOf("\\stylesheet");
  const map = new Map();
  if (at < 0) return map;
  let depth = 0, i = at;
  for (; i < text.length; i++){
    if (text[i] === "\\"){ i++; continue; }
    if (text[i] === "{") depth++;
    else if (text[i] === "}"){ depth--; if (!depth) break; }
  }
  const block = text.slice(at, i);
  for (const m of block.matchAll(/\\s(\d+)[^;]*?(?:\\\w+\s?)*\s*([^\\{};]+);/g)){
    const name = m[2].trim();
    if (name) map.set(+m[1], name.toLowerCase());
  }
  return map;
}

export function rtfToHtml(text, title){
  const styles = rtfStyleNames(text);
  const out = [];
  let para = [];
  let listStack = [];
  let table = null;
  let row = null, cell = [];

  const st = { b: 0, i: 0, ul: 0, strike: 0, sup: 0, sub: 0 };
  const stack = [];
  let pStyle = { outline: null, style: null, inList: false, listOrdered: false, inTable: false };
  let uniSkip = 1, pendingSkip = 0;

  const wrap = s => {
    if (!s) return "";
    let r = escHtml(s);
    if (st.strike) r = "<del>" + r + "</del>";
    if (st.ul) r = "<u>" + r + "</u>";
    if (st.i) r = "<em>" + r + "</em>";
    if (st.b) r = "<strong>" + r + "</strong>";
    if (st.sup) r = "<sup>" + r + "</sup>";
    if (st.sub) r = "<sub>" + r + "</sub>";
    return r;
  };
  const push = s => { if (s) para.push(wrap(s)); };

  const closeLists = to => {
    while (listStack.length > to) out.push("</" + listStack.pop() + ">");
  };

  const flushPara = () => {
    const html = para.join("").replace(/\s+$/, "");
    para = [];
    if (pStyle.inTable){
      cell.push(html);
      return;
    }
    if (!html.trim()){ return; }
    const styleName = pStyle.style !== null ? (styles.get(pStyle.style) || "") : "";
    let level = null;
    if (pStyle.outline !== null && pStyle.outline >= 0 && pStyle.outline <= 8) level = pStyle.outline + 1;
    const byName = styleName.match(/^heading\s*(\d)/) || styleName.match(/^h(\d)$/);
    if (level === null && byName) level = +byName[1];
    if (level === null && /^title$/.test(styleName)) level = 1;
    if (level === null && /^subtitle$/.test(styleName)) level = 2;

    if (pStyle.inList){
      const tag = pStyle.listOrdered ? "ol" : "ul";
      if (!listStack.length || listStack[listStack.length - 1] !== tag){
        closeLists(0);
        out.push("<" + tag + ">");
        listStack.push(tag);
      }
      out.push("<li>" + html + "</li>");
      return;
    }
    closeLists(0);
    if (level){
      const bare = (html.match(/<strong>/g) || []).length === 1
        ? html.replace(/^<strong>([\s\S]*)<\/strong>$/, "$1") : html;
      out.push(`<h${Math.min(6, level)}>${bare}</h${Math.min(6, level)}>`);
    }
    else out.push("<p>" + html + "</p>");
  };

  const endCell = () => { cell.push(para.join("")); para = []; row.push(cell.join("")); cell = []; };
  const endRow = () => {
    if (row && row.length) table.rows.push(row);
    row = [];
  };
  const endTable = () => {
    if (table && table.rows.length){
      closeLists(0);
      const head = table.rows[0].map(c => `<th>${c || ""}</th>`).join("");
      const rest = table.rows.slice(1).map(r => "<tr>" + r.map(c => `<td>${c || ""}</td>`).join("") + "</tr>").join("");
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rest}</tbody></table>`);
    }
    table = null; row = null; cell = [];
  };

  let i = 0;
  const n = text.length;
  while (i < n){
    const ch = text[i];

    if (ch === "{"){
      stack.push({ st: { ...st }, pStyle: { ...pStyle }, uniSkip });
      i++;
      if (text[i] === "\\" && text[i + 1] === "*"){
        let d = 1;
        i += 2;
        while (i < n && d > 0){
          if (text[i] === "\\"){ i += 2; continue; }
          if (text[i] === "{") d++;
          else if (text[i] === "}") d--;
          i++;
        }
        stack.pop();
      }
      continue;
    }
    if (ch === "}"){
      const prev = stack.pop();
      if (prev){ Object.assign(st, prev.st); Object.assign(pStyle, prev.pStyle); uniSkip = prev.uniSkip; }
      i++;
      continue;
    }
    if (ch === "\\"){
      i++;
      const c2 = text[i];
      if (c2 === "'"){
        const hex = text.slice(i + 1, i + 3);
        i += 3;
        if (pendingSkip > 0){ pendingSkip--; continue; }
        const code = parseInt(hex, 16);
        if (Number.isFinite(code)) push(cp1252(code));
        continue;
      }
      if (c2 === "\\" || c2 === "{" || c2 === "}"){ i++; push(c2); continue; }
      if (c2 === "\n" || c2 === "\r"){ i++; flushPara(); continue; }
      if (c2 === "~"){ i++; push("\u00a0"); continue; }
      if (c2 === "-"){ i++; continue; }
      if (c2 === "_"){ i++; push("\u2011"); continue; }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(text.slice(i));
      if (!m){ i++; continue; }
      const word = m[1];
      const param = m[2] === undefined ? null : +m[2];
      i += m[0].length;

      if (RTF_SKIP.has(word)){
        let d = 1;
        while (i < n && d > 0){
          if (text[i] === "\\"){ i += 2; continue; }
          if (text[i] === "{") d++;
          else if (text[i] === "}"){ d--; if (!d) break; }
          i++;
        }
        const prev = stack.pop();
        if (prev){ Object.assign(st, prev.st); Object.assign(pStyle, prev.pStyle); uniSkip = prev.uniSkip; }
        i++;
        continue;
      }

      switch (word){
        case "par": flushPara(); break;
        case "line": para.push("<br>"); break;
        case "tab": push("\t"); break;
        case "cell": if (table){ endCell(); } else { flushPara(); } break;
        case "row": case "nestrow": if (table) endRow(); break;
        case "trowd": if (!table){ flushPara(); table = { rows: [] }; row = []; cell = []; } pStyle.inTable = true; break;
        case "intbl": pStyle.inTable = true; if (!table){ table = { rows: [] }; row = []; cell = []; } break;
        case "pard":
          if (pStyle.inTable && table && !/\\intbl/.test(text.slice(i, i + 80))) { endRow(); endTable(); }
          pStyle = { outline: null, style: null, inList: false, listOrdered: false, inTable: false };
          break;
        case "plain": st.b = st.i = st.ul = st.strike = st.sup = st.sub = 0; break;
        case "b": st.b = param === 0 ? 0 : 1; break;
        case "i": st.i = param === 0 ? 0 : 1; break;
        case "ul": st.ul = param === 0 ? 0 : 1; break;
        case "ulnone": st.ul = 0; break;
        case "strike": st.strike = param === 0 ? 0 : 1; break;
        case "super": st.sup = param === 0 ? 0 : 1; break;
        case "sub": st.sub = param === 0 ? 0 : 1; break;
        case "nosupersub": st.sup = st.sub = 0; break;
        case "outlinelevel": pStyle.outline = param; break;
        case "s": pStyle.style = param; break;
        case "ls": case "ilvl": pStyle.inList = true; break;
        case "pntext": case "listtext": {
          let d = 1, buf = "";
          while (i < n && d > 0){
            if (text[i] === "\\"){
              const mm = /^\\'([0-9a-fA-F]{2})/.exec(text.slice(i));
              if (mm){ buf += cp1252(parseInt(mm[1], 16)); i += 4; continue; }
              const cw = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(text.slice(i));
              if (cw){
                if (cw[1] === "tab") buf += "\t";
                i += cw[0].length;
                continue;
              }
              i += 2; continue;
            }
            if (text[i] === "{") d++;
            else if (text[i] === "}"){ d--; if (!d) break; }
            else buf += text[i];
            i++;
          }
          i++;
          pStyle.inList = true;
          pStyle.listOrdered = /\d/.test(buf);
          const prev = stack.pop();
          if (prev){ Object.assign(st, prev.st); uniSkip = prev.uniSkip; }
          break;
        }
        case "pnlvlblt": pStyle.listOrdered = false; pStyle.inList = true; break;
        case "pnlvlbody": case "pndec": pStyle.listOrdered = true; pStyle.inList = true; break;
        case "uc": uniSkip = param === null ? 1 : param; break;
        case "u": {
          if (param !== null){
            const code = param < 0 ? param + 65536 : param;
            push(String.fromCharCode(code));
            pendingSkip = uniSkip;
          }
          break;
        }
        case "bullet": push("\u2022"); break;
        case "endash": push("\u2013"); break;
        case "emdash": push("\u2013"); break;
        case "lquote": push("\u2018"); break;
        case "rquote": push("\u2019"); break;
        case "ldblquote": push("\u201c"); break;
        case "rdblquote": push("\u201d"); break;
        default: break;
      }
      continue;
    }

    if (ch === "\n" || ch === "\r"){ i++; continue; }
    if (pendingSkip > 0){ pendingSkip--; i++; continue; }
    let j = i;
    while (j < n && text[j] !== "\\" && text[j] !== "{" && text[j] !== "}" && text[j] !== "\n" && text[j] !== "\r") j++;
    push(text.slice(i, j));
    i = j;
  }
  flushPara();
  if (table){ endRow(); endTable(); }
  closeLists(0);
  if (!out.length) throw new Error("no readable text in this rtf file");
  return htmlDoc(title || "Document", out.join("\n"));
}

export function cp1252(code){
  const high = { 0x80:"\u20ac",0x82:"\u201a",0x83:"\u0192",0x84:"\u201e",0x85:"\u2026",
    0x86:"\u2020",0x87:"\u2021",0x88:"\u02c6",0x89:"\u2030",0x8a:"\u0160",0x8b:"\u2039",
    0x8c:"\u0152",0x8e:"\u017d",0x91:"\u2018",0x92:"\u2019",0x93:"\u201c",0x94:"\u201d",
    0x95:"\u2022",0x96:"\u2013",0x97:"\u2014",0x98:"\u02dc",0x99:"\u2122",0x9a:"\u0161",
    0x9b:"\u203a",0x9c:"\u0153",0x9e:"\u017e",0x9f:"\u0178" };
  return high[code] || String.fromCharCode(code);
}
