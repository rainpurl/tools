// PDF tab: reorder, remove, turn, crop, merge and save pages.

import { zipWrite } from "../engine/containers.js";
import { pdfBuild, pdfParse } from "../engine/pdfobj.js";
import { loadPdfDoc } from "../engine/pdfread.js";
import { imagesToPdf } from "../engine/pdfwrite.js";
import { canvasToBytes } from "../engine/raster.js";
import { MIME } from "../engine/registry.js";
import { escHtml, fmtBytes, safeName, utf8 } from "../engine/util.js";
import { $, OPTS, clearResults, makeLog, opt, showResult } from "./dom.js";

const pdfState = { docs: [], pages: [], sel: new Set(), base: [], anchor: -1, gen: 0 };

const pLog = makeLog($("pLog"));

function pSelCount(){
  const n = pdfState.sel.size, t = pdfState.pages.length;
  $("pSelCount").textContent = t ? `${n} of ${t} page${t === 1 ? "" : "s"} selected` : "";
}

export async function addFiles(files){
  for (const f of files){
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (utf8.decode(bytes.subarray(0, 5)) !== "%PDF-" &&
        !new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-")){
      pLog(`skip  ${f.name} is not a pdf`, "e");
      continue;
    }
    let parsed;
    try { parsed = await pdfParse(bytes); }
    catch (e){ pLog(`fail  ${f.name}  ${e.message}`, "e"); continue; }
    const id = pdfState.docs.length;
    parsed.id = id;
    let viewer = null;
    try { viewer = await loadPdfDoc(new Blob([bytes], { type: "application/pdf" })); }
    catch (e){ pLog(`note  thumbnails need the optional module, ${f.name} will show placeholders`, "w"); }
    pdfState.docs.push({ id, name: f.name, bytes, parsed, viewer });
    parsed.pages.forEach((pg, i) => pdfState.pages.push({
      doc: id, index: i, rotate: 0, crop: null
    }));
    pLog(`ok    ${f.name}  ${parsed.pages.length} page${parsed.pages.length === 1 ? "" : "s"}`, "g");
  }
  if (!pdfState.pages.length) return;
  pdfState.base = pdfState.pages.map(p => ({ ...p }));
  pdfState.sel = new Set(pdfState.pages.map((_, i) => i));
  $("pPanelOps").classList.remove("off");
  $("pPanelCrop").classList.remove("off");
  $("pPanelOut").classList.remove("off");
  const total = pdfState.pages.length;
  $("pInfo").textContent = `${pdfState.docs.length} document${pdfState.docs.length === 1 ? "" : "s"}, ` +
    `${total} page${total === 1 ? "" : "s"}. Adding another PDF merges it onto the end.`;
  renderPdfOpts();
  renderPdfPages();
}

/* Thumbnails are drawn once and kept. A selection click only flips a class;
   the grid is rebuilt only when the page order or a page itself changes, and
   a rebuilt cell takes its finished thumbnail back from the cache. */

const thumbs = new Map();                 // "doc:page:turn" to a finished canvas
const thumbKey = pg => `${pg.doc}:${pg.index}:${pg.rotate}`;
let thumbQueue = Promise.resolve();

const thumbWatch = new IntersectionObserver(entries => {
  for (const en of entries){
    if (!en.isIntersecting) continue;
    thumbWatch.unobserve(en.target);
    const cell = en.target;
    thumbQueue = thumbQueue.then(() => drawThumb(cell)).catch(() => {});
  }
}, { rootMargin: "300px" });

async function drawThumb(cell){
  const pg = cell._pg;
  const key = thumbKey(pg);
  if (!cell.isConnected || thumbs.has(key)) return;
  const doc = pdfState.docs[pg.doc];
  if (!doc || !doc.viewer) return;
  const page = await doc.viewer.getPage(pg.index + 1);
  const rot = (((page.rotate + pg.rotate) % 360) + 360) % 360;
  const vp = page.getViewport({ scale: 0.28, rotation: rot });
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(vp.width));
  c.height = Math.max(1, Math.ceil(vp.height));
  const cx = c.getContext("2d");
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: cx, viewport: vp }).promise;
  thumbs.set(key, c);
  const ph = cell.isConnected && cell._pg === pg && cell.querySelector(".ph");
  if (ph) ph.replaceWith(c);
}

function updateSel(){
  const cells = $("pPages").children;
  for (let i = 0; i < cells.length; i++) cells[i].classList.toggle("sel", pdfState.sel.has(i));
  pSelCount();
}

// Move every selected page, in order, to sit before position `pos`.
function moveSelectedTo(pos){
  const sel = pdfState.sel;
  const moving = pdfState.pages.filter((_, i) => sel.has(i));
  if (!moving.length) return;
  const rest = pdfState.pages.filter((_, i) => !sel.has(i));
  const at = pdfState.pages.slice(0, pos).filter((_, i) => !sel.has(i)).length;
  rest.splice(at, 0, ...moving);
  pdfState.pages = rest;
  pdfState.sel = new Set(moving.map((_, k) => at + k));
  pdfState.anchor = -1;
}

let dragFrom = -1;

function renderPdfPages(){
  const box = $("pPages");
  thumbWatch.disconnect();
  const frag = document.createDocumentFragment();
  for (const [i, pg] of pdfState.pages.entries()){
    const doc = pdfState.docs[pg.doc] || { name: "?" };
    const cell = document.createElement("div");
    cell.className = "pg" + (pdfState.sel.has(i) ? " sel" : "");
    cell.tabIndex = 0;
    cell.draggable = true;
    cell._pg = pg;
    const tags = [];
    if (pg.rotate) tags.push(`${pg.rotate}°`);
    if (pg.crop) tags.push("crop");
    if (pdfState.docs.length > 1) tags.push("d" + (pg.doc + 1));
    cell.innerHTML =
      `<div class="ph">page ${pg.index + 1}</div>` +
      `<b>${i + 1}</b><small>${escHtml(doc.name.slice(0, 14))}</small>` +
      (tags.length ? `<div class="tagz">${tags.map(t => `<i>${escHtml(t)}</i>`).join("")}</div>` : "");
    const done = thumbs.get(thumbKey(pg));
    if (done) cell.querySelector(".ph").replaceWith(done);
    else thumbWatch.observe(cell);

    const toggle = e => {
      if (e.shiftKey && pdfState.anchor >= 0){
        const [a, b] = [Math.min(pdfState.anchor, i), Math.max(pdfState.anchor, i)];
        for (let k = a; k <= b; k++) pdfState.sel.add(k);
      } else {
        if (pdfState.sel.has(i)) pdfState.sel.delete(i); else pdfState.sel.add(i);
        pdfState.anchor = i;
      }
      updateSel();
    };
    cell.onclick = toggle;
    cell.onkeydown = e => { if (e.key === " " || e.key === "Enter"){ e.preventDefault(); toggle(e); } };

    cell.ondragstart = e => {
      dragFrom = i;
      // dragging a page that is not selected moves just that page
      if (!pdfState.sel.has(i)){ pdfState.sel = new Set([i]); updateSel(); }
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i + 1));
      for (const k of pdfState.sel) if (box.children[k]) box.children[k].classList.add("drag");
    };
    cell.ondragover = e => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const r = cell.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      cell.classList.toggle("before", !after);
      cell.classList.toggle("after", after);
    };
    cell.ondragleave = () => cell.classList.remove("before", "after");
    cell.ondrop = e => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const after = cell.classList.contains("after");
      dragFrom = -1;
      moveSelectedTo(after ? i + 1 : i);
      renderPdfPages();
    };
    cell.ondragend = () => {
      dragFrom = -1;
      for (const c of box.children) c.classList.remove("drag", "before", "after");
    };
    frag.appendChild(cell);
  }
  box.replaceChildren(frag);
  pSelCount();
}

function renderPdfOpts(){
  const crop = $("pCropOpts");
  crop.innerHTML = "";
  const add = (box, id, label, input) => {
    const d = document.createElement("div");
    d.className = "o";
    d.innerHTML = `<label for="${id}">${label}</label>${input}`;
    box.appendChild(d);
    const el = d.querySelector("#" + id);
    el.onchange = () => { OPTS[id] = el.type === "checkbox" ? el.checked : el.value; };
  };
  for (const [id, label] of [["cropTop","Top margin, percent"],["cropRight","Right margin, percent"],
                             ["cropBottom","Bottom margin, percent"],["cropLeft","Left margin, percent"]]){
    add(crop, id, label, `<input type="number" id="${id}" min="0" max="45" step="0.5" value="${opt(id, 0)}">`);
  }

  const out = $("pOutOpts");
  out.innerHTML = "";
  const colour = opt("pdfColor", "keep");
  const raster = opt("pdfMode", "lossless") === "raster" || colour === "bw";
  add(out, "pdfColor", "Colour",
    `<select id="pdfColor">
       <option value="keep"${colour==="keep"?" selected":""}>Keep colour</option>
       <option value="grey"${colour==="grey"?" selected":""}>Greyscale, for cheaper printing</option>
       <option value="bw"${colour==="bw"?" selected":""}>Black and white only</option>
     </select>`);
  if (colour === "grey" && !raster){
    const n = document.createElement("p");
    n.className = "onote";
    n.textContent = "Greyscale keeps text selectable and sharp. If a printer still prints some colour, " +
      "choose Rasterise every page below, which turns the pixels grey.";
    out.appendChild(n);
  }
  if (colour === "bw"){
    const n = document.createElement("p");
    n.className = "onote";
    n.textContent = "Black and white turns every page into an image, so text is no longer selectable. " +
      "Photos lose their shading. Use a render scale of 3 or more for sharp print text.";
    out.appendChild(n);
    add(out, "pdfCutoff", "Cutoff, 1 to 254. Pixels darker than this print black",
      `<input type="number" id="pdfCutoff" min="1" max="254" step="5" value="${opt("pdfCutoff", 170)}">`);
  }
  add(out, "pdfMode", "How to save",
    `<select id="pdfMode"${colour==="bw"?" disabled":""}>
       <option value="lossless"${!raster?" selected":""}>Keep text and vectors</option>
       <option value="raster"${raster?" selected":""}>Rasterise every page</option>
     </select>`);
  if (!raster){
    const d = document.createElement("div");
    d.className = "o check";
    d.innerHTML = `<input type="checkbox" id="pdfShrink"${opt("pdfShrink", true) ? " checked" : ""}>` +
      `<label for="pdfShrink">Shrink by dropping unused objects and compressing streams</label>`;
    out.appendChild(d);
    $("pdfShrink").onchange = e => { OPTS.pdfShrink = e.target.checked; };
  }
  if (raster){
    const warn = document.createElement("p");
    warn.className = "onote";
    warn.textContent = "Rasterising replaces text with images. It shrinks scanned documents, " +
      "and usually makes text documents larger.";
    out.appendChild(warn);
    add(out, "pdfDpi", "Render scale, higher is sharper and larger",
      `<input type="number" id="pdfDpi" min="0.5" max="4" step="0.25" value="${opt("pdfDpi", 1.5)}">`);
    if (colour !== "bw") add(out, "pdfImg", "Page images",
      `<select id="pdfImg">
         <option value="jpeg"${opt("pdfImg","jpeg")==="jpeg"?" selected":""}>JPEG, much smaller</option>
         <option value="flate"${opt("pdfImg","jpeg")==="flate"?" selected":""}>Lossless, larger</option>
       </select>`);
    if (colour !== "bw" && opt("pdfImg", "jpeg") === "jpeg"){
      add(out, "pdfQuality", "JPEG quality",
        `<input type="number" id="pdfQuality" min="0.3" max="1" step="0.05" value="${opt("pdfQuality", 0.72)}">`);
    }
  }
  add(out, "pdfName", "File name", `<input type="text" id="pdfName" value="${escHtml(opt("pdfName","document"))}">`);
  $("pdfColor").onchange = e => { OPTS.pdfColor = e.target.value; renderPdfOpts(); };
  $("pdfMode").onchange = e => { OPTS.pdfMode = e.target.value; renderPdfOpts(); };
  const img = $("pdfImg");
  if (img) img.onchange = e => { OPTS.pdfImg = e.target.value; renderPdfOpts(); };
}

function pSelected(){
  return [...pdfState.sel].sort((a, b) => a - b);
}

function pReindex(order){
  const sel = new Set();
  pdfState.pages = order.map((p, i) => { if (p.__sel) sel.add(i); const q = { ...p }; delete q.__sel; return q; });
  pdfState.sel = sel;
}

async function pdfCollectPlan(pages){
  const grey = opt("pdfColor", "keep") === "grey";
  return pages.map(pg => {
    const doc = pdfState.docs[pg.doc];
    return { doc: doc.parsed, page: doc.parsed.pages[pg.index], rotate: pg.rotate, crop: pg.crop, grey };
  });
}

// Remove colour from a rendered page. "grey" keeps every shade of grey.
// "bw" turns each pixel black or white around a cutoff, which prints crisp text.
function stripColour(canvas, how){
  if (how !== "grey" && how !== "bw") return canvas;
  const cx = canvas.getContext("2d");
  const img = cx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const cut = Math.max(1, Math.min(254, +opt("pdfCutoff", 170) || 170));
  for (let i = 0; i < d.length; i += 4){
    let y = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
    if (how === "bw") y = y < cut ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  cx.putImageData(img, 0, 0);
  return canvas;
}

async function pdfRenderAll(scale, onEach, pages){
  pages = pages || pdfState.pages;
  const out = [];
  for (const [i, pg] of pages.entries()){
    const doc = pdfState.docs[pg.doc];
    if (!doc.viewer) throw new Error("rasterising needs the optional pdf module, which did not load");
    const page = await doc.viewer.getPage(pg.index + 1);
    const rot = (((page.rotate + pg.rotate) % 360) + 360) % 360;
    let vp = page.getViewport({ scale, rotation: rot });
    const c = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const cx = c.getContext("2d");
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: cx, viewport: vp }).promise;
    let final = c;
    if (pg.crop){
      const x = Math.round(c.width * pg.crop.left);
      const y = Math.round(c.height * pg.crop.top);
      const w = Math.max(1, Math.round(c.width * (1 - pg.crop.left - pg.crop.right)));
      const h = Math.max(1, Math.round(c.height * (1 - pg.crop.top - pg.crop.bottom)));
      const c2 = new OffscreenCanvas(w, h);
      c2.getContext("2d").drawImage(c, x, y, w, h, 0, 0, w, h);
      final = c2;
    }
    out.push(stripColour(final, opt("pdfColor", "keep")));
    onEach && onEach(i + 1, pages.length);
  }
  return out;
}

function pShowResult(name, bytes, mime){ showResult($("pResults"), name, bytes, mime || "application/pdf"); }

let pBusy = false;
async function pdfSave(onlySelected){
  if (pBusy) return;
  const pages = onlySelected ? pSelected().map(i => pdfState.pages[i]) : pdfState.pages;
  if (!pages.length){ pLog(onlySelected ? "Select the pages to save first." : "Nothing to save.", "w"); return; }
  pBusy = true;
  clearResults($("pResults"));
  const name = (safeName(opt("pdfName", "document")) || "document") + (onlySelected ? "-selected" : "");
  const colour = opt("pdfColor", "keep");
  const mode = colour === "bw" ? "raster" : opt("pdfMode", "lossless");
  $("pBar").style.width = "10%";
  try {
    let bytes;
    const before = pdfState.docs.reduce((a, d) => a + d.bytes.length, 0);
    if (mode === "raster"){
      const scale = +opt("pdfDpi", 1.5) || 1.5;
      pLog(`Rasterising ${pages.length} page(s) at scale ${scale}.`);
      const canvases = await pdfRenderAll(scale, (n, t) => {
        $("pBar").style.width = (10 + n / t * 70) + "%";
      }, pages);
      bytes = await imagesToPdf(canvases, {
        pageSize: "letter", fitPage: "image",
        imageFormat: colour !== "bw" && opt("pdfImg", "jpeg") === "jpeg" ? "jpeg" : "flate",
        quality: +opt("pdfQuality", 0.72)
      });
      pLog(`Pages are now images, so the text is no longer selectable.`, "w");
    } else {
      pLog(`Writing ${pages.length} page(s), keeping text and vectors` +
        (colour === "grey" ? ", in greyscale." : "."));
      bytes = await pdfBuild(await pdfCollectPlan(pages), { recompress: opt("pdfShrink", true) });
    }
    $("pBar").style.width = "100%";
    pShowResult(name + ".pdf", bytes);
    const pct = before ? Math.round((1 - bytes.length / before) * 100) : 0;
    pLog(`Done. ${fmtBytes(before)} in, ${fmtBytes(bytes.length)} out` +
      (pct > 0 ? `, ${pct}% smaller.` : pct < 0 ? `, ${-pct}% larger.` : "."), "g");
  } catch (e){
    $("pBar").style.width = "0%";
    pLog("fail  " + e.message, "e");
  } finally { pBusy = false; }
}

async function pdfSaveImages(){
  if (!pdfState.pages.length || pBusy) return;
  clearResults($("pResults"));
  try {
    const scale = +opt("pdfDpi", 1.5) || 1.5;
    pLog(`Rendering ${pdfState.pages.length} page(s) at scale ${scale}.`);
    const canvases = await pdfRenderAll(scale, (n, t) => { $("pBar").style.width = (n / t * 90) + "%"; });
    const fmt = opt("pdfImg", "jpeg") === "jpeg" ? "jpeg" : "png";
    const name = safeName(opt("pdfName", "document")) || "document";
    const files = [];
    for (const [i, c] of canvases.entries()){
      const b = await canvasToBytes(c, fmt, +opt("pdfQuality", 0.85));
      files.push({ name: `${name}-p${String(i + 1).padStart(3, "0")}.${fmt === "jpeg" ? "jpg" : "png"}`, bytes: b });
    }
    $("pBar").style.width = "100%";
    if (files.length === 1) pShowResult(files[0].name, files[0].bytes, MIME[fmt]);
    else pShowResult(name + "-pages.zip", await zipWrite(files), "application/zip");
    pLog(`Done. ${files.length} image${files.length === 1 ? "" : "s"}.`, "g");
  } catch (e){
    pLog("fail  " + e.message, "e");
  }
}


$("pSelAll").onclick = () => { pdfState.sel = new Set(pdfState.pages.map((_, i) => i)); updateSel(); };
$("pSelNone").onclick = () => { pdfState.sel = new Set(); updateSel(); };
$("pSelOdd").onclick = () => {
  pdfState.sel = new Set(pdfState.pages.map((_, i) => i).filter(i => i % 2 === 0));
  updateSel();
};
$("pSelEven").onclick = () => {
  pdfState.sel = new Set(pdfState.pages.map((_, i) => i).filter(i => i % 2 === 1));
  updateSel();
};
$("pDelete").onclick = () => {
  const sel = pdfState.sel;
  if (!sel.size) return;
  if (sel.size === pdfState.pages.length){ pLog("Refusing to remove every page.", "w"); return; }
  pdfState.pages = pdfState.pages.filter((_, i) => !sel.has(i));
  pdfState.sel = new Set();
  pdfState.anchor = -1;
  renderPdfPages();
};

const pRotate = delta => {
  for (const i of pdfState.sel) pdfState.pages[i].rotate = (pdfState.pages[i].rotate + delta + 360) % 360;
  renderPdfPages();
};
$("pRotL").onclick = () => pRotate(-90);
$("pRotR").onclick = () => pRotate(90);
$("pMoveUp").onclick = () => {
  const order = pdfState.pages.map((p, i) => ({ ...p, __sel: pdfState.sel.has(i) }));
  for (let i = 1; i < order.length; i++){
    if (order[i].__sel && !order[i - 1].__sel){
      [order[i - 1], order[i]] = [order[i], order[i - 1]];
    }
  }
  pReindex(order);
  renderPdfPages();
};
$("pMoveDown").onclick = () => {
  const order = pdfState.pages.map((p, i) => ({ ...p, __sel: pdfState.sel.has(i) }));
  for (let i = order.length - 2; i >= 0; i--){
    if (order[i].__sel && !order[i + 1].__sel){
      [order[i + 1], order[i]] = [order[i], order[i + 1]];
    }
  }
  pReindex(order);
  renderPdfPages();
};
$("pReverse").onclick = () => {
  const order = pdfState.pages.map((p, i) => ({ ...p, __sel: pdfState.sel.has(i) })).reverse();
  pReindex(order);
  renderPdfPages();
};
$("pReset").onclick = () => {
  pdfState.pages = pdfState.base.map(p => ({ ...p }));
  pdfState.sel = new Set(pdfState.pages.map((_, i) => i));
  pdfState.anchor = -1;
  renderPdfPages();
};
$("pCropApply").onclick = () => {
  const pct = id => Math.max(0, Math.min(45, +opt(id, 0) || 0)) / 100;
  const crop = { top: pct("cropTop"), right: pct("cropRight"), bottom: pct("cropBottom"), left: pct("cropLeft") };
  if (!crop.top && !crop.right && !crop.bottom && !crop.left){
    pLog("All four margins are zero, so nothing was cropped.", "w");
    return;
  }
  const sel = pSelected();
  if (!sel.length){ pLog("Select the pages to crop first.", "w"); return; }
  for (const i of sel) pdfState.pages[i].crop = { ...crop };
  pLog(`Cropped ${sel.length} page(s).`, "g");
  renderPdfPages();
};
$("pCropClear").onclick = () => {
  for (const p of pdfState.pages) p.crop = null;
  renderPdfPages();
};
$("pSave").onclick = () => pdfSave(false).catch(e => pLog("fail  " + e.message, "e"));
$("pSaveSel").onclick = () => pdfSave(true).catch(e => pLog("fail  " + e.message, "e"));
$("pSaveImages").onclick = () => pdfSaveImages().catch(e => pLog("fail  " + e.message, "e"));
