// Images tab: crop, turn, key out colours and remove backgrounds on one image at a time.

import { MAX_DIM, resizeCanvas, vectorScale } from "../engine/canvas.js";
import { zipWrite } from "../engine/containers.js";
import {
  clamp,
  cloneCanvas,
  hexOf,
  PIXEL_OPS,
  opCrop,
  opFlip,
  opRotate,
  opRotate90,
  rgbOf
} from "../engine/imageops.js";
import { MODULES, useModule } from "../engine/modules.js";
import { loadPdfDoc } from "../engine/pdfread.js";
import { canvasToBytes, loadRaster } from "../engine/raster.js";
import { KINDS, MIME, TARGETS, VECTOR_KINDS, hubsOf } from "../engine/registry.js";
import { baseName, escHtml, fmtBytes, safeName } from "../engine/util.js";
import { offload } from "../worker/pool.js";
import { $, identify, makeLog, showResult } from "./dom.js";

const imgState = { items: [], cur: -1, mode: null, crop: null, drag: null, pickPt: null };

const I_HISTORY = 25;

const iLog = makeLog($("iLog"));

const iCur = () => imgState.items[imgState.cur] || null;

const iNotify = msg => iLog(msg.trim(), "d");

async function iLoad(it){
  const vecSize = clamp(+$("iVecSize").value || 4096, 64, MAX_DIM);
  const opts = { allowModules: true, vecSize, notify: iNotify };
  if (it.kind === "pdf"){
    const doc = await loadPdfDoc(it.file);
    const page = await doc.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: vectorScale(vp0.width, vp0.height, vecSize) });
    const c = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }
  if (!hubsOf(it.kind).includes("raster")) throw new Error(`${KINDS[it.kind].label} is not an image format`);
  return loadRaster(it.file, it.kind, opts);
}

export async function addFiles(files){
  for (const { file: f, kind } of await identify(files)){
    const it = { file: f, kind, orig: null, work: null, history: [] };
    iLog(`      reading ${f.name}`, "d");
    try { it.orig = await iLoad(it); }
    catch (e){ iLog(`fail  ${f.name}  ${e.message}`, "e"); continue; }
    it.work = cloneCanvas(it.orig);
    imgState.items.push(it);
    iLog(`ok    ${f.name}  ${it.orig.width} by ${it.orig.height}`, "g");
    if (imgState.cur < 0) iSelect(imgState.items.length - 1);
  }
  iRenderList();
  iShow();
}

function iSelect(i){
  imgState.cur = i;
  imgState.crop = null;
  imgState.pickPt = null;
  iSetMode(null);
  const it = iCur();
  if (it) $("iName").value = safeName(baseName(it.file.name)) + "-edited";
  iRenderList();
  iShow();
}

function iRenderList(){
  const el = $("iList");
  el.innerHTML = "";
  imgState.items.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "f";
    d.style.cursor = "pointer";
    if (i === imgState.cur) d.style.background = "var(--fill)";
    const edited = it.history.length ? `<span class="st ok">${it.history.length} edit${it.history.length === 1 ? "" : "s"}</span>` : "";
    d.innerHTML = `<span class="kd">${escHtml(KINDS[it.kind].label)}</span>
      <span class="nm">${escHtml(it.file.name)}</span>${edited}
      <span class="sz">${it.work.width} by ${it.work.height}</span>
      <button class="x" title="Remove" aria-label="Remove ${escHtml(it.file.name)}">&times;</button>`;
    d.onclick = e => { if (!e.target.closest(".x")) iSelect(i); };
    d.querySelector(".x").onclick = () => {
      imgState.items.splice(i, 1);
      if (imgState.cur >= imgState.items.length) imgState.cur = imgState.items.length - 1;
      iSelect(imgState.cur);
    };
    el.appendChild(d);
  });
}

function iShow(){
  const it = iCur();
  $("iPanelEdit").classList.toggle("off", !it);
  $("iPanelOut").classList.toggle("off", !it);
  if (!it){
    const cv = $("iCanvas");
    cv.width = 1; cv.height = 1;
    $("iInfo").textContent = "";
    $("iTitle").textContent = "Edit";
    iCropRender();
    return;
  }
  $("iTitle").textContent = it.file.name;
  const cv = $("iCanvas");
  cv.width = it.work.width;
  cv.height = it.work.height;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(it.work, 0, 0);
  $("iInfo").textContent = `${it.work.width} by ${it.work.height} px` +
    (it.history.length ? `, ${it.history.length} edit${it.history.length === 1 ? "" : "s"} to undo` : "");
  cv.style.transform = "";
  $("iAngle").value = 0;
  $("iAngle").nextElementSibling.textContent = "0";
  $("iUndo").disabled = !it.history.length;
  $("iReset").disabled = !it.history.length;
  iCropRender();
}

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

let iBusy = false;
async function iApply(label, fn){
  const it = iCur();
  if (!it || iBusy) return;
  iBusy = true;
  $("iPanelEdit").classList.add("off");
  try {
    const out = await fn(it.work);
    if (!out){ iLog(`${label}: nothing to change`, "w"); return; }
    it.history.push(it.work);
    if (it.history.length > I_HISTORY) it.history.shift();
    it.work = out;
    iLog(`${label}  ${out.width} by ${out.height}`, "g");
    iRenderList();
    iShow();
  } catch (e){
    iLog(`fail  ${label}  ${e.message}`, "e");
  } finally {
    iBusy = false;
    $("iPanelEdit").classList.toggle("off", !iCur());
  }
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

const iStage = $("iStage"), iCanvas = $("iCanvas"), iBox = $("iCrop");

function iSetMode(m){
  imgState.mode = m;
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
  imgState.crop = { x: dx < 0 ? ax - w : ax, y: dy < 0 ? ay - h : ay, w, h };
}

function iCropRender(){
  const c = imgState.crop;
  const on = imgState.mode === "crop" && c && c.w >= 1 && c.h >= 1 && iCur();
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
  if (!imgState.crop){
    const W = it.work.width, H = it.work.height;
    iCropFrom(W * 0.1, H * 0.1, W * 0.9, H * 0.9);
  }
  iSetMode("crop");
}

iStage.addEventListener("pointerdown", e => {
  const it = iCur();
  if (!it) return;
  if (imgState.mode === "pick"){
    e.preventDefault();
    const p = iToImg(e);
    const x = clamp(Math.floor(p.x), 0, it.work.width - 1), y = clamp(Math.floor(p.y), 0, it.work.height - 1);
    const d = it.work.getContext("2d").getImageData(x, y, 1, 1).data;
    const hex = hexOf(d[0], d[1], d[2]);
    $("iColor").value = hex;
    $("iColorHex").textContent = hex + (d[3] < 255 ? `, alpha ${d[3]}` : "");
    imgState.pickPt = { x, y };
    iSetMode(null);
    iLog(`picked ${hex} at ${x}, ${y}`);
    return;
  }
  if (imgState.mode !== "crop") return;
  e.preventDefault();
  iStage.setPointerCapture(e.pointerId);
  const p = iToImg(e);
  const c = imgState.crop;
  const handle = e.target.dataset && e.target.dataset.c;
  if (handle && c){
    const ax = handle.includes("w") ? c.x + c.w : c.x;
    const ay = handle.includes("n") ? c.y + c.h : c.y;
    imgState.drag = { type: "resize", ax, ay };
  } else if (c && e.target === iBox){
    imgState.drag = { type: "move", dx: p.x - c.x, dy: p.y - c.y };
  } else {
    imgState.drag = { type: "resize", ax: p.x, ay: p.y };
    imgState.crop = { x: p.x, y: p.y, w: 0, h: 0 };
  }
});
iStage.addEventListener("pointermove", e => {
  const drag = imgState.drag;
  if (!drag || !iCur()) return;
  const p = iToImg(e);
  const it = iCur(), c = imgState.crop;
  if (drag.type === "move"){
    c.x = clamp(p.x - drag.dx, 0, it.work.width - c.w);
    c.y = clamp(p.y - drag.dy, 0, it.work.height - c.h);
  } else iCropFrom(drag.ax, drag.ay, p.x, p.y);
  iCropRender();
});

const iEndDrag = () => {
  if (!imgState.drag) return;
  imgState.drag = null;
  const c = imgState.crop;
  if (c && (c.w < 2 || c.h < 2)) imgState.crop = null;
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
  const c = imgState.crop;
  if (c && iCur()){ iCropFrom(c.x, c.y, c.x + c.w, c.y + c.h); iCropRender(); }
};

function iApplyCrop(){
  const c = imgState.crop;
  if (!c || c.w < 1 || c.h < 1){ iLog("Draw a crop box first.", "w"); return; }
  const r = { ...c };
  imgState.crop = null;
  iSetMode(null);
  iApply("crop", src => opCrop(src, r));
}

$("iCropStart").onclick = iStartCrop;
$("iCropApply").onclick = iApplyCrop;
$("iCropCancel").onclick = () => { imgState.crop = null; iSetMode(null); };
$("iTrim").onclick = () => iApply("trim", src => pixel(src, "trim", {}));

document.addEventListener("keydown", e => {
  if ($("app-images").classList.contains("hide")) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  if (e.key === "Escape" && imgState.mode){ imgState.crop = null; iSetMode(null); }
  else if (e.key === "Enter" && imgState.mode === "crop"){ e.preventDefault(); iApplyCrop(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){ e.preventDefault(); $("iUndo").click(); }
});

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

$("iColor").addEventListener("input", e => { $("iColorHex").textContent = e.target.value; });
$("iPick").onclick = () => iSetMode(imgState.mode === "pick" ? null : "pick");

const iRemove = (hex, label) => {
  const mode = $("iMode").value;
  const params = { key: rgbOf(hex), tol: +$("iTol").value, soft: +$("iSoft").value, mode, seed: imgState.pickPt };
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
  if ($("iBgMethod").value === "ai") iApply("remove background (AI)", opRemoveBgAi);
  else {
    const params = { tol: +$("iBgTol").value, soft: +$("iBgSoft").value };
    iApply("remove background", src => pixel(src, "removeBgEdges", params));
  }
};

$("iUndo").onclick = () => {
  const it = iCur();
  if (!it || !it.history.length) return;
  it.work = it.history.pop();
  imgState.crop = null;
  iSetMode(null);
  iLog("undo", "d");
  iRenderList();
  iShow();
};
$("iReset").onclick = () => {
  const it = iCur();
  if (!it || !it.history.length) return;
  it.history = [];
  it.work = cloneCanvas(it.orig);
  imgState.crop = null;
  iSetMode(null);
  iLog("reset to the original", "d");
  iRenderList();
  iShow();
};

$("iVecSize").addEventListener("change", async () => {
  const it = iCur();
  if (!it || it.history.length || !(VECTOR_KINDS.has(it.kind) || it.kind === "pdf")) return;
  try {
    it.orig = await iLoad(it);
    it.work = cloneCanvas(it.orig);
    iLog(`redrawn at ${it.work.width} by ${it.work.height}`, "g");
    iRenderList();
    iShow();
  } catch (e){ iLog("fail  " + e.message, "e"); }
});

async function iEncode(it){
  const fmt = $("iFmt").value;
  let c = it.work;
  if (["jpeg", "bmp", "eps"].includes(fmt)) c = resizeCanvas(c, 0, $("iBg").value.trim() || "#ffffff");
  const bytes = await canvasToBytes(c, fmt, +$("iQuality").value);
  return { bytes, ext: TARGETS[fmt] ? TARGETS[fmt].ext : fmt, mime: MIME[fmt] || "application/octet-stream" };
}

$("iSave").onclick = async () => {
  const it = iCur();
  if (!it) return;
  try {
    const { bytes, ext, mime } = await iEncode(it);
    const name = (safeName($("iName").value) || "image") + "." + ext;
    showResult($("iResults"), name, bytes, mime);
    iLog(`saved ${name}  ${fmtBytes(bytes.length)}`, "g");
  } catch (e){ iLog("fail  " + e.message, "e"); }
};
$("iSaveAll").onclick = async () => {
  if (!imgState.items.length) return;
  try {
    const files = [], used = new Map();
    for (const it of imgState.items){
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
  } catch (e){ iLog("fail  " + e.message, "e"); }
};

export function onShow(){ requestAnimationFrame(iCropRender); }
