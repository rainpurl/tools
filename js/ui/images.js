// Images tab: edit one image or one animation at a time. A still image is
// treated as an animation with a single frame, so every tool works on both.

import { decodeFrames, framesToApng, framesToGif } from "../engine/anim.js";
import { MAX_DIM, canvasRGBA, resizeCanvas, vectorScale } from "../engine/canvas.js";
import { zipWrite } from "../engine/containers.js";
import {
  PIXEL_OPS, clamp, hexOf, opCrop, opFlip, opRotate, opRotate90, rgbOf, scaleCanvas
} from "../engine/imageops.js";
import { MODULES, useModule } from "../engine/modules.js";
import { loadPdfDoc } from "../engine/pdfread.js";
import { canvasToBytes, loadRaster } from "../engine/raster.js";
import { KINDS, MIME, TARGETS, VECTOR_KINDS, hubsOf } from "../engine/registry.js";
import { baseName, escHtml, fmtBytes, safeName } from "../engine/util.js";
import { offload } from "../worker/pool.js";
import { $, identify, makeLog, showResult } from "./dom.js";

const st = { items: [], cur: -1, mode: null, crop: null, drag: null, pickPt: null, anchor: 0, timer: 0 };
const HISTORY_STILL = 25, HISTORY_ANIM = 10;

const iLog = makeLog($("iLog"));
const iNotify = msg => iLog(String(msg).trim(), "d");
const iCur = () => st.items[st.cur] || null;
const iStage = $("iStage"), iCanvas = $("iCanvas"), iBox = $("iCrop");

function makeItem(file, kind, frames){
  return {
    file, kind, orig: frames, frames, fi: 0, sel: new Set([0]), history: [],
    animated: frames.length > 1,
    get work(){ return this.frames[Math.min(this.fi, this.frames.length - 1)].canvas; }
  };
}

/* ---- loading ------------------------------------------------------------ */

async function iLoad(file, kind){
  const vecSize = clamp(+$("iVecSize").value || 4096, 64, MAX_DIM);
  const opts = { allowModules: true, vecSize, notify: iNotify };
  if (kind === "pdf"){
    const doc = await loadPdfDoc(file);
    const page = await doc.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: vectorScale(vp0.width, vp0.height, vecSize) });
    const c = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return [{ canvas: c, delay: 100 }];
  }
  const hubs = hubsOf(kind);
  if (hubs.includes("anim")){
    try {
      const frames = await decodeFrames(file, kind, 1200);
      if (frames.length > 1) return frames;
    } catch (e){ /* not animated, or this browser cannot step through frames */ }
  }
  if (!hubs.includes("raster")) throw new Error(`${KINDS[kind].label} is not an image format`);
  return [{ canvas: await loadRaster(file, kind, opts), delay: 100 }];
}

export async function addFiles(files){
  let first = -1;
  for (const { file, kind } of await identify(files)){
    iLog(`      reading ${file.name}`, "d");
    let frames;
    try { frames = await iLoad(file, kind); }
    catch (e){ iLog(`fail  ${file.name}  ${e.message}`, "e"); continue; }
    st.items.push(makeItem(file, kind, frames));
    if (first < 0) first = st.items.length - 1;
    const c = frames[0].canvas;
    iLog(`ok    ${file.name}  ${c.width} by ${c.height}` + (frames.length > 1 ? `, ${frames.length} frames` : ""), "g");
  }
  // show what was just added
  if (first >= 0) iSelect(first);
  else { iRenderList(); iShow(); }
}

/* ---- list and stage ----------------------------------------------------- */

function iSelect(i){
  stopPlay();
  st.cur = i;
  st.crop = null;
  st.pickPt = null;
  iSetMode(null);
  const it = iCur();
  if (it){
    $("iName").value = safeName(baseName(it.file.name)) + "-edited";
    const fmt = $("iFmt");
    if (it.animated && !["gif", "apng"].includes(fmt.value)) fmt.value = "gif";
    if (!it.animated && ["gif", "apng"].includes(fmt.value)) fmt.value = "png";
    st.anchor = it.fi;
  }
  iRenderList();
  renderStrip();
  iShow();
  syncSave();
}

function iRenderList(){
  const el = $("iList");
  el.innerHTML = "";
  st.items.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "f pick" + (i === st.cur ? " on" : "");
    const n = it.history.length;
    const edited = n ? `<span class="st ok">${n} edit${n === 1 ? "" : "s"}</span>` : "";
    const frames = it.frames.length > 1 ? `, ${it.frames.length} frames` : "";
    d.innerHTML = `<span class="kd">${escHtml(KINDS[it.kind].label)}</span>
      <span class="nm">${escHtml(it.file.name)}</span>${edited}
      <span class="sz">${it.work.width} by ${it.work.height}${frames}</span>
      <button class="x" title="Remove" aria-label="Remove ${escHtml(it.file.name)}">&times;</button>`;
    d.onclick = e => { if (!e.target.closest(".x")) iSelect(i); };
    d.querySelector(".x").onclick = () => {
      st.items.splice(i, 1);
      iSelect(Math.min(st.cur, st.items.length - 1));
    };
    el.appendChild(d);
  });
  $("iSaveAll").classList.toggle("hide", st.items.length < 2);
}

function drawStage(){
  const it = iCur();
  const c = it.work;
  if (iCanvas.width !== c.width || iCanvas.height !== c.height){ iCanvas.width = c.width; iCanvas.height = c.height; }
  const ctx = iCanvas.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(c, 0, 0);
}

const totalMs = it => it.frames.reduce((a, f) => a + f.delay, 0);

function iShow(){
  const it = iCur();
  $("iPanelEdit").classList.toggle("off", !it);
  $("iPanelOut").classList.toggle("off", !it);
  $("iIntro").classList.toggle("hide", !!st.items.length);
  // only offer what this file can use
  $("iVecRow").classList.toggle("hide", !(it && (VECTOR_KINDS.has(it.kind) || it.kind === "pdf")));
  $("iAnim").classList.toggle("hide", !(it && it.animated));
  $("iToolFrames").classList.toggle("hide", !(it && it.animated));
  $("iSaveFrames").classList.toggle("hide", !(it && it.frames.length > 1));
  if (!it){
    iCanvas.width = 1; iCanvas.height = 1;
    iCropRender();
    return;
  }
  $("iTitle").textContent = it.file.name;
  drawStage();
  const n = it.history.length;
  $("iInfo").textContent = `${it.work.width} by ${it.work.height} px` +
    (it.frames.length > 1 ? `, ${it.frames.length} frames, ${(totalMs(it) / 1000).toFixed(2)} s` : "") +
    (n ? `, ${n} edit${n === 1 ? "" : "s"} to undo` : "");
  iCanvas.style.transform = "";
  $("iAngle").value = 0;
  $("iAngle").nextElementSibling.textContent = "0";
  $("iUndo").disabled = !n;
  $("iReset").disabled = !n;
  if (document.activeElement !== $("iRw")) $("iRw").value = it.work.width;
  if (document.activeElement !== $("iRh")) $("iRh").value = it.work.height;
  frameInfo();
  iCropRender();
}

/* ---- frame strip -------------------------------------------------------- */

function renderStrip(){
  const box = $("iStrip");
  const it = iCur();
  if (!it || !it.animated){ box.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  it.frames.forEach((f, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fr";
    const h = 54, w = Math.max(1, Math.round(f.canvas.width * h / f.canvas.height));
    const c = document.createElement("canvas");
    c.width = Math.min(w, 220) ; c.height = h;
    c.getContext("2d").drawImage(f.canvas, 0, 0, c.width, c.height);
    const s = document.createElement("small");
    s.textContent = `${i + 1} · ${f.delay}ms`;
    b.append(c, s);
    b.onclick = e => pickFrame(i, e);
    frag.appendChild(b);
  });
  box.replaceChildren(frag);
  markStrip();
}

function markStrip(scroll){
  const it = iCur();
  if (!it) return;
  const cells = $("iStrip").children;
  for (let i = 0; i < cells.length; i++){
    cells[i].classList.toggle("sel", it.sel.has(i));
    cells[i].classList.toggle("cur", i === it.fi);
  }
  if (scroll && cells[it.fi]) cells[it.fi].scrollIntoView({ block: "nearest", inline: "nearest" });
  frameInfo();
}

function frameInfo(){
  const it = iCur();
  if (!it || !it.animated) return;
  const f = it.frames[it.fi];
  $("iFrameInfo").textContent = `frame ${it.fi + 1} of ${it.frames.length}, ${it.sel.size} selected`;
  if (document.activeElement !== $("iFrDelay") && f) $("iFrDelay").value = f.delay;
}

function pickFrame(i, e){
  const it = iCur();
  if (!it) return;
  stopPlay();
  if (e && e.shiftKey){
    const [a, b] = [Math.min(st.anchor, i), Math.max(st.anchor, i)];
    it.sel = new Set();
    for (let k = a; k <= b; k++) it.sel.add(k);
  } else if (e && (e.ctrlKey || e.metaKey)){
    if (it.sel.has(i) && it.sel.size > 1) it.sel.delete(i); else it.sel.add(i);
    st.anchor = i;
  } else {
    it.sel = new Set([i]);
    st.anchor = i;
  }
  it.fi = i;
  drawStage();
  markStrip(true);
}

function stopPlay(){
  if (!st.timer) return;
  clearTimeout(st.timer);
  st.timer = 0;
  $("iPlay").textContent = "Play";
  markStrip(true);
}

function play(){
  const it = iCur();
  if (!it || it.frames.length < 2) return;
  $("iPlay").textContent = "Pause";
  const step = () => {
    if (iCur() !== it){ stopPlay(); return; }
    it.fi = (it.fi + 1) % it.frames.length;
    drawStage();
    const cells = $("iStrip").children;
    for (let i = 0; i < cells.length; i++) cells[i].classList.toggle("cur", i === it.fi);
    st.timer = setTimeout(step, it.frames[it.fi].delay);
  };
  st.timer = setTimeout(step, it.frames[it.fi].delay);
}

/* ---- applying edits ----------------------------------------------------- */

// Loops over every pixel run in a worker once the image is big enough to
// make the page stutter. Small images are quicker done in place.
async function pixel(src, name, params){
  const here = () => PIXEL_OPS[name](src, params, iNotify);
  if (src.width * src.height < 600000) return here();
  const bitmap = await createImageBitmap(src);
  const r = await offload("pixel", { bitmap, name, params }, here, { transfer: [bitmap], onLog: iNotify });
  if (!r || r instanceof OffscreenCanvas) return r;
  if (!r.bitmap) return null;
  const c = new OffscreenCanvas(r.bitmap.width, r.bitmap.height);
  c.getContext("2d").drawImage(r.bitmap, 0, 0);
  r.bitmap.close();
  return c;
}

// Frame lists are never changed in place, so an undo step is just the old list.
function commit(it, frames, label, sel, fi){
  it.history.push({ frames: it.frames, fi: it.fi, sel: it.sel });
  const cap = it.animated ? HISTORY_ANIM : HISTORY_STILL;
  if (it.history.length > cap) it.history.shift();
  it.frames = frames;
  it.fi = clamp(fi === undefined ? it.fi : fi, 0, frames.length - 1);
  it.sel = sel || new Set([it.fi]);
  st.anchor = it.fi;
  const c = it.work;
  iLog(`${label}  ${c.width} by ${c.height}` + (frames.length > 1 ? `, ${frames.length} frames` : ""), "g");
  iRenderList();
  renderStrip();
  iShow();
}

let iBusy = false;
async function busy(label, work){
  const it = iCur();
  if (!it || iBusy) return;
  iBusy = true;
  stopPlay();
  $("iPanelEdit").classList.add("busy");
  try { await work(it); }
  catch (e){ iLog(`fail  ${label}  ${e.message}`, "e"); }
  finally {
    iBusy = false;
    $("iPanelEdit").classList.remove("busy");
  }
}

// Run one edit over every frame.
function iApply(label, fn){
  return busy(label, async it => {
    const out = [];
    let changed = false;
    const many = it.frames.length > 1;
    for (const [i, f] of it.frames.entries()){
      const c = await fn(f.canvas, i);
      if (c){ changed = true; out.push({ canvas: c, delay: f.delay }); }
      else out.push(f);
      if (many && i % 20 === 19) iLog(`      ${label}: ${i + 1} of ${it.frames.length} frames`, "d");
    }
    if (!changed){ iLog(`${label}: nothing to change`, "w"); return; }
    commit(it, out, label, it.sel);
  });
}

// Change the list of frames itself.
function frameOp(label, fn){
  return busy(label, async it => {
    const r = fn(it);
    if (!r) return;
    commit(it, r.frames, label, r.sel, r.fi);
  });
}

async function opRemoveBgAi(src){
  const removeBackground = await useModule("bgremove", { notify: iNotify });
  const blob = await src.convertToBlob({ type: "image/png" });
  let last = 0;
  const out = await removeBackground(blob, {
    progress: (key, cur, total) => {
      const pct = total ? Math.floor(cur / total * 4) : 0;
      if (/fetch/.test(key) && pct > last){ last = pct; iLog(`      downloading model ${pct * 25}%`, "d"); }
    }
  });
  const bmp = await createImageBitmap(out);
  const c = new OffscreenCanvas(src.width, src.height);
  c.getContext("2d").drawImage(bmp, 0, 0, src.width, src.height);
  bmp.close && bmp.close();
  return c;
}

/* ---- crop --------------------------------------------------------------- */

function iSetMode(m){
  st.mode = m;
  iStage.classList.toggle("pick", m === "pick");
  iStage.classList.toggle("crop", m === "crop");
  $("iPick").textContent = m === "pick" ? "Click the image" : "Pick from image";
  $("iCropStart").textContent = m === "crop" ? "Drawing, drag on the image" : "Draw crop";
  iCropRender();
}

function iRatio(){
  const v = $("iAspect").value;
  const it = iCur();
  if (v === "orig") return it ? it.work.width / it.work.height : 0;
  return +v || 0;
}

function iScale(){
  const it = iCur();
  const r = iCanvas.getBoundingClientRect();
  return it && r.width ? r.width / it.work.width : 0;
}

function iToImg(e){
  const it = iCur();
  const r = iCanvas.getBoundingClientRect();
  return {
    x: clamp((e.clientX - r.left) * it.work.width / r.width, 0, it.work.width),
    y: clamp((e.clientY - r.top) * it.work.height / r.height, 0, it.work.height)
  };
}

function iCropFrom(ax, ay, px, py){
  const it = iCur();
  const W = it.work.width, H = it.work.height;
  const ratio = iRatio();
  let w = Math.abs(px - ax), h = Math.abs(py - ay);
  if (ratio){ if (w / ratio >= h) h = w / ratio; else w = h * ratio; }
  const dx = px < ax ? -1 : 1, dy = py < ay ? -1 : 1;
  const maxW = dx < 0 ? ax : W - ax, maxH = dy < 0 ? ay : H - ay;
  if (w > maxW){ w = maxW; if (ratio) h = w / ratio; }
  if (h > maxH){ h = maxH; if (ratio) w = h * ratio; }
  st.crop = { x: dx < 0 ? ax - w : ax, y: dy < 0 ? ay - h : ay, w, h };
}

function iCropRender(){
  const c = st.crop;
  const on = st.mode === "crop" && c && c.w >= 1 && c.h >= 1 && iCur();
  iBox.classList.toggle("hide", !on);
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  if (c){
    set("iCx", Math.round(c.x)); set("iCy", Math.round(c.y));
    set("iCw", Math.round(c.w)); set("iCh", Math.round(c.h));
  }
  if (!on) return;
  const s = iScale();
  iBox.style.left = c.x * s + "px";
  iBox.style.top = c.y * s + "px";
  iBox.style.width = c.w * s + "px";
  iBox.style.height = c.h * s + "px";
}
addEventListener("resize", () => iCropRender());

function iStartCrop(){
  const it = iCur();
  if (!it) return;
  stopPlay();
  if (!st.crop){
    const W = it.work.width, H = it.work.height;
    iCropFrom(W * 0.1, H * 0.1, W * 0.9, H * 0.9);
  }
  iSetMode("crop");
}

iStage.addEventListener("pointerdown", e => {
  const it = iCur();
  if (!it) return;
  if (st.mode === "pick"){
    e.preventDefault();
    const p = iToImg(e);
    const x = clamp(Math.floor(p.x), 0, it.work.width - 1), y = clamp(Math.floor(p.y), 0, it.work.height - 1);
    const d = it.work.getContext("2d").getImageData(x, y, 1, 1).data;
    const hex = hexOf(d[0], d[1], d[2]);
    $("iColor").value = hex;
    $("iColorHex").textContent = hex + (d[3] < 255 ? `, alpha ${d[3]}` : "");
    st.pickPt = { x, y };
    iSetMode(null);
    iLog(`picked ${hex} at ${x}, ${y}`);
    return;
  }
  if (st.mode !== "crop") return;
  e.preventDefault();
  iStage.setPointerCapture(e.pointerId);
  const p = iToImg(e);
  const c = st.crop;
  const handle = e.target.dataset && e.target.dataset.c;
  if (handle && c){
    const ax = handle.includes("w") ? c.x + c.w : c.x;
    const ay = handle.includes("n") ? c.y + c.h : c.y;
    st.drag = { type: "resize", ax, ay };
  } else if (c && e.target === iBox){
    st.drag = { type: "move", dx: p.x - c.x, dy: p.y - c.y };
  } else {
    st.drag = { type: "resize", ax: p.x, ay: p.y };
    st.crop = { x: p.x, y: p.y, w: 0, h: 0 };
  }
});
iStage.addEventListener("pointermove", e => {
  const drag = st.drag;
  if (!drag || !iCur()) return;
  const p = iToImg(e);
  const it = iCur(), c = st.crop;
  if (drag.type === "move"){
    c.x = clamp(p.x - drag.dx, 0, it.work.width - c.w);
    c.y = clamp(p.y - drag.dy, 0, it.work.height - c.h);
  } else iCropFrom(drag.ax, drag.ay, p.x, p.y);
  iCropRender();
});

const iEndDrag = () => {
  if (!st.drag) return;
  st.drag = null;
  const c = st.crop;
  if (c && (c.w < 2 || c.h < 2)) st.crop = null;
  iCropRender();
};
iStage.addEventListener("pointerup", iEndDrag);
iStage.addEventListener("pointercancel", iEndDrag);

for (const id of ["iCx", "iCy", "iCw", "iCh"]){
  $(id).addEventListener("change", () => {
    const it = iCur();
    if (!it) return;
    const W = it.work.width, H = it.work.height;
    const x = clamp(+$("iCx").value || 0, 0, W - 1), y = clamp(+$("iCy").value || 0, 0, H - 1);
    iCropFrom(x, y, x + clamp(+$("iCw").value || 1, 1, W - x), y + clamp(+$("iCh").value || 1, 1, H - y));
    iSetMode("crop");
  });
}
$("iAspect").onchange = () => {
  const c = st.crop;
  if (c && iCur()){ iCropFrom(c.x, c.y, c.x + c.w, c.y + c.h); iCropRender(); }
};

function iApplyCrop(){
  const c = st.crop;
  if (!c || c.w < 1 || c.h < 1){ iLog("Draw a crop box first.", "w"); return; }
  const r = { ...c };
  st.crop = null;
  iSetMode(null);
  iApply("crop", src => opCrop(src, r));
}

// The box that holds every pixel that is not fully transparent.
function inkBounds(canvas){
  const w = canvas.width, h = canvas.height, px = canvasRGBA(canvas);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++){
    for (let x = 0, i = y * w * 4 + 3; x < w; x++, i += 4){
      if (px[i] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

function iTrim(){
  const it = iCur();
  if (!it) return;
  if (it.frames.length === 1){ iApply("trim", src => pixel(src, "trim", {})); return; }
  // an animation keeps one size, so trim to the box that fits every frame
  frameOp("trim", () => {
    let u = null;
    for (const f of it.frames){
      const b = inkBounds(f.canvas);
      if (!b) continue;
      u = u ? { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) } : b;
    }
    const W = it.work.width, H = it.work.height;
    if (!u || (u.x0 === 0 && u.y0 === 0 && u.x1 === W - 1 && u.y1 === H - 1)){
      iLog("trim: nothing to change", "w");
      return null;
    }
    const r = { x: u.x0, y: u.y0, w: u.x1 - u.x0 + 1, h: u.y1 - u.y0 + 1 };
    return { frames: it.frames.map(f => ({ canvas: opCrop(f.canvas, r), delay: f.delay })), sel: it.sel };
  });
}

$("iCropStart").onclick = iStartCrop;
$("iCropApply").onclick = iApplyCrop;
$("iCropCancel").onclick = () => { st.crop = null; iSetMode(null); };
$("iTrim").onclick = iTrim;

/* ---- resize, rotate, flip ----------------------------------------------- */

$("iRw").addEventListener("input", () => {
  const it = iCur();
  if (it && $("iRLock").checked) $("iRh").value = Math.max(1, Math.round(+$("iRw").value * it.work.height / it.work.width)) || "";
});
$("iRh").addEventListener("input", () => {
  const it = iCur();
  if (it && $("iRLock").checked) $("iRw").value = Math.max(1, Math.round(+$("iRh").value * it.work.width / it.work.height)) || "";
});
function iResize(w, h){
  const it = iCur();
  if (!it) return;
  w = clamp(Math.round(w) || 0, 1, MAX_DIM); h = clamp(Math.round(h) || 0, 1, MAX_DIM);
  if (w === it.work.width && h === it.work.height){ iLog("resize: already that size", "w"); return; }
  iApply("resize", src => scaleCanvas(src, w, h));
}
$("iResize").onclick = () => iResize(+$("iRw").value, +$("iRh").value);
$("iRHalf").onclick = () => { const it = iCur(); if (it) iResize(it.work.width / 2, it.work.height / 2); };

$("iRotL").onclick = () => iApply("rotate left", src => opRotate90(src, -1));
$("iRotR").onclick = () => iApply("rotate right", src => opRotate90(src, 1));
$("iFlipH").onclick = () => iApply("flip horizontal", src => opFlip(src, true));
$("iFlipV").onclick = () => iApply("flip vertical", src => opFlip(src, false));
$("iAngle").addEventListener("input", e => {
  iCanvas.style.transform = +e.target.value ? `rotate(${e.target.value}deg)` : "";
});
$("iAngleApply").onclick = () => {
  const deg = +$("iAngle").value || 0;
  if (!deg) return;
  iApply(`rotate ${deg} degrees`, src => opRotate(src, deg, $("iExpand").checked));
};

for (const r of document.querySelectorAll("#app-images input[type=range]")){
  const out = r.nextElementSibling;
  const show = () => { out.textContent = r.id === "iQuality" ? Math.round(r.value * 100) : r.value; };
  r.addEventListener("input", show);
  show();
}

/* ---- colour and background ---------------------------------------------- */

$("iColor").addEventListener("input", e => { $("iColorHex").textContent = e.target.value; });
$("iPick").onclick = () => { stopPlay(); iSetMode(st.mode === "pick" ? null : "pick"); };

const iRemove = (hex, label) => {
  const params = { key: rgbOf(hex), tol: +$("iTol").value, soft: +$("iSoft").value, mode: $("iMode").value, seed: st.pickPt };
  iApply(label, src => pixel(src, "removeColor", params));
};
$("iColorApply").onclick = () => iRemove($("iColor").value, "remove " + $("iColor").value);
$("iWhite").onclick = () => iRemove("#ffffff", "remove white");
$("iBlack").onclick = () => iRemove("#000000", "remove black");

function iBgNote(){
  const ai = $("iBgMethod").value === "ai";
  $("iBgTolRow").classList.toggle("hide", ai);
  $("iBgSoftRow").classList.toggle("hide", ai);
  $("iBgNote").textContent = ai
    ? `Runs a segmentation model in the browser. The first use downloads ${MODULES.bgremove.size} through esm.sh and staticimgly.com. The image itself stays on this machine.`
    : "Works on logos, product shots and scans against a plain or two tone backdrop. The colours along the edges are taken as the background.";
}
$("iBgMethod").onchange = iBgNote;
iBgNote();
$("iBgApply").onclick = () => {
  const it = iCur();
  if (!it) return;
  if ($("iBgMethod").value === "ai"){
    if (it.frames.length > 1) iLog(`      the model runs once per frame, ${it.frames.length} frames will take a while`, "w");
    iApply("remove background (AI)", opRemoveBgAi);
  } else {
    const params = { tol: +$("iBgTol").value, soft: +$("iBgSoft").value };
    iApply("remove background", src => pixel(src, "removeBgEdges", params));
  }
};

/* ---- frame tools -------------------------------------------------------- */

const sorted = set => [...set].sort((a, b) => a - b);

$("iPlay").onclick = () => { if (st.timer) stopPlay(); else play(); };
$("iFrSelAll").onclick = () => {
  const it = iCur();
  if (!it) return;
  it.sel = new Set(it.frames.map((_, i) => i));
  markStrip();
};

$("iFrDelete").onclick = () => frameOp("delete frames", it => {
  if (it.sel.size >= it.frames.length){ iLog("An animation needs at least one frame.", "w"); return null; }
  const first = sorted(it.sel)[0];
  return { frames: it.frames.filter((_, i) => !it.sel.has(i)), fi: first };
});

$("iFrKeep").onclick = () => frameOp("keep frames", it => {
  if (it.sel.size >= it.frames.length){ iLog("Every frame is selected, so nothing would be removed.", "w"); return null; }
  const frames = it.frames.filter((_, i) => it.sel.has(i));
  return { frames, sel: new Set(frames.map((_, i) => i)), fi: 0 };
});

$("iFrDup").onclick = () => frameOp("duplicate frames", it => {
  const frames = [];
  it.frames.forEach((f, i) => { frames.push(f); if (it.sel.has(i)) frames.push({ canvas: f.canvas, delay: f.delay }); });
  return { frames };
});

const iMove = dir => frameOp(dir < 0 ? "move earlier" : "move later", it => {
  const idx = sorted(it.sel);
  const frames = it.frames.slice();
  const sel = new Set();
  if (dir < 0){
    if (idx[0] === 0) return null;
    for (const i of idx){ [frames[i - 1], frames[i]] = [frames[i], frames[i - 1]]; sel.add(i - 1); }
  } else {
    if (idx[idx.length - 1] === frames.length - 1) return null;
    for (const i of idx.reverse()){ [frames[i + 1], frames[i]] = [frames[i], frames[i + 1]]; sel.add(i + 1); }
  }
  return { frames, sel, fi: it.fi + dir };
});
$("iFrEarlier").onclick = () => iMove(-1);
$("iFrLater").onclick = () => iMove(1);

$("iFrReverse").onclick = () => frameOp("reverse", it => {
  return { frames: it.frames.slice().reverse(), fi: it.frames.length - 1 - it.fi };
});

// Half the frames, same running time: each kept frame takes on the time of the one after it.
$("iFrHalf").onclick = () => frameOp("drop every other frame", it => {
  if (it.frames.length < 3){ iLog("Too few frames to thin out.", "w"); return null; }
  const frames = [];
  for (let i = 0; i < it.frames.length; i += 2){
    const next = it.frames[i + 1];
    frames.push({ canvas: it.frames[i].canvas, delay: it.frames[i].delay + (next ? next.delay : 0) });
  }
  return { frames, fi: Math.floor(it.fi / 2) };
});

$("iFrDelaySet").onclick = () => frameOp("set frame time", it => {
  const ms = clamp(Math.round(+$("iFrDelay").value) || 100, 20, 60000);
  return { frames: it.frames.map((f, i) => it.sel.has(i) ? { canvas: f.canvas, delay: ms } : f), sel: it.sel };
});
const iSpeed = k => frameOp(k > 1 ? "slower" : "faster", it => ({
  frames: it.frames.map(f => ({ canvas: f.canvas, delay: clamp(Math.round(f.delay * k / 10) * 10, 20, 60000) })), sel: it.sel
}));
$("iFrSlower").onclick = () => iSpeed(1.25);
$("iFrFaster").onclick = () => iSpeed(0.8);

$("iFrExtract").onclick = () => busy("save frames", async it => {
  const base = safeName(baseName(it.file.name));
  const pad = String(it.frames.length).length;
  for (const i of sorted(it.sel)){
    const bytes = await canvasToBytes(it.frames[i].canvas, "png");
    const name = `${base}-frame-${String(i + 1).padStart(pad, "0")}.png`;
    showResult($("iResults"), name, bytes, "image/png");
    iLog(`saved ${name}  ${fmtBytes(bytes.length)}`, "g");
  }
});

/* ---- undo --------------------------------------------------------------- */

$("iUndo").onclick = () => {
  const it = iCur();
  if (!it || !it.history.length || iBusy) return;
  stopPlay();
  const h = it.history.pop();
  it.frames = h.frames; it.fi = h.fi; it.sel = h.sel;
  st.crop = null;
  iSetMode(null);
  iLog("undo", "d");
  iRenderList();
  renderStrip();
  iShow();
};
$("iReset").onclick = () => {
  const it = iCur();
  if (!it || !it.history.length || iBusy) return;
  stopPlay();
  it.history = [];
  it.frames = it.orig;
  it.fi = 0;
  it.sel = new Set([0]);
  st.crop = null;
  iSetMode(null);
  iLog("reset to the original", "d");
  iRenderList();
  renderStrip();
  iShow();
};

document.addEventListener("keydown", e => {
  if ($("app-images").classList.contains("hide")) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  const it = iCur();
  if (e.key === "Escape" && st.mode){ st.crop = null; iSetMode(null); }
  else if (e.key === "Enter" && st.mode === "crop"){ e.preventDefault(); iApplyCrop(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){ e.preventDefault(); $("iUndo").click(); }
  else if (it && it.animated && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.target.closest(".apps")){
    e.preventDefault();
    const n = it.frames.length;
    pickFrame((it.fi + (e.key === "ArrowRight" ? 1 : -1) + n) % n, e.shiftKey ? e : null);
  }
  else if (it && it.animated && e.key === " " && document.activeElement.tagName !== "BUTTON"){ e.preventDefault(); $("iPlay").click(); }
});

$("iVecSize").addEventListener("change", async () => {
  const it = iCur();
  if (!it || it.history.length || !(VECTOR_KINDS.has(it.kind) || it.kind === "pdf")) return;
  try {
    it.orig = it.frames = await iLoad(it.file, it.kind);
    iLog(`redrawn at ${it.work.width} by ${it.work.height}`, "g");
    iRenderList();
    iShow();
  } catch (e){ iLog("fail  " + e.message, "e"); }
});

/* ---- saving ------------------------------------------------------------- */

function syncSave(){
  const it = iCur();
  const fmt = $("iFmt").value;
  const moving = !!it && it.frames.length > 1 && (fmt === "gif" || fmt === "apng");
  $("iQualityRow").classList.toggle("hide", !["jpeg", "webp"].includes(fmt));
  $("iBgRow").classList.toggle("hide", !["jpeg", "bmp", "eps"].includes(fmt));
  $("iGifColorsRow").classList.toggle("hide", !(moving && fmt === "gif"));
  $("iLoopRow").classList.toggle("hide", !moving);
  for (const o of $("iFmt").options) if (o.value === "apng") o.hidden = !(it && it.frames.length > 1);
  const note = $("iFmtNote");
  const stillOfMany = !!it && it.frames.length > 1 && !moving;
  note.classList.toggle("hide", !stillOfMany);
  if (stillOfMany) note.textContent = `This format holds one picture, so only frame ${it.fi + 1} is saved. Choose GIF or Animated PNG to keep the motion.`;
  $("iSave").textContent = moving ? "Save animation" : "Save image";
}
$("iFmt").onchange = syncSave;

// A long GIF takes a while to build, so it is handed to a worker when one is free.
async function encodeMoving(it, fmt){
  const opts = { gifColors: +$("iGifColors").value || 256, gifLoop: $("iLoop").checked ? 0 : 1 };
  const here = () => fmt === "apng" ? framesToApng(it.frames, opts) : framesToGif(it.frames, opts);
  const frames = [], transfer = [];
  for (const f of it.frames){
    const bitmap = await createImageBitmap(f.canvas);
    frames.push({ bitmap, delay: f.delay });
    transfer.push(bitmap);
  }
  return offload("animate", { frames, format: fmt, opts }, here, { transfer });
}

async function iEncode(it){
  const fmt = $("iFmt").value;
  if (it.frames.length > 1 && (fmt === "gif" || fmt === "apng")){
    const bytes = await encodeMoving(it, fmt);
    return fmt === "apng" ? { bytes, ext: "png", mime: "image/apng" } : { bytes, ext: "gif", mime: "image/gif" };
  }
  const still = fmt === "apng" ? "png" : fmt;
  let c = it.work;
  if (["jpeg", "bmp", "eps"].includes(still)) c = resizeCanvas(c, 0, $("iBg").value.trim() || "#ffffff");
  const bytes = await canvasToBytes(c, still, +$("iQuality").value);
  return { bytes, ext: TARGETS[still] ? TARGETS[still].ext : still, mime: MIME[still] || "application/octet-stream" };
}

$("iSave").onclick = () => busy("save", async it => {
  if (it.frames.length > 1) iLog(`      building ${it.frames.length} frames`, "d");
  const { bytes, ext, mime } = await iEncode(it);
  const name = (safeName($("iName").value) || "image") + "." + ext;
  showResult($("iResults"), name, bytes, mime);
  iLog(`saved ${name}  ${fmtBytes(bytes.length)}`, "g");
});

$("iSaveFrames").onclick = () => busy("save frames", async it => {
  const base = safeName($("iName").value) || "image";
  const pad = String(it.frames.length).length;
  const files = [];
  for (const [i, f] of it.frames.entries()){
    files.push({ name: `${base}-${String(i + 1).padStart(pad, "0")}.png`, bytes: await canvasToBytes(f.canvas, "png") });
  }
  const zip = await zipWrite(files);
  showResult($("iResults"), base + "-frames.zip", zip, "application/zip");
  iLog(`saved ${files.length} frames as ${base}-frames.zip  ${fmtBytes(zip.length)}`, "g");
});

$("iSaveAll").onclick = () => busy("save all", async () => {
  const files = [], used = new Map();
  for (const it of st.items){
    const { bytes, ext } = await iEncode(it);
    let nm = safeName(baseName(it.file.name)) + (it.history.length ? "-edited" : "");
    const n = (used.get(nm) || 0) + 1;
    used.set(nm, n);
    if (n > 1) nm += "-" + n;
    files.push({ name: nm + "." + ext, bytes });
  }
  const zip = await zipWrite(files);
  showResult($("iResults"), "images.zip", zip, "application/zip");
  iLog(`saved ${files.length} image${files.length === 1 ? "" : "s"} as images.zip  ${fmtBytes(zip.length)}`, "g");
});

export function onShow(){ requestAnimationFrame(iCropRender); }
