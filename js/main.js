// Page shell: tabs, file intake, and loading each tool only when it is opened.

import { $, bus } from "./ui/dom.js";

const APPS = ["convert", "images", "batch", "pdf", "preview"];
const TITLE = { convert: "Convert", images: "Images", batch: "Batch", pdf: "PDF", preview: "Preview" };
const LOADERS = {
  convert: () => import("./ui/convert.js"),
  images:  () => import("./ui/images.js"),
  batch:   () => import("./ui/batch.js"),
  pdf:     () => import("./ui/pdf.js"),
  preview: () => import("./ui/preview.js")
};

const loaded = {};
let active = "convert";

function warn(text){
  const b = $("unsupported");
  b.className = "warn";
  b.textContent = text;
}

function load(name){
  if (!loaded[name]){
    loaded[name] = LOADERS[name]().catch(e => {
      delete loaded[name];
      console.error(e);
      warn(`The ${TITLE[name]} tool could not load. Check the connection and reload the page.`);
      throw e;
    });
  }
  return loaded[name];
}

function showApp(name){
  if (!APPS.includes(name)) name = "convert";
  active = name;
  for (const a of APPS){
    $("app-" + a).classList.toggle("hide", a !== name);
    const tab = document.querySelector(`.app[data-app="${a}"]`);
    tab.classList.toggle("on", a === name);
    tab.setAttribute("aria-selected", a === name ? "true" : "false");
    tab.tabIndex = a === name ? 0 : -1;
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  document.title = TITLE[name];
  load(name).then(m => { if (m.onShow && active === name) m.onShow(); }).catch(() => {});
}

async function deliver(app, files){
  files = files.filter(f => f && (f.size > 0 || f.type));
  if (!files.length) return;
  try {
    const m = await load(app);
    await m.addFiles(files);
  } catch (e){
    console.error("file handling failed:", e);
  }
}

bus.send = (app, files) => { showApp(app); return deliver(app, files); };

/* ---- tabs --------------------------------------------------------------- */

for (const tab of document.querySelectorAll(".app")){
  tab.onclick = () => showApp(tab.dataset.app);
  // start fetching a tool as soon as the pointer heads for its tab
  tab.addEventListener("pointerenter", () => load(tab.dataset.app).catch(() => {}), { once: true });
}
document.querySelector(".apps").addEventListener("keydown", e => {
  if (!/^Arrow(Left|Right)$/.test(e.key)) return;
  const tabs = [...document.querySelectorAll(".app")];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  next.focus();
  showApp(next.dataset.app);
});
addEventListener("hashchange", () => showApp(location.hash.slice(1)));

/* ---- file intake: click, drop anywhere, drop a folder, paste ------------ */

for (const zone of document.querySelectorAll(".drop")){
  const input = $(zone.dataset.input);
  zone.tabIndex = 0;
  zone.setAttribute("role", "button");
  zone.onclick = () => input.click();
  zone.onkeydown = e => {
    if (e.key === "Enter" || e.key === " "){ e.preventDefault(); input.click(); }
  };
  input.onchange = () => {
    const files = Array.from(input.files);
    input.value = "";
    deliver(zone.dataset.app, files);
  };
}

const hasFiles = e => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");

// Walk dropped folders. Entries must be read before the event handler returns.
async function droppedFiles(dt){
  const entries = [];
  for (const item of dt.items || []){
    if (item.kind !== "file") continue;
    const en = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    entries.push(en || item.getAsFile());
  }
  if (!entries.length) return Array.from(dt.files || []);
  const out = [];
  const LIMIT = 5000;
  const walk = async en => {
    if (!en || out.length >= LIMIT) return;
    if (en instanceof File){ out.push(en); return; }
    if (en.isFile){
      const f = await new Promise(res => en.file(res, () => res(null)));
      if (f && !/^\.|^Thumbs\.db$|^desktop\.ini$/i.test(f.name)) out.push(f);
      return;
    }
    if (!en.isDirectory) return;
    const reader = en.createReader();
    for (;;){
      const batch = await new Promise(res => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      batch.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const child of batch) await walk(child);
    }
  };
  for (const en of entries) await walk(en);
  return out;
}

let dragDepth = 0;
const dragEnd = () => { dragDepth = 0; document.body.classList.remove("dragging"); };
addEventListener("dragenter", e => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
addEventListener("dragleave", e => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) dragEnd();
});
addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragEnd();
  const zone = e.target.closest ? e.target.closest(".drop") : null;
  const app = zone ? zone.dataset.app : active;
  droppedFiles(e.dataTransfer).then(files => deliver(app, files));
});

addEventListener("paste", e => {
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (!files.length) return;
  e.preventDefault();
  // a pasted screenshot arrives as "image.png" every time, so stamp it
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  deliver(active, files.map(f => /^image\.\w+$/.test(f.name)
    ? new File([f], f.name.replace("image", "pasted-" + stamp), { type: f.type }) : f));
});

/* ---- start -------------------------------------------------------------- */

(function support(){
  const miss = [];
  if (typeof DecompressionStream === "undefined") miss.push("DecompressionStream");
  if (typeof OffscreenCanvas === "undefined") miss.push("OffscreenCanvas");
  if (miss.length) warn("This browser is missing " + miss.join(" and ") + ". Use a recent Chrome, Edge or Arc on desktop.");
})();

showApp(location.hash.slice(1) || "convert");

// Once the page is quiet, fetch the converter so the first run starts at once.
const whenIdle = window.requestIdleCallback || (fn => setTimeout(fn, 1200));
whenIdle(() => { import("./engine/convert.js").catch(() => {}); }, { timeout: 4000 });
