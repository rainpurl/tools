// Documents as HTML, plus Markdown, plain text and RTF writing.

import { escHtml } from "./util.js";

export function htmlDoc(title, body){
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(title || "Document")}</title>
<style>
body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1.25rem;color:#111}
h1,h2,h3,h4{line-height:1.25;margin:2rem 0 .6rem}
pre{background:#f4f4f4;padding:.9rem;border-radius:6px;overflow:auto}
code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px;font-size:.92em}
pre code{background:none;padding:0}
blockquote{margin:1rem 0;padding-left:1rem;border-left:3px solid #ddd;color:#555}
table{border-collapse:collapse;margin:1rem 0;width:100%}
th,td{border:1px solid #ddd;padding:.45rem .6rem;text-align:left;vertical-align:top}
th{background:#f7f7f7}
img{max-width:100%}
hr{border:0;border-top:1px solid #ddd;margin:2rem 0}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function mdInline(s){
  let t = escHtml(s);
  const stash = [];
  const keep = html => { stash.push(html); return "\u0000" + (stash.length - 1) + "\u0000"; };
  t = t.replace(/`([^`]+)`/g, (m, c) => keep("<code>" + c + "</code>"));
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (m, a, u, ti) => keep(`<img src="${u}" alt="${a}"${ti ? ` title="${ti}"` : ""}>`));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (m, a, u, ti) => keep(`<a href="${u}"${ti ? ` title="${ti}"` : ""}>${a}</a>`));
  t = t.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (m, u) => keep(`<a href="${u}">${u}</a>`));
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  t = t.replace(/(\*{3}|_{3})(?=\S)(.+?)(?<=\S)\1/g, "<strong><em>$2</em></strong>");
  t = t.replace(/(\*{2}|_{2})(?=\S)(.+?)(?<=\S)\1/g, "<strong>$2</strong>");
  t = t.replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "<em>$1</em>");
  t = t.replace(/(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, "<em>$1</em>");
  t = t.replace(/ {2,}$/gm, "<br>");
  t = t.replace(/\\$/gm, "<br>");
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
}

export function mdToHtml(md){
  const lines = md.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const out = [];
  let i = 0;

  const listBlock = (baseIndent) => {
    const items = [];
    let ordered = null;
    while (i < lines.length){
      const ln = lines[i];
      const m = ln.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (!m) break;
      const ind = m[1].length;
      if (ind < baseIndent) break;
      if (ind > baseIndent + 1){
        if (!items.length) break;
        items[items.length - 1].sub.push(ln.slice(baseIndent + 2));
        i++;
        continue;
      }
      const isOrd = /\d/.test(m[2][0]);
      if (ordered === null) ordered = isOrd;
      else if (ordered !== isOrd) break;
      items.push({ text: m[3], sub: [] });
      i++;
      while (i < lines.length){
        const nx = lines[i];
        if (!nx.trim()){
          const after = lines[i + 1] || "";
          if (/^(\s*)([-*+]|\d+[.)])\s+/.test(after) || /^\s{2,}\S/.test(after)){ items[items.length - 1].sub.push(""); i++; continue; }
          break;
        }
        if (/^(\s*)([-*+]|\d+[.)])\s+/.test(nx) && (nx.match(/^\s*/)[0].length <= baseIndent + 1)) break;
        if (/^\s{2,}\S/.test(nx)){ items[items.length - 1].sub.push(nx.replace(/^ {2,4}/, "")); i++; continue; }
        items[items.length - 1].text += " " + nx.trim();
        i++;
      }
    }
    const tag = ordered ? "ol" : "ul";
    return `<${tag}>\n` + items.map(it => {
      const sub = it.sub.join("\n").trim();
      return "<li>" + mdInline(it.text) + (sub ? "\n" + mdToHtml(sub) : "") + "</li>";
    }).join("\n") + `\n</${tag}>`;
  };

  while (i < lines.length){
    const ln = lines[i];
    if (!ln.trim()){ i++; continue; }

    let m = ln.match(/^(```+|~~~+)\s*([\w-]*)\s*$/);
    if (m){
      const fence = m[1][0].repeat(m[1].length);
      const lang = m[2];
      i++;
      const buf = [];
      while (i < lines.length && !new RegExp("^" + fence[0] + "{" + fence.length + ",}\s*$").test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${escHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    m = ln.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m){ out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`); i++; continue; }

    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(ln)){ out.push("<hr>"); i++; continue; }

    if (/^\s*>/.test(ln)){
      const buf = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (lines[i].trim() && buf.length))) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push("<blockquote>\n" + mdToHtml(buf.join("\n")) + "\n</blockquote>");
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")){
      const split = r => r.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));
      const heads = split(lines[i]);
      const align = split(lines[i + 1]).map(a => /^:-+:$/.test(a) ? "center" : /-+:$/.test(a) ? "right" : /^:-+/.test(a) ? "left" : "");
      i += 2;
      const body = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) body.push(split(lines[i++]));
      const th = heads.map((h, k) => `<th${align[k] ? ` style="text-align:${align[k]}"` : ""}>${mdInline(h)}</th>`).join("");
      const tr = body.map(r => "<tr>" + heads.map((_, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ""}>${mdInline(r[k] || "")}</td>`).join("") + "</tr>").join("\n");
      out.push(`<table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${tr}\n</tbody>\n</table>`);
      continue;
    }

    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(ln)){ out.push(listBlock(ln.match(/^\s*/)[0].length)); continue; }

    if (/^ {4,}\S/.test(ln) && !out.length){
      const buf = [];
      while (i < lines.length && (/^ {4,}/.test(lines[i]) || !lines[i].trim())) buf.push(lines[i++].replace(/^ {4}/, ""));
      out.push("<pre><code>" + escHtml(buf.join("\n").replace(/\n+$/, "")) + "</code></pre>");
      continue;
    }

    if (/^\s*<(\/?)([a-zA-Z][\w-]*)/.test(ln)){
      const buf = [];
      while (i < lines.length && lines[i].trim()) buf.push(lines[i++]);
      out.push(buf.join("\n"));
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|```|~~~|\s*\|)/.test(lines[i]) && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])){
      para.push(lines[i++]);
    }
    if (para.length) out.push("<p>" + mdInline(para.join("\n")) + "</p>");
    else i++;
  }
  return out.join("\n");
}

export const H_LEVEL = { H1:1, H2:2, H3:3, H4:4, H5:5, H6:6 };

export function escMd(s){
  return s.replace(/\\/g, "\\\\").replace(/([`*\[\]])/g, "\\$1").replace(/<(?=[a-zA-Z/!?])/g, "\\<");
}

export function htmlToMd(html){
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,title,meta,link,base,head").forEach(n => n.remove());
  return mdTidy(mdKids(doc.body || doc.documentElement, { depth: 0 }));
}

export function mdKids(node, ctx){
  let s = "";
  for (const c of node.childNodes) s += mdNode(c, ctx);
  return s;
}

export function mdNode(node, ctx){
  if (node.nodeType === 3) return escMd(node.nodeValue.replace(/\u00a0/g, " ").replace(/[\t\r\n]+/g, " ").replace(/ {2,}/g, " "));
  if (node.nodeType !== 1) return "";
  const tag = node.tagName.toUpperCase();
  if (tag in H_LEVEL){
    const t = mdKids(node, ctx).replace(/\s*\n+\s*/g, " ").trim();
    return t ? "\n\n" + "#".repeat(H_LEVEL[tag]) + " " + t + "\n\n" : "";
  }
  switch (tag){
    case "BR": return "\\\n";
    case "HR": return "\n\n---\n\n";
    case "WBR": return "";
    case "IMG": {
      const src = (node.getAttribute("src") || "").trim();
      const alt = (node.getAttribute("alt") || "").replace(/[\[\]]/g, "").trim();
      if (!src) return "";
      if (/^data:/i.test(src)) return alt ? `[embedded image: ${alt}]` : "[embedded image]";
      return `![${alt || "image"}](${src})`;
    }
    case "A": {
      const href = (node.getAttribute("href") || "").trim();
      const text = mdKids(node, ctx).replace(/\s*\n+\s*/g, " ").trim();
      if (!href || /^javascript:/i.test(href)) return text;
      if (!text) return "<" + href + ">";
      if (text.replace(/\\/g, "") === href) return "<" + href + ">";
      return `[${text}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    case "STRONG": case "B": return mdWrap(node, ctx, "**");
    case "EM": case "I": case "CITE": return mdWrap(node, ctx, "*");
    case "DEL": case "S": case "STRIKE": return mdWrap(node, ctx, "~~");
    case "CODE": case "SAMP": case "KBD": {
      if (node.closest("pre")) return escMd(node.textContent);
      const t = node.textContent.replace(/`/g, "").replace(/\s+/g, " ").trim();
      return t ? "`" + t + "`" : "";
    }
    case "PRE": {
      const code = node.querySelector("code");
      const cls = code ? (code.className.match(/language-([\w-]+)/) || [])[1] || "" : "";
      const t = node.textContent.replace(/\s+$/, "");
      return t ? "\n\n```" + cls + "\n" + t + "\n```\n\n" : "";
    }
    case "BLOCKQUOTE": {
      const inner = mdTidy(mdKids(node, ctx));
      return inner ? "\n\n" + inner.split("\n").map(l => l ? "> " + l : ">").join("\n") + "\n\n" : "";
    }
    case "UL": case "OL": return mdList(node, ctx);
    case "LI": return mdKids(node, ctx);
    case "TABLE": return mdTable(node, ctx);
    case "TR": case "TD": case "TH": case "THEAD": case "TBODY": case "TFOOT": return mdKids(node, ctx);
    case "P": case "DIV": case "SECTION": case "ARTICLE": case "HEADER": case "FOOTER":
    case "ASIDE": case "MAIN": case "NAV": case "ADDRESS": case "FIGURE": case "FIGCAPTION":
    case "CENTER": case "DL": case "DT": case "FORM": case "FIELDSET": {
      const inner = mdKids(node, ctx).trim();
      return inner ? "\n\n" + inner + "\n\n" : "";
    }
    case "DD": {
      const inner = mdKids(node, ctx).trim();
      return inner ? "\n\n    " + inner + "\n\n" : "";
    }
    default: return mdKids(node, ctx);
  }
}

export function mdWrap(node, ctx, mark){
  const inner = mdKids(node, ctx), core = inner.trim();
  if (!core || core.includes("\n\n")) return inner;
  return inner.match(/^\s*/)[0] + mark + core + mark + inner.match(/\s*$/)[0];
}

export function mdList(node, ctx){
  const ordered = node.tagName.toUpperCase() === "OL";
  let n = parseInt(node.getAttribute("start") || "1", 10);
  if (!Number.isFinite(n)) n = 1;
  const pad = "  ".repeat(ctx.depth);
  const items = [];
  for (const li of node.children){
    if (li.tagName.toUpperCase() !== "LI") continue;
    const inner = mdTidy(mdKids(li, { depth: ctx.depth + 1 })).replace(/\n{2,}/g, "\n");
    if (!inner) continue;
    const mark = ordered ? (n++) + ". " : "- ";
    items.push(inner.split("\n").map((l, k) => pad + (k === 0 ? mark : " ".repeat(mark.length)) + l).join("\n"));
  }
  return items.length ? "\n\n" + items.join("\n") + "\n\n" : "";
}

export function mdTable(node, ctx){
  const rows = Array.from(node.querySelectorAll("tr")).filter(tr => tr.closest("table") === node);
  if (!rows.length) return mdKids(node, ctx);
  const grid = rows.map(tr => Array.from(tr.children)
    .filter(c => c.tagName === "TD" || c.tagName === "TH")
    .map(c => mdKids(c, ctx).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim()));
  const hasTh = rows.some(tr => tr.querySelector("th"));
  const widths = grid.map(r => r.length);
  const uniform = widths.length > 1 && widths.every(w => w === widths[0]) && widths[0] > 1;
  if (!hasTh && !uniform){
    const blocks = grid.map(r => r.filter(Boolean).join("\n\n")).filter(Boolean);
    return blocks.length ? "\n\n" + blocks.join("\n\n") + "\n\n" : "";
  }
  const cols = Math.max(...widths);
  const pad = r => { const c = r.slice(); while (c.length < cols) c.push(""); return c; };
  const head = pad(grid[0]);
  const out = ["| " + head.join(" | ") + " |", "| " + head.map(() => "---").join(" | ") + " |",
    ...grid.slice(1).map(r => "| " + pad(r).join(" | ") + " |")];
  return "\n\n" + out.join("\n") + "\n\n";
}

export function mdTidy(s){
  return s.replace(/\u00a0/g, " ").replace(/[ \t]+(?=\n)/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html, wrap){
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,head").forEach(n => n.remove());
  doc.querySelectorAll("br").forEach(n => n.replaceWith("\n"));
  doc.querySelectorAll("p,div,h1,h2,h3,h4,h5,h6,li,tr,blockquote,pre").forEach(n => n.append("\n"));
  doc.querySelectorAll("td,th").forEach(n => n.append("\t"));
  let t = (doc.body || doc.documentElement).textContent
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (wrap && wrap > 20){
    t = t.split("\n").map(line => {
      if (line.length <= wrap) return line;
      const words = line.split(/ /);
      const rows = [];
      let cur = "";
      for (const w of words){
        if (cur && (cur + " " + w).length > wrap){ rows.push(cur); cur = w; }
        else cur = cur ? cur + " " + w : w;
      }
      if (cur) rows.push(cur);
      return rows.join("\n");
    }).join("\n");
  }
  return t + "\n";
}

export function rtfToText(text){
  let s = text;
  s = s.replace(/\{\\\*?\\(fonttbl|colortbl|stylesheet|info|pict|themedata|colorschememapping|latentstyles|datastore|generator)[^{}]*(\{[^{}]*\})*[^{}]*\}/gi, "");
  s = s.replace(/\\u(-?\d+)\s?\??/g, (m, n) => String.fromCharCode(((+n) + 65536) % 65536));
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\par[d]?\b/g, "\n").replace(/\\line\b/g, "\n").replace(/\\tab\b/g, "\t");
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, "");
  s = s.replace(/[{}]/g, "");
  return s.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function htmlToRtf(html){
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,head").forEach(n => n.remove());
  const esc = s => s.replace(/[\\{}]/g, c => "\\" + c)
    .replace(/[\u0080-\uffff]/g, c => "\\u" + c.charCodeAt(0) + "?");
  const walk = (n, st) => {
    if (n.nodeType === 3) return esc(n.nodeValue.replace(/\s+/g, " "));
    if (n.nodeType !== 1) return "";
    const t = n.tagName.toUpperCase();
    const kids = () => Array.from(n.childNodes).map(c => walk(c, st)).join("");
    if (t in H_LEVEL){ const sz = 34 - H_LEVEL[t] * 3; return `\\pard\\sa180\\b\\fs${sz} ${kids()}\\b0\\fs22\\par\n`; }
    switch (t){
      case "BR": return "\\line ";
      case "HR": return "\\pard\\brdrb\\brdrs\\brdrw10\\par\n";
      case "B": case "STRONG": return "{\\b " + kids() + "}";
      case "I": case "EM": return "{\\i " + kids() + "}";
      case "U": return "{\\ul " + kids() + "}";
      case "CODE": case "PRE": return "{\\f1 " + kids() + "}" + (t === "PRE" ? "\\par\n" : "");
      case "LI": return "\\pard\\fi-360\\li720\\sa60 \\bullet\\tab " + kids() + "\\par\n";
      case "P": case "DIV": case "BLOCKQUOTE": return "\\pard\\sa180 " + kids() + "\\par\n";
      case "TR": return kids() + "\\par\n";
      case "TD": case "TH": return kids() + "\\tab ";
      default: return kids();
    }
  };
  const body = walk(doc.body || doc.documentElement, {});
  return "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}{\\f1 Courier New;}}\\fs22\n" + body + "}";
}
