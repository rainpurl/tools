// LaTeX, AsciiDoc, reStructuredText and BBCode writers.

export function walkRich(html, h){
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,head,noscript").forEach(n => n.remove());
  const inline = node => {
    let out = "";
    for (const c of node.childNodes){
      if (c.nodeType === 3){ out += h.text(c.nodeValue.replace(/\s+/g, " ")); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName.toUpperCase();
      if (t === "BR"){ out += h.br(); continue; }
      if (t === "IMG"){ out += h.image(c.getAttribute("src") || "", c.getAttribute("alt") || ""); continue; }
      if (t === "A"){ out += h.link(c.getAttribute("href") || "", inline(c)); continue; }
      if (t === "B" || t === "STRONG"){ out += h.bold(inline(c)); continue; }
      if (t === "I" || t === "EM" || t === "CITE"){ out += h.italic(inline(c)); continue; }
      if (t === "U"){ out += h.under(inline(c)); continue; }
      if (t === "DEL" || t === "S" || t === "STRIKE"){ out += h.strike(inline(c)); continue; }
      if (t === "CODE" || t === "SAMP" || t === "KBD"){ out += h.code(inline(c)); continue; }
      if (t === "SUP"){ out += h.sup ? h.sup(inline(c)) : inline(c); continue; }
      if (t === "SUB"){ out += h.sub ? h.sub(inline(c)) : inline(c); continue; }
      out += inline(c);
    }
    return out;
  };
  const blocks = [];
  const levels = [];
  const emit = (html, level) => { blocks.push(html); levels.push(level || 0); };
  const walk = (node, depth) => {
    for (const el of node.children){
      const t = el.tagName.toUpperCase();
      if (/^H[1-6]$/.test(t)){ emit(h.heading(+t[1], inline(el)), +t[1]); continue; }
      if (t === "P"){ const s = inline(el).trim(); if (s) emit(h.para(s)); continue; }
      if (t === "HR"){ emit(h.rule()); continue; }
      if (t === "PRE"){ emit(h.pre(el.textContent.replace(/\n+$/, ""))); continue; }
      if (t === "BLOCKQUOTE"){
        const inner = Array.from(el.children).length
          ? Array.from(el.children).map(c => inline(c).trim()).filter(Boolean).join("\n")
          : inline(el).trim();
        if (inner) emit(h.quote(inner));
        continue;
      }
      if (t === "UL" || t === "OL"){
        const items = [];
        for (const li of el.children){
          if (li.tagName.toUpperCase() !== "LI") continue;
          const clone = li.cloneNode(true);
          const nested = Array.from(clone.children).filter(c => /^(UL|OL)$/.test(c.tagName.toUpperCase()));
          nested.forEach(c => c.remove());
          const sub = [];
          for (const sl of nested){
            const save = blocks.length;
            walk({ children: [sl] }, depth + 1);
            sub.push(...blocks.splice(save));
          }
          items.push({ text: inline(clone).trim(), sub });
        }
        if (items.length) emit(h.list(t === "OL", items, depth));
        continue;
      }
      if (t === "TABLE"){
        const trs = Array.from(el.querySelectorAll("tr")).filter(tr => tr.closest("table") === el);
        if (!trs.length) continue;
        const grid = trs.map(tr => Array.from(tr.children)
          .filter(c => /^T[DH]$/.test(c.tagName)).map(c => inline(c).trim()));
        emit(h.table(grid));
        continue;
      }
      if (["DIV","SECTION","ARTICLE","MAIN","BODY","HEADER","FOOTER","ASIDE","FIGURE","DL"].includes(t)){
        walk(el, depth);
        continue;
      }
      const s = inline(el).trim();
      if (s) emit(h.para(s));
    }
  };
  walk(doc.body, 0);
  const h1 = (doc.querySelector("h1") || {}).textContent || "";
  return { blocks, levels, title: h1.trim(), selfTitled: levels[0] === 1 };
}

export function htmlToLatex(html, title){
  const esc = s => String(s)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
  const SECT = ["section","subsection","subsubsection","paragraph","subparagraph","subparagraph"];
  const h = {
    text: esc, br: () => "\\\\\n",
    bold: s => `\\textbf{${s}}`, italic: s => `\\emph{${s}}`,
    under: s => `\\underline{${s}}`, strike: s => `\\sout{${s}}`,
    code: s => `\\texttt{${s}}`, sup: s => `\\textsuperscript{${s}}`, sub: s => `\\textsubscript{${s}}`,
    link: (href, t) => href ? `\\href{${String(href).replace(/([%#])/g, "\\$1")}}{${t}}` : t,
    image: (src, alt) => `\\emph{[image: ${esc(alt || src)}]}`,
    heading: (lvl, s) => `\\${SECT[Math.min(5, lvl - 1)]}{${s}}`,
    para: s => s, rule: () => "\\par\\noindent\\hrulefill\\par",
    pre: s => `\\begin{verbatim}\n${s}\n\\end{verbatim}`,
    quote: s => `\\begin{quote}\n${s}\n\\end{quote}`,
    list: (ordered, items) => {
      const env = ordered ? "enumerate" : "itemize";
      const body = items.map(it =>
        `  \\item ${it.text}` + (it.sub.length ? "\n" + it.sub.join("\n").replace(/^/gm, "  ") : "")).join("\n");
      return `\\begin{${env}}\n${body}\n\\end{${env}}`;
    },
    table: grid => {
      const cols = Math.max(...grid.map(r => r.length));
      const spec = "l".repeat(cols).split("").join("");
      const rows = grid.map(r => {
        const cells = Array.from({ length: cols }, (_, k) => r[k] || "");
        return "  " + cells.join(" & ") + " \\\\";
      });
      return `\\begin{center}\n\\begin{tabular}{${spec}}\n\\hline\n${rows[0]}\n\\hline\n` +
        rows.slice(1).join("\n") + `\n\\hline\n\\end{tabular}\n\\end{center}`;
    }
  };
  const r = walkRich(html, h);
  const blocks = r.blocks.slice();
  const docTitle = r.title || title || "Document";
  if (r.selfTitled && blocks[0] === `\\section{${docTitle}}`) blocks.shift();
  return `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage[normalem]{ulem}
\\title{${esc(docTitle)}}
\\author{}
\\date{}
\\begin{document}
\\maketitle

${blocks.join("\n\n")}

\\end{document}
`;
}

export function htmlToAsciidoc(html, title){
  const h = {
    text: s => s, br: () => " +\n",
    bold: s => `*${s}*`, italic: s => `_${s}_`, under: s => `[.underline]#${s}#`,
    strike: s => `[.line-through]#${s}#`, code: s => "`" + s + "`",
    sup: s => `^${s}^`, sub: s => `~${s}~`,
    link: (href, t) => href ? `${href}[${t}]` : t,
    image: (src, alt) => `image:${src}[${alt}]`,
    heading: (lvl, s) => "=".repeat(Math.min(6, lvl + 1)) + " " + s,
    para: s => s, rule: () => "'''",
    pre: s => "----\n" + s + "\n----",
    quote: s => "[quote]\n____\n" + s + "\n____",
    list: (ordered, items, depth) => items.map(it =>
      (ordered ? ".".repeat(depth + 1) : "*".repeat(depth + 1)) + " " + it.text +
      (it.sub.length ? "\n" + it.sub.join("\n") : "")).join("\n"),
    table: grid => {
      const cols = Math.max(...grid.map(r => r.length));
      const line = r => "| " + Array.from({ length: cols }, (_, k) => r[k] || "").join(" | ");
      return `[cols="${cols}",options="header"]\n|===\n${line(grid[0])}\n\n` +
        grid.slice(1).map(line).join("\n") + "\n|===";
    }
  };
  const r = walkRich(html, h);
  const blocks = r.blocks.slice();
  const docTitle = r.title || title || "";
  if (r.selfTitled && blocks[0] === `== ${docTitle}`) blocks.shift();
  const head = docTitle ? `= ${docTitle}\n:toc:\n\n` : "";
  return head + blocks.join("\n\n") + "\n";
}

export function htmlToRst(html, title){
  const under = (s, ch) => s + "\n" + ch.repeat(Math.max(3, [...s].length));
  const LEVEL = ["=", "-", "~", "^", '"', "'"];
  const h = {
    text: s => s.replace(/\*/g, "\\*").replace(/`/g, "\\`"),
    br: () => "\n| ",
    bold: s => `**${s}**`, italic: s => `*${s}*`, under: s => s,
    strike: s => s, code: s => "``" + s + "``",
    link: (href, t) => href ? `\`${t} <${href}>\`_` : t,
    image: (src, alt) => `.. image:: ${src}\n   :alt: ${alt}`,
    heading: (lvl, s) => under(s, LEVEL[Math.min(5, lvl - 1)]),
    para: s => s, rule: () => "----",
    pre: s => "::\n\n" + s.replace(/^/gm, "    "),
    quote: s => s.replace(/^/gm, "    "),
    list: (ordered, items, depth) => items.map(it =>
      "  ".repeat(depth) + (ordered ? "#. " : "- ") + it.text +
      (it.sub.length ? "\n\n" + it.sub.join("\n") : "")).join("\n"),
    table: grid => {
      const cols = Math.max(...grid.map(r => r.length));
      const norm = grid.map(r => Array.from({ length: cols }, (_, k) => (r[k] || "").replace(/\s+/g, " ").trim()));
      const w = Array.from({ length: cols }, (_, k) => Math.max(3, ...norm.map(r => r[k].length)));
      const sep = ch => "+" + w.map(x => ch.repeat(x + 2)).join("+") + "+";
      const line = r => "|" + r.map((c, k) => " " + c.padEnd(w[k]) + " ").join("|") + "|";
      const out = [sep("-"), line(norm[0]), sep("=")];
      for (const r of norm.slice(1)){ out.push(line(r)); out.push(sep("-")); }
      return out.join("\n");
    }
  };
  const r = walkRich(html, h);
  const head = (!r.selfTitled && title) ? under(title, "=") + "\n\n" : "";
  return head + r.blocks.join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function htmlToBbcode(html){
  const h = {
    text: s => s.replace(/\[/g, "&#91;").replace(/\]/g, "&#93;"),
    br: () => "\n",
    bold: s => `[b]${s}[/b]`, italic: s => `[i]${s}[/i]`, under: s => `[u]${s}[/u]`,
    strike: s => `[s]${s}[/s]`, code: s => `[font=monospace]${s}[/font]`,
    sup: s => `[sup]${s}[/sup]`, sub: s => `[sub]${s}[/sub]`,
    link: (href, t) => href ? `[url=${href}]${t}[/url]` : t,
    image: (src, alt) => `[img]${src}[/img]`,
    heading: (lvl, s) => `[size=${Math.max(3, 7 - lvl)}][b]${s}[/b][/size]`,
    para: s => s, rule: () => "[hr]",
    pre: s => `[code]${s}[/code]`,
    quote: s => `[quote]${s}[/quote]`,
    list: (ordered, items) => `[list${ordered ? "=1" : ""}]\n` +
      items.map(it => `[*]${it.text}` + (it.sub.length ? "\n" + it.sub.join("\n") : "")).join("\n") +
      `\n[/list]`,
    table: grid => `[table]\n` + grid.map((r, ri) => "[tr]" +
      r.map(c => ri === 0 ? `[th]${c}[/th]` : `[td]${c}[/td]`).join("") + "[/tr]").join("\n") + `\n[/table]`
  };
  return walkRich(html, h).blocks.join("\n\n") + "\n";
}
