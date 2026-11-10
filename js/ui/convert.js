// Convert tab: pick files, pick a target, run.

import { MAX_DIM } from "../engine/canvas.js";
import { zipWrite } from "../engine/containers.js";
import { needsModuleFor } from "../engine/modules.js";
import { GROUP_ORDER, KINDS, TARGETS, VECTOR_KINDS, canCombine, hubsOf, routeFor } from "../engine/registry.js";
import { baseName, escHtml, fmtBytes, safeName } from "../engine/util.js";
import { pool } from "../worker/pool.js";
import {
  $, OPTS, clearResults, download, identify, makeLog, opt, saveToFolder, showResult, store, uniqueNamer
} from "./dom.js";

// The engine is about thirty modules. It is fetched once, the first time it is needed.
let enginePromise = null;
const engine = () => enginePromise || (enginePromise = import("../engine/convert.js"));

const state = { items: [], target: null, results: [], running: false, cancel: false, tquery: "", tshowAll: false };
const counts = { done: 0, out: 0, bytes: 0, skip: 0, err: 0 };
const log = makeLog($("log"));
let nextId = 1;

function bump(){
  $("sDone").textContent = counts.done;
  $("sOut").textContent = counts.out;
  $("sBytes").textContent = fmtBytes(counts.bytes);
  $("sSkip").textContent = counts.skip;
  $("sErr").textContent = counts.err;
}

/* ---- files -------------------------------------------------------------- */

const ST_LABEL = { ok: "done", fail: "failed", skip: "skipped", busy: "working" };

export async function addFiles(files){
  if (!files.length) return;
  const found = await identify(files);
  const list = $("fileList");
  for (const it of found){
    it.id = nextId++;
    it.status = "";
    it.row = fileRow(it);
    list.appendChild(it.row);
    state.items.push(it);
  }
  if (!state.target){
    const last = store.get("convert.target", null);
    if (last && TARGETS[last] && state.items.every(it => routeFor(it.kind, last))) state.target = last;
  }
  refreshFiles();
  renderTargets();
  // fetch the engine and start a worker while the user is choosing a format
  engine().catch(() => {});
  pool.warm(2);
}

function fileRow(it){
  const d = document.createElement("div");
  d.className = "f";
  d.innerHTML = `<span class="kd${it.kind === "bin" ? " unk" : ""}">${escHtml(KINDS[it.kind].label)}</span>
    <span class="nm">${escHtml(it.file.name)}</span>
    <span class="st"></span>
    <span class="sz">${fmtBytes(it.file.size)}</span>
    <button class="x" title="Remove" aria-label="Remove ${escHtml(it.file.name)}">&times;</button>`;
  d.querySelector(".x").onclick = () => {
    if (state.running) return;
    state.items = state.items.filter(x => x !== it);
    d.remove();
    refreshFiles();
    renderTargets();
  };
  return d;
}

// Only the one row changes. The list is never rebuilt during a run.
function setStatus(it, status){
  it.status = status;
  const st = it.row.querySelector(".st");
  st.className = "st" + (status ? " " + status : "");
  st.textContent = status ? (ST_LABEL[status] || status) : "";
}

function refreshFiles(){
  const n = state.items.length;
  const nameCount = new Map();
  for (const it of state.items) nameCount.set(it.file.name, (nameCount.get(it.file.name) || 0) + 1);
  for (const it of state.items){
    const dupe = nameCount.get(it.file.name) > 1;
    it.row.classList.toggle("dupe", dupe);
    it.row.querySelector(".nm").title = dupe ? "Another loaded file has this name" : "";
  }
  $("fileSum").classList.toggle("hide", !n);
  if (!n) return;
  const bytes = state.items.reduce((a, it) => a + it.file.size, 0);
  const kinds = new Set(state.items.map(it => it.kind)).size;
  const dupes = [...nameCount.values()].filter(c => c > 1).length;
  $("fileSumText").textContent =
    `${n} file${n === 1 ? "" : "s"}, ${fmtBytes(bytes)}, ${kinds} format${kinds === 1 ? "" : "s"}` +
    (dupes ? `, ${dupes} repeated name${dupes === 1 ? "" : "s"}` : "");
}

/* ---- targets ------------------------------------------------------------ */

function targetMatches(t, q){
  if (!q) return true;
  const d = TARGETS[t];
  return (d.label + " " + d.ext + " " + d.group + " " + t).toLowerCase().includes(q);
}

function pickTarget(t){
  state.target = t;
  store.set("convert.target", t);
  renderTargets(true);
}

function renderTargets(refocus){
  const box = $("targets");
  box.innerHTML = "";
  const n = state.items.length;
  $("panelTarget").classList.toggle("off", !n);
  $("routes").innerHTML = "";
  if (!n){
    $("targetNote").textContent = "Add files to see available formats.";
    $("tCount").textContent = "";
    state.target = null;
    $("panelOpts").classList.add("off");
    $("panelRun").classList.add("off");
    return;
  }
  const tally = new Map();
  for (const it of state.items){
    for (const t of Object.keys(TARGETS)) if (routeFor(it.kind, t)) tally.set(t, (tally.get(t) || 0) + 1);
  }
  if (state.target && !tally.has(state.target)) state.target = null;
  $("panelOpts").classList.toggle("off", !state.target);
  $("panelRun").classList.toggle("off", !state.target);

  const q = state.tquery.trim().toLowerCase();
  const byGroup = new Map();
  let shown = 0, hiddenUnreachable = 0, hiddenByFilter = 0;
  for (const t of Object.keys(TARGETS)){
    const reachable = tally.has(t);
    if (!targetMatches(t, q)){ if (reachable) hiddenByFilter++; continue; }
    if (!reachable && !state.tshowAll){ hiddenUnreachable++; continue; }
    const g = TARGETS[t].group;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push([t, tally.get(t) || 0, reachable]);
    shown++;
  }

  const frag = document.createDocumentFragment();
  for (const g of GROUP_ORDER){
    const list = byGroup.get(g);
    if (!list) continue;
    const h = document.createElement("div");
    h.className = "grp";
    h.textContent = g;
    frag.appendChild(h);
    for (const [t, c, reachable] of list){
      const b = document.createElement("button");
      b.type = "button";
      const partial = reachable && c < n;
      b.className = "t" + (state.target === t ? " sel" : "") + (partial ? " partial" : "");
      b.setAttribute("aria-pressed", state.target === t ? "true" : "false");
      const needsModule = reachable && state.items.some(it => needsModuleFor(it, t));
      b.innerHTML = `${escHtml(TARGETS[t].label)}<small>${partial ? c + " of " + n : ""}${needsModule ? (partial ? " " : "") + "↑" : ""}</small>`;
      if (!reachable){
        b.disabled = true;
        b.title = `Nothing loaded can reach ${TARGETS[t].label}. It is built from the ${TARGETS[t].via.join(" or ")} representation.`;
      } else {
        const via = TARGETS[t].via.find(h2 => state.items.some(it => hubsOf(it.kind).includes(h2))) || TARGETS[t].via[0];
        b.title = `${TARGETS[t].label}, via ${via}`;
        b.onclick = () => pickTarget(t);
      }
      frag.appendChild(b);
    }
  }
  if (!shown){
    const e = document.createElement("p");
    e.className = "note";
    e.style.width = "100%";
    if (hiddenUnreachable && q)
      e.textContent = `${hiddenUnreachable} format${hiddenUnreachable === 1 ? "" : "s"} match "${q}" but none can be built from these files. Tick Show unreachable to see them.`;
    else if (hiddenUnreachable)
      e.textContent = "No output format is reachable from these files. Tick Show unreachable to see why.";
    else
      e.textContent = `No format matches "${q}".`;
    frag.appendChild(e);
  }
  box.appendChild(frag);
  if (refocus){
    const sel = box.querySelector(".t.sel");
    if (sel) sel.focus({ preventScroll: true });
  }

  const total = Object.keys(TARGETS).length;
  const parts = [`${shown} of ${total} formats`];
  if (hiddenUnreachable) parts.push(`${hiddenUnreachable} unreachable`);
  if (hiddenByFilter) parts.push(`${hiddenByFilter} filtered out`);
  $("tCount").textContent = parts.join(", ");

  const anyModule = state.target && state.items.some(it => needsModuleFor(it, state.target));
  $("targetNote").textContent = state.target
    ? `${tally.get(state.target)} of ${n} file${n === 1 ? "" : "s"} can become ${TARGETS[state.target].label}.` +
      (anyModule ? " An arrow marks formats that need the optional download." : "")
    : "Pick an output format. An arrow marks formats that need the optional download.";
  renderRoutes();
  $("go").disabled = !state.target || state.running;
  renderOpts();
}

// The route is the one thing this tool knows that the user cannot guess.
function renderRoutes(){
  const box = $("routes");
  box.innerHTML = "";
  const t = state.target;
  if (!t || !state.items.length) return;
  const seen = new Map();
  for (const it of state.items){
    let r = routeFor(it.kind, t) || null;
    if (it.kind === "eps" && t === "pdf") r = "vector";
    const key = it.kind + "|" + r;
    if (!seen.has(key)) seen.set(key, { kind: it.kind, hub: r, count: 0 });
    seen.get(key).count++;
  }
  for (const { kind, hub, count } of [...seen.values()].slice(0, 6)){
    const d = document.createElement("div");
    d.className = "route";
    const many = count > 1 ? ` <i>(${count} files)</i>` : "";
    d.innerHTML = hub
      ? `<b>${escHtml(KINDS[kind].label)}</b> <i>&rarr;</i> <em>${escHtml(hub)}</em> <i>&rarr;</i> <b>${escHtml(TARGETS[t].label)}</b>${many}`
      : `<b>${escHtml(KINDS[kind].label)}</b> <i>has no path to</i> <b>${escHtml(TARGETS[t].label)}</b>${many}`;
    box.appendChild(d);
  }
  if (seen.size > 6){
    const d = document.createElement("div");
    d.className = "route";
    d.innerHTML = `<i>and ${seen.size - 6} more</i>`;
    box.appendChild(d);
  }
}

/* ---- options ------------------------------------------------------------ */

function renderOpts(){
  const box = $("opts");
  box.innerHTML = "";
  const t = state.target;
  if (!t) return;

  const kinds = new Set(state.items.map(i => i.kind));
  const hubs = new Set(state.items.map(i => routeFor(i.kind, t)).filter(Boolean));

  // A heading is only written once a field follows it, so no group is ever empty.
  let pending = null;
  const head = title => { pending = title; };
  const add = (html, wire, cls) => {
    if (pending){
      const h = document.createElement("div");
      h.className = "ohead";
      h.textContent = pending;
      box.appendChild(h);
      pending = null;
    }
    const d = document.createElement("div");
    d.className = cls || "o";
    d.innerHTML = html;
    box.appendChild(d);
    if (wire) wire(d);
  };
  const field = (id, label, input) => add(`<label for="${id}">${label}</label>${input}`, d => {
    const el = d.querySelector("#" + id);
    el.onchange = () => { OPTS[id] = el.value; };
  });
  const check = (id, label, dflt) => add(
    `<input type="checkbox" id="${id}"${opt(id, dflt) ? " checked" : ""}><label for="${id}">${label}</label>`,
    d => {
      const el = d.querySelector("#" + id);
      el.onchange = () => { OPTS[id] = el.checked; if (id === "combine") renderOpts(); };
    }, "o check");
  const note = text => add(escHtml(text), null, "onote");
  const select = (id, label, dflt, choices) => field(id, label,
    `<select id="${id}">${choices.map(([v, l]) =>
      `<option value="${v}"${String(opt(id, dflt)) === String(v) ? " selected" : ""}>${l}</option>`).join("")}</select>`);

  head("Image");
  const vectorToRaster = hubs.has("raster") && [...kinds].some(k => VECTOR_KINDS.has(k)) &&
    !(t === "pdf" && [...kinds].every(k => k === "eps"));
  if (vectorToRaster){
    field("vecSize", "Draw SVG and EPS at, longest side in px. 0 keeps the size the file declares",
      `<input type="number" id="vecSize" min="0" max="${MAX_DIM}" step="256" value="${opt("vecSize", 4096)}">`);
  }
  const pictures = TARGETS[t].group === "Image" || t === "pdf" || t === "files";
  if (hubs.has("raster") || (hubs.has("pdf") && pictures)){
    field("imgMax", "Max dimension in px, 0 keeps original",
      `<input type="number" id="imgMax" min="0" step="16" value="${opt("imgMax", 0)}">`);
  }
  if (["jpeg", "webp"].includes(t)){
    const q = +opt("imgQuality", 0.88);
    add(`<label for="imgQuality">Quality</label><div class="range"><input type="range" id="imgQuality" min="0.3" max="1" step="0.01" value="${q}"><output>${Math.round(q * 100)}</output></div>`,
      d => {
        const el = d.querySelector("#imgQuality"), o = d.querySelector("output");
        el.oninput = () => { OPTS.imgQuality = +el.value; o.textContent = Math.round(el.value * 100); };
      });
  }
  if (t === "jpeg" || t === "bmp" || t === "eps"){
    field("imgBg", "Background where the source is transparent",
      `<input type="text" id="imgBg" value="${escHtml(opt("imgBg", "#ffffff"))}">`);
  }
  if (t === "pdf"){
    select("pageSize", "Page size", "letter", ["letter", "a4", "a5", "legal"].map(s => [s, s.toUpperCase()]));
    if (hubs.has("raster")){
      select("fitPage", "Page shape", "page", [["page", "Fixed page, image centred"], ["image", "Page matches the image"]]);
      select("imageFormat", "Embedded image", "flate", [["flate", "Lossless"], ["jpeg", "JPEG, smaller"]]);
    }
    if (kinds.has("eps")) note("EPS and PostScript become a vector PDF through Ghostscript, so page size does not apply to them.");
  }
  if (hubs.has("pdf") && pictures){
    field("pdfScale", "Render scale for PDF pages",
      `<input type="number" id="pdfScale" min="1" max="6" step="0.5" value="${opt("pdfScale", 2)}">`);
  }
  if (t === "gif"){
    select("gifColors", "Palette size", 256, [256, 128, 64, 32, 16].map(c => [c, c + " colours"]));
    if (!hubs.has("anim") || state.items.length > 1)
      field("gifDelay", "Frame delay in ms", `<input type="number" id="gifDelay" min="20" max="5000" step="10" value="${opt("gifDelay", 100)}">`);
    check("gifLoopForever", "Loop forever", true);
  }
  if (t === "frames"){
    field("frameLimit", "Maximum frames to extract",
      `<input type="number" id="frameLimit" min="1" max="2000" step="1" value="${opt("frameLimit", 600)}">`);
  }

  head("Data");
  if (hubs.has("table")){
    check("hasHeader", "First row of the input is a header", true);
    if (["csv", "tsv"].includes(t)) check("writeHeader", "Write a header row", true);
    if (kinds.has("csv")) field("delimIn", "Input delimiter, blank to detect",
      `<input type="text" id="delimIn" maxlength="1" value="${escHtml(opt("delimIn", ""))}">`);
  }
  if (["json", "jsonl", "yaml"].includes(t) && (hubs.has("table") || hubs.has("tree"))) check("jsonPretty", "Indent the output", true);
  if (t === "sql") check("sqlDrop", "Include DROP TABLE statements", true);
  if (kinds.has("sqlite")){
    field("sqliteLimit", "Maximum rows per table",
      `<input type="number" id="sqliteLimit" min="1" step="1000" value="${opt("sqliteLimit", 200000)}">`);
    check("sqliteInternal", "Include internal sqlite_ tables", false);
  }
  if (["geojson", "gpx", "kml", "ics", "vcf"].includes(t))
    note("Columns are matched by name, so latitude, lon, summary, start and email are picked up automatically.");

  head("Document");
  if (t === "txt" && hubs.has("rich")){
    field("textWrap", "Wrap column, 0 for none",
      `<input type="number" id="textWrap" min="0" max="200" step="5" value="${opt("textWrap", 0)}">`);
  }

  head("Captions");
  if (t === "ass"){
    field("assFont", "Font name", `<input type="text" id="assFont" value="${escHtml(opt("assFont", "Arial"))}">`);
    field("assSize", "Font size", `<input type="number" id="assSize" min="10" max="200" step="2" value="${opt("assSize", 54)}">`);
  }
  if (t === "subv" || kinds.has("subv")){
    field("subFps", "Frame rate for frame timed subtitles",
      `<input type="number" id="subFps" min="1" max="120" step="0.001" value="${opt("subFps", 23.976)}">`);
  }

  head("Audio");
  if (["wav", "aiff", "pcm"].includes(t)){
    select("wavBits", "Bit depth", 16, [16, 24, 32].map(b => [b, b === 32 ? (t === "aiff" ? "32 bit" : "32 float") : b + " bit"]));
  }
  if (t === "pcm") check("pcmLittleEndian", "Little endian byte order", true);
  if (["opus", "aac"].includes(t)){
    select("audioBitrate", "Bitrate in kbps", 128000, [64, 96, 128, 160, 192, 256].map(b => [b * 1000, b]));
  }

  head("Output");
  const comb = canCombine(state.items, t);
  if (comb){
    check("combine", `Combine all ${comb.eligible.length} files into one ${TARGETS[t].label}`, false);
    if (opt("combine", false)){
      field("combineName", "Name for the combined file",
        `<input type="text" id="combineName" value="${escHtml(opt("combineName", "combined"))}">`);
      if (comb.hub === "rich") check("combineHeadings", "Add a heading naming each source file", true);
      if (comb.hub === "table" && ["csv", "tsv"].includes(t)) check("combineSource", "Add a column naming each source file", true);
    }
  }
  if (kinds.has("eml")) check("emlAttachments", "Also write mail attachments", true);
  check("allowModules", "Allow the optional module download when a format needs it", true);
}

function runOpts(){
  return {
    ...OPTS,
    allowModules: opt("allowModules", true), imgMax: +opt("imgMax", 0) || 0,
    imgQuality: +opt("imgQuality", 0.88), pdfScale: +opt("pdfScale", 2), textWrap: +opt("textWrap", 0),
    pageSize: opt("pageSize", "letter"), fitPage: opt("fitPage", "page"), imageFormat: opt("imageFormat", "flate"),
    gifColors: +opt("gifColors", 256), gifDelay: +opt("gifDelay", 100),
    gifLoop: opt("gifLoopForever", true) ? 0 : 1,
    frameLimit: +opt("frameLimit", 600), audioBitrate: +opt("audioBitrate", 128000),
    vecSize: Math.max(0, +opt("vecSize", 4096) || 0),
    combineName: opt("combineName", "combined")
  };
}

/* ---- run ---------------------------------------------------------------- */

// Work a worker can do alone. Anything that needs the document, the audio
// stack or pdf.js stays on the page.
const WORKER_HUBS = new Set(["raster", "anim", "mesh", "icons", "table", "tree"]);
const ANY_KIND_HUBS = new Set(["bytes", "archive", "plain"]);
const PAGE_KINDS = new Set(["svg", "eps", "heic", "xml", "xlsx", "gpx", "kml", "kmz", "ods", "html", "pdf"]);
function workerCan(item, hub){
  if (!pool.ok) return false;
  if (ANY_KIND_HUBS.has(hub)) return true;
  return WORKER_HUBS.has(hub) && !PAGE_KINDS.has(item.kind);
}

function done(){
  state.running = false;
  $("stop").disabled = true;
  $("go").disabled = !state.target;
  $("eta").textContent = "";
  const many = state.results.length >= 2;
  $("saveAll").classList.toggle("hide", !many);
  $("saveDir").classList.toggle("hide", !many || !("showDirectoryPicker" in window));
}

function took(t0){
  const secs = (performance.now() - t0) / 1000;
  return secs < 60 ? secs.toFixed(1) + "s" : (secs / 60).toFixed(1) + " min";
}

async function run(){
  if (state.running || !state.target) return;
  state.running = true;
  state.cancel = false;
  state.results = [];
  $("go").disabled = true;
  $("stop").disabled = false;
  clearResults($("results"));
  $("saveAll").classList.add("hide");
  $("saveDir").classList.add("hide");
  log.clear();
  counts.done = counts.out = counts.bytes = counts.skip = counts.err = 0;
  bump();
  $("bar").style.width = "0%";
  $("eta").textContent = "";

  const t = state.target;
  const plain = runOpts();                              // safe to send to a worker
  const opts = { ...plain, notify: msg => log(msg, "d") };
  const namer = uniqueNamer();
  const keep = outs => {
    for (const o of outs){
      o.outName = namer(o.name);
      state.results.push(o);
      counts.out++;
      counts.bytes += o.bytes.length;
      showResult($("results"), o.outName, o.bytes, o.mime);
    }
  };

  const baseCount = new Map();
  for (const it of state.items){
    const b = safeName(baseName(it.file.name));
    baseCount.set(b, (baseCount.get(b) || 0) + 1);
  }
  for (const it of state.items){
    const b = safeName(baseName(it.file.name));
    const ext = (it.file.name.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();
    it.outBase = (baseCount.get(b) > 1 && ext) ? `${b}-${safeName(ext)}` : b;
    setStatus(it, "");
  }

  const t0 = performance.now();
  let E;
  try { E = await engine(); }
  catch (e){
    enginePromise = null;
    log("Could not load the converter. Check the connection and try again.", "e");
    done();
    return;
  }

  const combining = opt("combine", false) && canCombine(state.items, t);
  if (combining){
    const n = combining.eligible.length;
    log(`Combining ${n} file${n === 1 ? "" : "s"} into one ${TARGETS[t].label} via ${combining.hub}.`);
    const skipped = state.items.length - n;
    if (skipped > 0){
      counts.skip += skipped;
      log(`skip  ${skipped} file${skipped === 1 ? "" : "s"} cannot reach ${TARGETS[t].label} through ${combining.hub}`, "w");
    }
    try {
      const outs = await E.convertCombined(state.items, t, opts, (i, item) => {
        $("bar").style.width = (i / n * 90) + "%";
        log(`      reading ${item.file.name}`, "d");
      });
      keep(outs);
      counts.done = n;
      log(`ok    ${outs[0].name}  ${fmtBytes(outs[0].bytes.length)}`, "g");
    } catch (e){
      counts.err++;
      log(`fail  ${e.message}`, "e");
    }
    bump();
    $("bar").style.width = "100%";
    log(`Done in ${took(t0)}. ${counts.out} file${counts.out === 1 ? "" : "s"} produced, ${fmtBytes(counts.bytes)}.`, "g");
    done();
    return;
  }

  const total = state.items.length;
  log(`Converting ${total} file${total === 1 ? "" : "s"} to ${TARGETS[t].label}.`);

  // Page work goes one at a time. Worker work runs side by side.
  let pageLine = Promise.resolve();
  const onPage = fn => {
    const p = pageLine.then(() => {
      if (state.cancel){ const e = new Error("stopped"); e.name = "AbortError"; throw e; }
      return fn();
    });
    pageLine = p.catch(() => {});
    return p;
  };

  let finished = 0;
  const one = async item => {
    const route = routeFor(item.kind, t);
    if (!route){
      counts.skip++;
      setStatus(item, "skip");
      log(`skip  ${item.file.name}  ${KINDS[item.kind].label} has no path to ${TARGETS[t].label}`, "w");
      return;
    }
    setStatus(item, "busy");
    try {
      let outs;
      const here = () => onPage(() => E.convertItem(item, t, opts));
      if (workerCan(item, route)){
        try {
          outs = await pool.run("convert",
            { file: item.file, kind: item.kind, outBase: item.outBase, target: t, opts: plain },
            { onLog: m => log(m, "d") });
        } catch (e){
          if (!e.fallback) throw e;
          outs = await here();
        }
      } else outs = await here();
      keep(outs);
      counts.done++;
      setStatus(item, "ok");
      const size = fmtBytes(outs.reduce((s, o) => s + o.bytes.length, 0));
      log(`ok    ${outs[0].name}${outs.length > 1 ? ` and ${outs.length - 1} more` : ""}  ${size}`, "g");
    } catch (e){
      if (e.name === "AbortError"){ setStatus(item, ""); return; }
      counts.err++;
      setStatus(item, "fail");
      log(`fail  ${item.file.name}  ${e.message}`, "e");
    }
  };

  let next = 0;
  const lane = async () => {
    while (next < total && !state.cancel){
      const item = state.items[next++];
      await one(item);
      finished++;
      $("bar").style.width = (finished / total * 100) + "%";
      bump();
      const left = total - finished;
      if (left > 0 && !state.cancel){
        const secs = (performance.now() - t0) / finished * left / 1000;
        $("eta").textContent = secs < 1 ? "almost done"
          : secs < 90 ? `about ${Math.ceil(secs)}s left`
          : `about ${Math.ceil(secs / 60)} min left`;
      }
    }
  };
  const lanes = Math.min(total, pool.ok ? pool.size : 1);
  await Promise.all(Array.from({ length: lanes }, lane));

  $("bar").style.width = "100%";
  bump();
  log(state.cancel
    ? `Stopped after ${took(t0)}. ${counts.out} file${counts.out === 1 ? "" : "s"} produced.`
    : `Done in ${took(t0)}. ${counts.out} file${counts.out === 1 ? "" : "s"} produced, ${fmtBytes(counts.bytes)}.`,
    state.cancel ? "w" : "g");
  done();
}

/* ---- wiring ------------------------------------------------------------- */

$("tSearch").oninput = e => { state.tquery = e.target.value; renderTargets(); };
$("tSearch").onkeydown = e => {
  if (e.key === "Escape"){ e.target.value = ""; state.tquery = ""; renderTargets(); return; }
  if (e.key === "Enter" || e.key === "ArrowDown"){
    const btns = [...$("targets").querySelectorAll("button.t:not([disabled])")];
    if (!btns.length) return;
    e.preventDefault();
    if (e.key === "Enter" && btns.length === 1) btns[0].click();
    else btns[0].focus();
  }
};
$("tShowAll").onchange = e => { state.tshowAll = e.target.checked; renderTargets(); };
$("clearFiles").onclick = () => {
  if (state.running) return;
  state.items = [];
  $("fileList").innerHTML = "";
  refreshFiles();
  renderTargets();
};

$("targets").addEventListener("keydown", e => {
  if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
  const btns = [...$("targets").querySelectorAll("button.t:not([disabled])")];
  const i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const step = (e.key === "ArrowRight" || e.key === "ArrowDown") ? 1 : -1;
  btns[(i + step + btns.length) % btns.length].focus();
});

$("stop").onclick = () => {
  if (!state.running) return;
  state.cancel = true;
  pool.cancel();
  log("Stopping.", "w");
};
$("go").onclick = () => run().catch(e => { log("Fatal: " + (e.stack || e.message), "e"); done(); });

document.addEventListener("keydown", e => {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
  if ($("app-convert").classList.contains("hide") || $("go").disabled) return;
  e.preventDefault();
  $("go").click();
});

$("saveAll").onclick = async () => {
  const bytes = await zipWrite(state.results.map(r => ({ name: r.path || r.outName, bytes: r.bytes })));
  download("converted.zip", bytes, "application/zip");
};

$("saveDir").onclick = async () => {
  try {
    const dir = await saveToFolder(state.results.map(r => ({
      name: (r.path || r.outName).split("/").filter(Boolean).map(safeName).join("/"), bytes: r.bytes
    })));
    log(`Saved ${state.results.length} files to ${dir}/`, "g");
  } catch (e){
    if (e.name !== "AbortError") log("Save failed: " + e.message, "e");
  }
};
