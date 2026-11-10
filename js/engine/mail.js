// Mail messages, calendars and contacts.

import { findCols } from "./geo.js";
import { htmlDoc } from "./rich.js";
import { b64ToBytes, decodeText, escHtml, safeName } from "./util.js";

export function unfold(text){
  return text.replace(/\r\n?/g, "\n").replace(/\n[ \t]+/g, " ");
}

export function qpDecode(s){
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

export function binFromLatin(s){
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
  return u;
}

export function decodeMimeWords(s){
  return String(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc2, data) => {
    try {
      const bytes = enc2.toUpperCase() === "B" ? b64ToBytes(data) : binFromLatin(qpDecode(data.replace(/_/g, " ")));
      return new TextDecoder(cs.toLowerCase()).decode(bytes);
    } catch (e){ return m; }
  }).replace(/\?=\s+=\?/g, "");
}

export function parseEml(text){
  const src = unfold(text);
  const split = src.indexOf("\n\n");
  const headBlock = split < 0 ? src : src.slice(0, split);
  const rawBody = split < 0 ? "" : src.slice(split + 2);

  const headers = new Map();
  for (const line of headBlock.split("\n")){
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (m) headers.set(m[1].toLowerCase(), decodeMimeWords(m[2]));
  }
  const ctype = headers.get("content-type") || "text/plain";
  const attachments = [];
  let html = "", plain = "";

  const decodePart = (body, enc2, charset) => {
    let bytes;
    if (/base64/i.test(enc2)) bytes = b64ToBytes(body);
    else if (/quoted-printable/i.test(enc2)) bytes = binFromLatin(qpDecode(body));
    else bytes = binFromLatin(body);
    try { return { bytes, text: new TextDecoder(charset || "utf-8").decode(bytes) }; }
    catch (e){ return { bytes, text: decodeText(bytes) }; }
  };

  const walkPart = (rawHeaders, body) => {
    const h = new Map();
    for (const line of rawHeaders.split("\n")){
      const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (m) h.set(m[1].toLowerCase(), m[2]);
    }
    const ct = h.get("content-type") || "text/plain";
    const cte = h.get("content-transfer-encoding") || "7bit";
    const disp = h.get("content-disposition") || "";
    const charset = (ct.match(/charset="?([\w-]+)"?/i) || [])[1];
    const bmatch = ct.match(/boundary="?([^";]+)"?/i);

    if (/^multipart\//i.test(ct) && bmatch){
      splitMultipart(body, bmatch[1]).forEach(p => {
        const s = p.indexOf("\n\n");
        walkPart(s < 0 ? p : p.slice(0, s), s < 0 ? "" : p.slice(s + 2));
      });
      return;
    }
    const filename = decodeMimeWords((disp.match(/filename="?([^";]+)"?/i) || ct.match(/name="?([^";]+)"?/i) || [])[1] || "");
    const isAttach = /attachment/i.test(disp) || !/^(text\/(plain|html)|multipart\/)/i.test(ct);
    const d = decodePart(body, cte, charset);
    if (isAttach){
      const loc = (h.get("content-location") || "").trim();
      const cid = (h.get("content-id") || "").trim().replace(/^<|>$/g, "");
      const guess = filename || (loc ? decodeURIComponent(loc.split(/[?#]/)[0].split("/").pop()) : "") || "resource";
      attachments.push({
        name: safeName(guess), bytes: d.bytes, loc, cid,
        type: (ct.split(";")[0] || "").trim().toLowerCase()
      });
      return;
    }
    if (/^text\/html/i.test(ct)) html += d.text;
    else if (/^text\/plain/i.test(ct)) plain += d.text;
  };

  const bmatch = ctype.match(/boundary="?([^";]+)"?/i);
  if (/^multipart\//i.test(ctype) && bmatch){
    splitMultipart(rawBody, bmatch[1]).forEach(p => {
      const s = p.indexOf("\n\n");
      walkPart(s < 0 ? p : p.slice(0, s), s < 0 ? "" : p.slice(s + 2));
    });
  } else {
    walkPart(headBlock, rawBody);
  }
  return { headers, html, plain, attachments };
}

export function splitMultipart(body, boundary){
  const parts = [];
  const lines = body.split("\n");
  let cur = null;
  for (const ln of lines){
    const t = ln.trimEnd();
    if (t === "--" + boundary){ if (cur !== null) parts.push(cur.join("\n")); cur = []; continue; }
    if (t === "--" + boundary + "--"){ if (cur !== null) parts.push(cur.join("\n")); cur = null; break; }
    if (cur !== null) cur.push(ln);
  }
  if (cur !== null && cur.length) parts.push(cur.join("\n"));
  return parts;
}

export function emlToHtml(parsed){
  const h = parsed.headers;
  const rows = [];
  for (const k of ["from","to","cc","bcc","date","subject"]){
    if (h.get(k)) rows.push(`<tr><th>${k[0].toUpperCase() + k.slice(1)}</th><td>${escHtml(h.get(k))}</td></tr>`);
  }
  if (parsed.attachments.length){
    rows.push(`<tr><th>Attachments</th><td>${parsed.attachments.map(a => escHtml(a.name)).join(", ")}</td></tr>`);
  }
  let body;
  if (parsed.html){
    const d = new DOMParser().parseFromString(parsed.html, "text/html");
    d.querySelectorAll("script,style,head").forEach(n => n.remove());
    body = d.body ? d.body.innerHTML : escHtml(parsed.plain);
  } else {
    body = "<pre>" + escHtml(parsed.plain) + "</pre>";
  }
  return htmlDoc(h.get("subject") || "Message",
    `<h1>${escHtml(h.get("subject") || "(no subject)")}</h1>\n<table>${rows.join("")}</table>\n<hr>\n${body}`);
}

export function parseIcs(text){
  const lines = unfold(text).split("\n");
  const events = [];
  let cur = null;
  for (const ln of lines){
    const t = ln.trim();
    if (/^BEGIN:V(EVENT|TODO)$/i.test(t)){ cur = {}; continue; }
    if (/^END:V(EVENT|TODO)$/i.test(t)){ if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const m = t.match(/^([A-Za-z-]+)(;[^:]*)?:(.*)$/);
    if (!m) continue;
    const key = m[1].toUpperCase();
    let v = m[3].replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
    if (/^DT/.test(key)) v = fmtIcsDate(v);
    cur[key] = cur[key] ? cur[key] + "; " + v : v;
  }
  const cols = ["SUMMARY","DTSTART","DTEND","LOCATION","ORGANIZER","ATTENDEE","STATUS","DESCRIPTION","UID"];
  const used = cols.filter(c => events.some(e => e[c]));
  const extra = [];
  for (const e of events) for (const k of Object.keys(e)) if (!used.includes(k) && !extra.includes(k) && k !== "UID") extra.push(k);
  const headers = [...used, ...extra.slice(0, 6)];
  return [{ name: "Events", headers: headers.map(h => h.toLowerCase()), rows: events.map(e => headers.map(h => e[h] || "")) }];
}

export function fmtIcsDate(v){
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return v;
  const [, y, mo, d, hh, mm, ss, z] = m;
  return hh ? `${y}-${mo}-${d} ${hh}:${mm}:${ss}${z ? " UTC" : ""}` : `${y}-${mo}-${d}`;
}

export function parseVcf(text){
  const cards = [];
  let cur = null;
  for (const ln of unfold(text).split("\n")){
    const t = ln.trim();
    if (/^BEGIN:VCARD$/i.test(t)){ cur = {}; continue; }
    if (/^END:VCARD$/i.test(t)){ if (cur) cards.push(cur); cur = null; continue; }
    if (!cur) continue;
    const m = t.match(/^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    let key = m[1].toUpperCase();
    const params = (m[2] || "").toUpperCase();
    let v = m[3].replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";");
    if (key === "N") v = v.split(";").filter(Boolean).reverse().join(" ");
    if (key === "ADR") v = v.split(";").filter(Boolean).join(", ");
    const type = (params.match(/TYPE=([A-Z,]+)/) || [])[1];
    if (type && (key === "TEL" || key === "EMAIL" || key === "ADR")) key = key + " (" + type.split(",")[0].toLowerCase() + ")";
    cur[key] = cur[key] ? cur[key] + "; " + v : v;
  }
  const headers = [];
  for (const c of cards) for (const k of Object.keys(c)) if (!headers.includes(k) && !/^(VERSION|PRODID|PHOTO|UID|REV)$/i.test(k)) headers.push(k);
  const order = ["FN","N","ORG","TITLE"];
  headers.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return [{ name: "Contacts", headers: headers.map(h => h.toLowerCase()), rows: cards.map(c => headers.map(h => c[h] || "")) }];
}

export function icsFold(line){
  if (line.length <= 73) return line;
  const parts = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72){ parts.push(" " + rest.slice(0, 72)); rest = rest.slice(72); }
  if (rest) parts.push(" " + rest);
  return parts.join("\r\n");
}

export function icsDate(v){
  const s = String(v || "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return m[4] ? `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6] || "00"}Z` : `${m[1]}${m[2]}${m[3]}`;
  if (/^\d{8}(T\d{6}Z?)?$/.test(s)) return s;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "") : "";
}

export function sheetsToIcs(sheets){
  const sh = sheets[0];
  const c = findCols(sh, {
    summary: ["summary","title","subject","event","name"],
    dtstart: ["dtstart","start","starttime","startdate","begin","date","when"],
    dtend: ["dtend","end","endtime","enddate","finish"],
    location: ["location","place","where","venue","room"],
    description: ["description","desc","notes","note","details"],
    uid: ["uid","id","identifier"]
  });
  if (c.summary === undefined && c.dtstart === undefined) throw new Error("needs a summary or start column");
  const esc = s => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//tools.katr.es//EN", "CALSCALE:GREGORIAN"];
  let n = 0;
  for (const r of sh.rows){
    const start = c.dtstart !== undefined ? icsDate(r[c.dtstart]) : "";
    const summary = c.summary !== undefined ? r[c.summary] : "";
    if (!start && !summary) continue;
    n++;
    out.push("BEGIN:VEVENT");
    out.push(`UID:${esc(c.uid !== undefined && r[c.uid] ? r[c.uid] : `${Date.now()}-${n}@convert`)}`);
    out.push(`DTSTAMP:${icsDate(new Date().toISOString())}`);
    if (start) out.push(`${start.length > 8 ? "DTSTART" : "DTSTART;VALUE=DATE"}:${start}`);
    const end = c.dtend !== undefined ? icsDate(r[c.dtend]) : "";
    if (end) out.push(`${end.length > 8 ? "DTEND" : "DTEND;VALUE=DATE"}:${end}`);
    if (summary) out.push(`SUMMARY:${esc(summary)}`);
    if (c.location !== undefined && r[c.location]) out.push(`LOCATION:${esc(r[c.location])}`);
    if (c.description !== undefined && r[c.description]) out.push(`DESCRIPTION:${esc(r[c.description])}`);
    out.push("END:VEVENT");
  }
  if (!n) throw new Error("no rows produced an event");
  out.push("END:VCALENDAR");
  return out.map(icsFold).join("\r\n") + "\r\n";
}

export function sheetsToVcf(sheets){
  const sh = sheets[0];
  const c = findCols(sh, {
    fn: ["fn","name","fullname","displayname","contact"],
    first: ["first","firstname","givenname","given"],
    last: ["last","lastname","surname","familyname","family"],
    email: ["email","mail","emailaddress","workemail"],
    tel: ["tel","phone","telephone","mobile","cell","phonenumber"],
    org: ["org","organisation","organization","company","employer"],
    title: ["title","jobtitle","role","position"],
    adr: ["adr","address","street","location"],
    url: ["url","website","web","homepage"],
    note: ["note","notes","comment","description"]
  });
  if (c.fn === undefined && c.first === undefined && c.email === undefined) throw new Error("needs a name or email column");
  const esc = s => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const out = [];
  let n = 0;
  for (const r of sh.rows){
    const first = c.first !== undefined ? r[c.first] || "" : "";
    const last = c.last !== undefined ? r[c.last] || "" : "";
    const fn = (c.fn !== undefined && r[c.fn]) || [first, last].filter(Boolean).join(" ") || (c.email !== undefined ? r[c.email] : "");
    if (!fn) continue;
    n++;
    out.push("BEGIN:VCARD", "VERSION:3.0", `FN:${esc(fn)}`);
    if (last || first) out.push(`N:${esc(last)};${esc(first)};;;`);
    else out.push(`N:${esc(fn)};;;;`);
    if (c.org !== undefined && r[c.org]) out.push(`ORG:${esc(r[c.org])}`);
    if (c.title !== undefined && r[c.title]) out.push(`TITLE:${esc(r[c.title])}`);
    if (c.email !== undefined && r[c.email]) out.push(`EMAIL;TYPE=INTERNET:${esc(r[c.email])}`);
    if (c.tel !== undefined && r[c.tel]) out.push(`TEL;TYPE=CELL:${esc(r[c.tel])}`);
    if (c.adr !== undefined && r[c.adr]) out.push(`ADR;TYPE=HOME:;;${esc(r[c.adr])};;;;`);
    if (c.url !== undefined && r[c.url]) out.push(`URL:${esc(r[c.url])}`);
    if (c.note !== undefined && r[c.note]) out.push(`NOTE:${esc(r[c.note])}`);
    out.push("END:VCARD");
  }
  if (!n) throw new Error("no rows produced a contact");
  return out.join("\r\n") + "\r\n";
}
