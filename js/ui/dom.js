// Page helpers every tab shares: lookups, logs, saved options, file intake, result rows.

import { detectKind } from "../engine/detect.js";
import { escHtml, fmtBytes } from "../engine/util.js";

export const $ = id => document.getElementById(id);

export const store = {
  get(key, dflt){
    try {
      const v = localStorage.getItem("tools." + key);
      return v === null ? dflt : JSON.parse(v);
    } catch (e){ return dflt; }
  },
  set(key, value){
    try { localStorage.setItem("tools." + key, JSON.stringify(value)); } catch (e){ /* private mode */ }
  }
};

// Options are remembered between visits. A few describe one job, not a habit,
// so they start fresh every time.
const ONE_OFF = new Set(["combine", "combineName", "pdfName", "delimIn",
  "cropTop", "cropRight", "cropBottom", "cropLeft"]);
const savedOpts = store.get("opts", {});
for (const k of Object.keys(savedOpts)) if (ONE_OFF.has(k)) delete savedOpts[k];
let saveTimer = 0;
export const OPTS = new Proxy(savedOpts, {
  set(target, key, value){
    target[key] = value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const keep = {};
      for (const [k, v] of Object.entries(target)) if (!ONE_OFF.has(k)) keep[k] = v;
      store.set("opts", keep);
    }, 250);
    return true;
  }
});
export function opt(id, dflt){ return OPTS[id] === undefined ? dflt : OPTS[id]; }

// A log is a function. Lines are appended, never rebuilt, so a long run stays cheap.
export function makeLog(el, max = 600){
  let fresh = true;
  const log = (msg, cls) => {
    if (fresh){ el.textContent = ""; fresh = false; el.classList.remove("hide"); }
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = msg;
    el.appendChild(line);
    while (el.childElementCount > max) el.firstElementChild.remove();
    el.scrollTop = el.scrollHeight;
  };
  log.clear = () => { el.textContent = ""; fresh = false; };
  return log;
}

// Sniff each file's first bytes to name its format. All files are read at once.
export async function identify(files){
  return Promise.all(files.map(async file => {
    let kind = "bin";
    try {
      const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
      kind = await detectKind(file, head);
    } catch (e){ /* unreadable files stay "bin" */ }
    return { file, kind };
  }));
}

const THUMB = /^image\/(png|apng|jpeg|webp|gif|bmp|avif)$/;

export function showResult(box, name, bytes, mime){
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
  (box._urls || (box._urls = [])).push(url);
  const d = document.createElement("div");
  d.className = "r";
  const thumb = THUMB.test(mime || "") && bytes.length < 8 * 1024 * 1024
    ? `<img class="thumb" src="${url}" alt="" loading="lazy">` : "";
  d.innerHTML = `${thumb}<span class="nm">${escHtml(name)}</span><span class="sz">${fmtBytes(bytes.length)}</span>`;
  const a = document.createElement("a");
  a.className = "dl";
  a.href = url;
  a.download = name;
  a.textContent = "Download";
  d.appendChild(a);
  box.appendChild(d);
  return d;
}

export function clearResults(box){
  for (const u of box._urls || []) URL.revokeObjectURL(u);
  box._urls = [];
  box.innerHTML = "";
}

export function download(name, bytes, mime){
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Give every output a name no other output has: a.png, a-2.png, a-3.png.
export function uniqueNamer(){
  const used = new Map();
  return name => {
    const n = (used.get(name) || 0) + 1;
    used.set(name, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
  };
}

export async function saveToFolder(files){
  const dir = await window.showDirectoryPicker({ mode: "readwrite" });
  for (const f of files){
    const parts = f.name.split("/").filter(Boolean);
    let d = dir;
    for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(f.bytes);
    await w.close();
  }
  return dir.name;
}

// Lets one tab hand files to another. main.js fills in `send`.
export const bus = { send: async () => {} };
