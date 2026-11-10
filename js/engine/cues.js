// Subtitle and caption formats.

import { htmlDoc } from "./rich.js";
import { parseXml } from "./tree.js";
import { escHtml, xmlEsc } from "./util.js";

export function tc(ms, comma){
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const f = Math.floor(ms % 1000);
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}${comma ? "," : "."}${p(f, 3)}`;
}

export function parseTc(s){
  const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + parseInt(String(m[4]).padEnd(3, "0"), 10);
}

export function parseCues(text, kind){
  const src = text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
  const cues = [];
  const blocks = src.split(/\n{2,}/);
  for (let b of blocks){
    b = b.trim();
    if (!b || /^WEBVTT/i.test(b) || /^(NOTE|STYLE|REGION)\b/i.test(b)) continue;
    const lines = b.split("\n");
    let i = 0, id = "";
    if (!/-->/.test(lines[0]) && lines[1] && /-->/.test(lines[1])){ id = lines[0].trim(); i = 1; }
    if (!lines[i] || !/-->/.test(lines[i])) continue;
    const m = lines[i].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    cues.push({ id, start: parseTc(m[1]), end: parseTc(m[2]), text: lines.slice(i + 1).join("\n").trim() });
  }
  return cues;
}

export function cuesToSrt(cues){
  return cues.map((c, i) => `${i + 1}\n${tc(c.start, true)} --> ${tc(c.end, true)}\n${c.text}`).join("\n\n") + "\n";
}

export function cuesToVtt(cues){
  return "WEBVTT\n\n" + cues.map(c => `${tc(c.start)} --> ${tc(c.end)}\n${c.text}`).join("\n\n") + "\n";
}

export function cuesToTable(cues){
  return [{ name: "Cues", headers: ["index","start","end","text"],
    rows: cues.map((c, i) => [String(i + 1), tc(c.start, true), tc(c.end, true), c.text.replace(/\n/g, " ")]) }];
}

export function cuesToText(cues){
  return cues.map(c => c.text.replace(/<[^>]+>/g, "")).join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function cueTime(s){
  const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const frac = m[4] ? +(m[4] + "00").slice(0, 3) : 0;
  return ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + frac;
}

export function fmtTime(ms, sep, hours2){
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const f = Math.floor(ms % 1000);
  const hh = hours2 ? String(h).padStart(2, "0") : String(h);
  return `${hh}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(f).padStart(3, "0")}`;
}

export function fmtCenti(ms){
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const cs = Math.round((ms % 1000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(Math.min(99, cs)).padStart(2, "0")}`;
}

export function parseAss(text){
  const cues = [];
  let fields = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")){
    const line = raw.trim();
    if (/^Format\s*:/i.test(line)){
      fields = line.slice(line.indexOf(":") + 1).split(",").map(s => s.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line)) continue;
    const body = line.slice(line.indexOf(":") + 1);
    const cols = fields || ["layer","start","end","style","name","marginl","marginr","marginv","effect","text"];
    const textAt = Math.max(0, cols.indexOf("text"));
    const parts = body.split(",");
    const head = parts.slice(0, textAt).map(s => s.trim());
    const payload = parts.slice(textAt).join(",");
    const get = n => { const i = cols.indexOf(n); return i >= 0 && i < head.length ? head[i] : ""; };
    const start = cueTime(get("start")), end = cueTime(get("end"));
    if (start === null || end === null) continue;
    const body2 = payload
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ")
      .trim();
    if (body2) cues.push({ start, end, text: body2, style: get("style") || "" });
  }
  if (!cues.length) throw new Error("no Dialogue lines found");
  return cues;
}

export function cuesToAss(cues, opts){
  const head = `[Script Info]
; Written by convert.html
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${opts.assFont || "Arial"},${opts.assSize || 54},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  const lines = cues.map(c => {
    const body = String(c.text || "").replace(/\r?\n/g, "\\N").replace(/\{/g, "(").replace(/\}/g, ")");
    return `Dialogue: 0,${fmtCenti(c.start)},${fmtCenti(c.end)},Default,,0,0,0,,${body}`;
  });
  return head + "\n" + lines.join("\n") + "\n";
}

export function parseSub(text, fps){
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let rate = +fps || 0;
  const cues = [];
  for (const raw of lines){
    const m = raw.trim().match(/^\{(\d+)\}\{(\d+)\}(.*)$/);
    if (!m) continue;
    let body = m[3];
    if (!rate && +m[1] <= 1 && /^\d{2}(\.\d+)?$/.test(body.trim())){
      rate = parseFloat(body.trim());
      continue;
    }
    if (!rate) rate = 23.976;
    body = body.replace(/\{[^}]*\}/g, "").replace(/\|/g, "\n").trim();
    if (body) cues.push({ start: +m[1] / rate * 1000, end: +m[2] / rate * 1000, text: body });
  }
  if (!cues.length) throw new Error("no frame timed lines found");
  return cues;
}

export function cuesToSub(cues, fps){
  const rate = +fps || 23.976;
  return cues.map(c =>
    `{${Math.round(c.start / 1000 * rate)}}{${Math.round(c.end / 1000 * rate)}}` +
    String(c.text || "").replace(/\r?\n/g, "|")).join("\n") + "\n";
}

export function parseSbv(text){
  const cues = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const b of blocks){
    const lines = b.split("\n").filter(l => l.trim());
    if (lines.length < 2) continue;
    const m = lines[0].match(/^\s*([\d:.,]+)\s*,\s*([\d:.,]+)\s*$/);
    if (!m) continue;
    const start = cueTime(m[1]), end = cueTime(m[2]);
    if (start === null || end === null) continue;
    cues.push({ start, end, text: lines.slice(1).join("\n").trim() });
  }
  if (!cues.length) throw new Error("no timed blocks found");
  return cues;
}

export function cuesToSbv(cues){
  return cues.map(c =>
    `${fmtTime(c.start, ".", false)},${fmtTime(c.end, ".", false)}\n${c.text}`).join("\n\n") + "\n";
}

export function parseLrc(text){
  const rows = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")){
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (!body) continue;
    for (const s of stamps){
      const frac = s[3] ? +(s[3] + "00").slice(0, 3) : 0;
      rows.push({ start: ((+s[1]) * 60 + (+s[2])) * 1000 + frac, text: body });
    }
  }
  if (!rows.length) throw new Error("no timestamped lines found");
  rows.sort((a, b) => a.start - b.start);
  return rows.map((r, i) => ({
    start: r.start,
    end: i + 1 < rows.length ? rows[i + 1].start : r.start + 4000,
    text: r.text
  }));
}

export function cuesToLrc(cues){
  const stamp = ms => {
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    const cs = Math.round((ms % 1000) / 10);
    return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(Math.min(99, cs)).padStart(2, "0")}]`;
  };
  return cues.map(c => stamp(c.start) + String(c.text || "").replace(/\r?\n/g, " ")).join("\n") + "\n";
}

export function parseTtml(text){
  const doc = parseXml(text, "ttml");
  const ps = Array.from(doc.getElementsByTagName("p"))
    .concat(Array.from(doc.getElementsByTagName("tt:p")));
  const tick = s => {
    const v = String(s || "").trim();
    if (!v) return null;
    const clock = cueTime(v);
    if (clock !== null) return clock;
    const off = v.match(/^([\d.]+)(h|m|s|ms|f|t)$/);
    if (!off) return null;
    const n = parseFloat(off[1]);
    return off[2] === "h" ? n * 3600000 : off[2] === "m" ? n * 60000
      : off[2] === "ms" ? n : off[2] === "f" ? n / 25 * 1000 : n * 1000;
  };
  const flatten = el => {
    let out = "";
    for (const c of el.childNodes){
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1){
        if (/^(tt:)?br$/i.test(c.tagName)) out += "\n";
        else out += flatten(c);
      }
    }
    return out;
  };
  const cues = [];
  for (const p of ps){
    const start = tick(p.getAttribute("begin"));
    let end = tick(p.getAttribute("end"));
    const dur = tick(p.getAttribute("dur"));
    if (start === null) continue;
    if (end === null && dur !== null) end = start + dur;
    if (end === null) end = start + 3000;
    const body = flatten(p).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
    if (body) cues.push({ start, end, text: body });
  }
  if (!cues.length) throw new Error("no timed p elements found");
  return cues;
}

export function cuesToTtml(cues, title){
  const body = cues.map(c =>
    `      <p begin="${fmtTime(c.start, ".", true)}" end="${fmtTime(c.end, ".", true)}">` +
    xmlEsc(String(c.text || "")).replace(/\r?\n/g, "<br/>") + "</p>").join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <head><metadata xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><ttm:title>${xmlEsc(title || "Captions")}</ttm:title></metadata></head>
  <body>
    <div>
${body}
    </div>
  </body>
</tt>
`;
}

export function cuesToRich(cues, title){
  const rows = cues.map(c =>
    `<tr><td>${fmtTime(c.start, ".", true)}</td><td>${fmtTime(c.end, ".", true)}</td><td>${escHtml(String(c.text || "")).replace(/\r?\n/g, "<br>")}</td></tr>`);
  return htmlDoc(title || "Captions",
    `<h1>${escHtml(title || "Captions")}</h1>
<table><thead><tr><th>start</th><th>end</th><th>text</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table>`);
}
