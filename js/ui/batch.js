// Batch tab: resize, compress and rename many images in one run.

import { zipWrite } from "../engine/containers.js";
import { KINDS, hubsOf } from "../engine/registry.js";
import { baseName, escHtml, fmtBytes, safeName } from "../engine/util.js";
import { pool } from "../worker/pool.js";
import {
  $, clearResults, download, identify, makeLog, saveToFolder, showResult, store, uniqueNamer
} from "./dom.js";

const bState = { items: [], results: [], running: false, cancel: false };
const bLog = makeLog($("bLog"));

// These need the document to decode, so they are handled on the page, one at a time.
const PAGE_KINDS = new Set(["svg", "eps", "heic"]);

// The image code is only fetched for the page when a file cannot go to a worker.
let opsPromise = null;
const ops = () => opsPromise || (opsPromise = import("../engine/imageops.js"));

/* ---- settings ----------------------------------------------------------- */

const FIELDS = {
  mode: "bMode", size: "bSize", width: "bWidth", height: "bHeight", percent: "bPercent",
  noEnlarge: "bNoEnlarge", format: "bFormat", quality: "bQuality", targetKb: "bTarget",
  background: "bBg", pattern: "bPattern", start: "bStart", clean: "bClean"
};

function settings(){
  const s = {};
  for (const [key, id] of Object.entries(FIELDS)){
    const el = $(id);
    s[key] = el.type === "checkbox" ? el.checked : el.type === "number" || el.type === "range" ? +el.value : el.value;
  }
  return s;
}

function restore(){
  const saved = store.get("batch", null);
  if (!saved) return;
  for (const [key, id] of Object.entries(FIELDS)){
    if (saved[key] === undefined) continue;
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!saved[key];
    else el.value = saved[key];
  }
}

const NEEDS = {
  keep: [], long: ["bSizeRow"], width: ["bWidthRow"], height: ["bHeightRow"], percent: ["bPercentRow"],
  box: ["bWidthRow", "bHeightRow"], fill: ["bWidthRow", "bHeightRow"]
};
function syncForm(){
  const s = settings();
  const show = new Set(NEEDS[s.mode] || []);
  for (const id of ["bSizeRow", "bWidthRow", "bHeightRow", "bPercentRow"]) $(id).classList.toggle("hide", !show.has(id));
  $("bEnlargeRow").classList.toggle("hide", s.mode === "keep");
  $("bQuality").nextElementSibling.textContent = Math.round(s.quality * 100);
  // quality means nothing for PNG, and only JPEG needs a background
  $("bQuality").closest(".o").classList.toggle("hide", s.format === "png");
  $("bBg").closest(".o").classList.toggle("hide", s.format === "png" || s.format === "webp");
  const first = bState.items[0];
  $("bPreview").textContent = first
    ? `${first.file.name} becomes ${nameFor(first, 0, s, null)}`
    : "";
}

/* ---- names -------------------------------------------------------------- */

function today(){
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// r is the finished result, or null while the name is only a preview.
function nameFor(it, index, s, r){
  const total = bState.items.length;
  const pad = String(Math.max(0, s.start) + Math.max(0, total - 1)).length;
  const fmt = s.format === "keep" ? (["jpeg", "png", "webp"].includes(it.kind) ? it.kind : "jpeg") : s.format;
  const ext = r ? r.ext : (fmt === "jpeg" ? "jpg" : fmt);
  // tidy the words first, then drop in the numbers, so a cleaned name keeps them intact
  let name = (s.pattern || "{name}").replace(/\{name\}/gi, baseName(it.file.name));
  if (s.clean) name = name.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9.\-{}]+/g, "").replace(/-{2,}/g, "-");
  name = name
    .replace(/\{n\}/gi, String(Math.max(0, s.start) + index).padStart(pad, "0"))
    .replace(/\{w\}/gi, r ? r.w : "W")
    .replace(/\{h\}/gi, r ? r.h : "H")
    .replace(/\{date\}/gi, today());
  return (safeName(name) || "image") + "." + ext;
}

/* ---- files -------------------------------------------------------------- */

const ST_LABEL = { ok: "done", fail: "failed", busy: "working" };

function setStatus(it, status, gain){
  const st = it.row.querySelector(".st");
  st.className = "st" + (status ? " " + status : "");
  st.textContent = status ? ST_LABEL[status] : "";
  it.row.querySelector(".gain").textContent = gain || "";
}

function refresh(){
  const n = bState.items.length;
  $("bSum").classList.toggle("hide", !n);
  $("bPanelJob").classList.toggle("off", !n);
  $("bPanelRun").classList.toggle("off", !n);
  if (n){
    const bytes = bState.items.reduce((a, it) => a + it.file.size, 0);
    $("bSumText").textContent = `${n} image${n === 1 ? "" : "s"}, ${fmtBytes(bytes)}`;
  }
  syncForm();
}

export async function addFiles(files){
  if (!files.length) return;
  const found = await identify(files);
  let skipped = 0;
  for (const it of found){
    if (!hubsOf(it.kind).includes("raster")){ skipped++; continue; }
    const d = document.createElement("div");
    d.className = "f";
    d.innerHTML = `<span class="kd">${escHtml(KINDS[it.kind].label)}</span>
      <span class="nm">${escHtml(it.file.name)}</span>
      <span class="gain"></span><span class="st"></span>
      <span class="sz">${fmtBytes(it.file.size)}</span>
      <button class="x" title="Remove" aria-label="Remove ${escHtml(it.file.name)}">&times;</button>`;
    d.querySelector(".x").onclick = () => {
      if (bState.running) return;
      bState.items = bState.items.filter(x => x !== it);
      d.remove();
      refresh();
    };
    it.row = d;
    $("bList").appendChild(d);
    bState.items.push(it);
  }
  if (skipped) bLog(`skip  ${skipped} file${skipped === 1 ? " is" : "s are"} not images`, "w");
  refresh();
  pool.warm(pool.size);
}

/* ---- run ---------------------------------------------------------------- */

function tally(c){
  $("bDone").textContent = c.done;
  $("bIn").textContent = fmtBytes(c.read);
  $("bOut").textContent = fmtBytes(c.written);
  const pct = c.read ? Math.round((1 - c.written / c.read) * 100) : 0;
  $("bSaved").textContent = pct + "%";
  $("bErr").textContent = c.err;
}

function finish(){
  bState.running = false;
  $("bGo").disabled = false;
  $("bStop").disabled = true;
  const many = bState.results.length >= 2;
  $("bZip").classList.toggle("hide", !many);
  $("bDir").classList.toggle("hide", !many || !("showDirectoryPicker" in window));
}

async function run(){
  if (bState.running || !bState.items.length) return;
  bState.running = true;
  bState.cancel = false;
  bState.results = [];
  $("bGo").disabled = true;
  $("bStop").disabled = false;
  $("bZip").classList.add("hide");
  $("bDir").classList.add("hide");
  clearResults($("bResults"));
  bLog.clear();
  $("bBar").style.width = "0%";
  $("bPanelRun").classList.remove("idle");

  const s = settings();
  const items = bState.items.slice();
  const total = items.length;
  const c = { done: 0, read: 0, written: 0, err: 0 };
  tally(c);
  for (const it of items) setStatus(it, "");
  const namer = uniqueNamer();
  const notify = m => bLog(String(m).trim(), "d");
  const t0 = performance.now();
  bLog(`Processing ${total} image${total === 1 ? "" : "s"}, ${pool.ok ? pool.size : 1} at a time.`);

  let pageLine = Promise.resolve();
  const onPage = (it) => {
    const p = pageLine.then(async () => {
      if (bState.cancel){ const e = new Error("stopped"); e.name = "AbortError"; throw e; }
      const { processImage } = await ops();
      return processImage(it.file, it.kind, s, { allowModules: true, notify });
    });
    pageLine = p.catch(() => {});
    return p;
  };

  const one = async (it, index) => {
    setStatus(it, "busy");
    try {
      let r;
      if (pool.ok && !PAGE_KINDS.has(it.kind)){
        try {
          r = await pool.run("batch", { file: it.file, kind: it.kind, settings: s }, { onLog: notify });
        } catch (e){
          if (!e.fallback) throw e;
          r = await onPage(it);
        }
      } else r = await onPage(it);

      const name = namer(nameFor(it, index, s, r));
      bState.results.push({ name, bytes: r.bytes, mime: r.mime });
      showResult($("bResults"), name, r.bytes, r.mime);
      c.done++;
      c.read += it.file.size;
      c.written += r.bytes.length;
      const pct = it.file.size ? Math.round((1 - r.bytes.length / it.file.size) * 100) : 0;
      const change = pct > 0 ? `${pct}% smaller` : pct < 0 ? `${-pct}% larger` : "same size";
      setStatus(it, "ok", `${r.w} by ${r.h}, ${change}`);
      bLog(`ok    ${name}  ${r.w} by ${r.h}  ${fmtBytes(r.bytes.length)}` +
        (r.missed ? "  could not get under the size limit" : ""), r.missed ? "w" : "g");
    } catch (e){
      if (e.name === "AbortError"){ setStatus(it, ""); return; }
      c.err++;
      setStatus(it, "fail");
      bLog(`fail  ${it.file.name}  ${e.message}`, "e");
    }
  };

  let next = 0, finished = 0;
  const lane = async () => {
    while (next < total && !bState.cancel){
      const index = next++;
      await one(items[index], index);
      finished++;
      $("bBar").style.width = (finished / total * 100) + "%";
      tally(c);
    }
  };
  await Promise.all(Array.from({ length: Math.min(total, pool.ok ? pool.size : 1) }, lane));

  $("bBar").style.width = "100%";
  const secs = (performance.now() - t0) / 1000;
  const pct = c.read ? Math.round((1 - c.written / c.read) * 100) : 0;
  bLog(bState.cancel
    ? `Stopped. ${c.done} of ${total} done.`
    : `Done in ${secs < 60 ? secs.toFixed(1) + "s" : (secs / 60).toFixed(1) + " min"}. ` +
      `${fmtBytes(c.read)} in, ${fmtBytes(c.written)} out` + (pct > 0 ? `, ${pct}% smaller.` : "."),
    bState.cancel ? "w" : "g");
  finish();
}

/* ---- wiring ------------------------------------------------------------- */

restore();
for (const id of Object.values(FIELDS)){
  const el = $(id);
  const on = () => { syncForm(); store.set("batch", settings()); };
  el.addEventListener("input", on);
  el.addEventListener("change", on);
}
syncForm();

$("bClear").onclick = () => {
  if (bState.running) return;
  bState.items = [];
  $("bList").innerHTML = "";
  refresh();
};
$("bGo").onclick = () => run().catch(e => { bLog("Fatal: " + (e.stack || e.message), "e"); finish(); });
$("bStop").onclick = () => {
  if (!bState.running) return;
  bState.cancel = true;
  pool.cancel();
  bLog("Stopping.", "w");
};
$("bZip").onclick = async () => {
  download("images.zip", await zipWrite(bState.results.map(r => ({ name: r.name, bytes: r.bytes }))), "application/zip");
};
$("bDir").onclick = async () => {
  try {
    const dir = await saveToFolder(bState.results);
    bLog(`Saved ${bState.results.length} files to ${dir}/`, "g");
  } catch (e){
    if (e.name !== "AbortError") bLog("Save failed: " + e.message, "e");
  }
};
