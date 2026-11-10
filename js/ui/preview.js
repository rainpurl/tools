// Preview tab: show what a file holds, or say what can open it.

import { decodeFrames } from "../engine/anim.js";
import { audioToWav } from "../engine/audio.js";
import { buildHub, rawBytes, rawText } from "../engine/convert.js";
import { tc } from "../engine/cues.js";
import { meshStats, meshToCanvas } from "../engine/mesh.js";
import { KINDS, VECTOR_KINDS, hubsOf } from "../engine/registry.js";
import { escHtml, fmtBytes } from "../engine/util.js";
import { $, bus, identify } from "./dom.js";

const VIEW_HELP = {
  psd:   { what: "A Photoshop document. Layers, masks and adjustments live in a structure only Photoshop fully describes.",
           note: "The flattened composite is shown above. Individual layers are not.",
           apps: ["GIMP, free and opens most layered PSDs", "Krita, free, good with paint layers", "Photopea, runs in a browser"] },
  raw:   { what: "A camera raw file. It holds unprocessed sensor data, so it needs demosaicing with a profile for your specific camera.",
           apps: ["RawTherapee, free", "darktable, free", "the maker's own utility, usually free"] },
  video: { what: "A video container this browser will not play, usually because of the codec inside rather than the container itself.",
           note: "The audio track can often still be converted, try the Convert tab.",
           apps: ["VLC, free, plays essentially everything", "MPV, free and minimal", "ffmpeg for conversion"] },
  office:{ what: "A legacy Microsoft Office document in the old compound binary format, which predates the zipped XML formats.",
           apps: ["LibreOffice, free, reads all of them", "Microsoft's own free web viewers", "WPS Office, free tier"] },
  iwork: { what: "An Apple iWork document. The contents are compressed protocol buffers in a bundle.",
           apps: ["Pages, Numbers or Keynote on an Apple device", "iCloud.com in a browser, free with an Apple account"] },
  cad:   { what: "A CAD drawing. The geometry is meaningful only alongside its layer, block and unit definitions.",
           apps: ["LibreCAD, free, for 2D DXF", "FreeCAD, free, for 3D", "ODA File Converter, free, converts DWG to DXF"] },
  archive:{ what: "An archive using a compression method the browser does not implement. Only deflate and gzip are built in.",
           apps: ["7-Zip, free, handles 7z, rar, lzh and more", "The Unarchiver on macOS, free", "PeaZip, free"] },
  db:    { what: "A database file. The tables mean little without the schema that surrounds them.",
           apps: ["DB Browser for SQLite, free", "LibreOffice Base, free, for Access files", "MDB Tools, free"] },
  mail:  { what: "A mail store rather than a single message, so it holds many messages plus folder structure.",
           apps: ["Thunderbird, free, imports mbox and pst", "readpst from libpst, free"] },
  font:  { what: "A font file. What you see above is a specimen rendered by the browser using the font itself.",
           apps: ["FontForge, free, for editing", "Font Book on macOS or Windows Font Viewer, built in"] },
  exe:   { what: "An executable or library. There is no document inside it to view.",
           note: "A hex view is shown above. Treat unknown executables with care.",
           apps: ["HxD, free hex editor", "Ghidra, free, for disassembly", "VirusTotal, free, to check it"] },
  vector:{ what: "A vector or metafile format that needs its own interpreter rather than a decoder. EPS, PostScript and AI are handled here; these are not.",
           apps: ["Inkscape, free, opens WMF, EMF, CDR and more", "LibreOffice Draw, free", "Okular, free"] },
  eps:   { what: "PostScript is a program rather than a picture, so it is rendered with Ghostscript, which is fetched once when first needed.",
           note: "If Ghostscript could not load, any low resolution preview embedded in the file is shown instead.",
           apps: ["Inkscape, free, edits EPS", "Ghostscript, free, renders it from the command line", "Okular, free"] },
  disk:  { what: "A disk or filesystem image. The contents sit behind a filesystem that has to be mounted or walked.",
           apps: ["7-Zip, free, browses ISO and VHD", "Rufus or balenaEtcher, free, to write them", "mount on Linux"] },
  three: { what: "A 3D scene format that carries materials, animation or a node graph, not just geometry.",
           note: "OBJ, OFF and STL are read directly and render above.",
           apps: ["Blender, free, imports nearly all of them", "MeshLab, free, for meshes", "Autodesk viewer, free tier"] },
  generic:{ what: "This format is not one the tool decodes, so there is nothing meaningful to render.",
           note: "A hex view of the first bytes is shown above, which is often enough to identify a file.",
           apps: ["VLC, free, for anything media shaped", "7-Zip, free, opens more containers than you expect",
                  "HxD or Hex Fiend, free hex editors"] }
};

const HELP_BY_EXT = {
  psd:"psd", psb:"psd",
  cr2:"raw", cr3:"raw", crw:"raw", nef:"raw", nrw:"raw", arw:"raw", dng:"raw", orf:"raw",
  raf:"raw", rw2:"raw", pef:"raw", srf:"raw", sr2:"raw", dcr:"raw", mrw:"raw", raw:"raw", x3f:"raw",
  avi:"video", wmv:"video", flv:"video", divx:"video", mpg:"video", mpeg:"video", mts:"video",
  m2ts:"video", vob:"video", rm:"video", rmvb:"video", asf:"video", ogv:"video", "3gp":"video",
  doc:"office", xls:"office", ppt:"office", xlsb:"office", pub:"office", vsd:"office", mpp:"office",
  pages:"iwork", numbers:"iwork", key:"iwork",
  dwg:"cad", dxf:"cad", dwf:"cad", iges:"cad", igs:"cad", step:"cad", stp:"cad", sldprt:"cad", prt:"cad",
  "7z":"archive", rar:"archive", sit:"archive", sitx:"archive", lzh:"archive", lha:"archive",
  arj:"archive", arc:"archive", zoo:"archive", xz:"archive", bz2:"archive", cab:"archive",
  z:"archive", lzma:"archive", zst:"archive", dmg:"archive", rpm:"archive", deb:"archive", msi:"archive",
  mdb:"db", accdb:"db", pst:"db", ost:"db", dbx:"db", myd:"db", frm:"db",
  mbox:"mail", olm:"mail", emlx:"mail", nsf:"mail",
  ttf:"font", otf:"font", woff:"font", woff2:"font", ttc:"font", pfb:"font", pfa:"font", fon:"font",
  exe:"exe", dll:"exe", so:"exe", dylib:"exe", sys:"exe", apk:"exe", app:"exe", bin:"exe",
  o:"exe", obj_win:"exe", jar:"exe", com:"exe",
  eps:"eps", ps:"eps", ai:"eps", epsf:"eps", epsi:"eps",
  cdr:"vector", wmf:"vector", emf:"vector",
  pict:"vector", pct:"vector", cgm:"vector", plt:"vector", hpgl:"vector",
  iso:"disk", img:"disk", vhd:"disk", vhdx:"disk", vmdk:"disk", qcow2:"disk", dsk:"disk", toast:"disk",
  fbx:"three", dae:"three", "3ds":"three", blend:"three", max:"three", c4d:"three", ma:"three",
  mb:"three", usd:"three", usdz:"three", glb:"three", gltf:"three", ply:"three", "3mf":"three"
};

const previewState = { items: [], current: -1, urls: [], cleanup: [], turn: 0 };

function vClearStage(){
  for (const u of previewState.urls) URL.revokeObjectURL(u);
  previewState.urls = [];
  for (const fn of previewState.cleanup){ try { fn(); } catch (e){ } }
  previewState.cleanup = [];
  $("vStage").innerHTML = "";
  $("vHelp").classList.add("hide");
  $("vHelp").innerHTML = "";
}

function vUrl(blob){
  const u = URL.createObjectURL(blob);
  previewState.urls.push(u);
  return u;
}

function vEl(tag, attrs, text){
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function vStack(){
  const wrap = vEl("div", { class: "cols" });
  $("vStage").appendChild(wrap);
  return wrap;
}

function vShowCanvas(canvas, parent){
  const c = document.createElement("canvas");
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext("2d").drawImage(canvas, 0, 0);
  (parent || $("vStage")).appendChild(c);
  return c;
}

function vHelp(key, extra){
  const h = VIEW_HELP[key] || VIEW_HELP.generic;
  const box = $("vHelp");
  box.classList.remove("hide");
  box.innerHTML =
    `<h3>${escHtml(extra || "How to open this")}</h3>` +
    `<p>${escHtml(h.what)}</p>` +
    (h.note ? `<p>${escHtml(h.note)}</p>` : "") +
    `<ul>${h.apps.map(a => `<li>${escHtml(a)}</li>`).join("")}</ul>`;
}

function hexDump(u8, limit){
  const n = Math.min(u8.length, limit || 1024);
  const lines = [];
  for (let i = 0; i < n; i += 16){
    const row = u8.subarray(i, i + 16);
    const hex = [...row].map(b => b.toString(16).padStart(2, "0")).join(" ").padEnd(47);
    const asc = [...row].map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : ".").join("");
    lines.push(i.toString(16).padStart(8, "0") + "  " + hex + "  " + asc);
  }
  if (u8.length > n) lines.push(`... ${fmtBytes(u8.length - n)} more`);
  return lines.join("\n");
}

function renderPreviewList(){
  const el = $("vList");
  previewState.items.forEach((it, i) => {
    if (!it.row){
      const d = document.createElement("div");
      d.className = "f pick";
      d.tabIndex = 0;
      d.innerHTML = `<span class="kd${it.kind === "bin" ? " unk" : ""}">${escHtml(KINDS[it.kind].label)}</span>
        <span class="nm">${escHtml(it.file.name)}</span>
        <span class="sz">${fmtBytes(it.file.size)}</span>`;
      d.onclick = () => openPreview(previewState.items.indexOf(it));
      d.onkeydown = e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); d.click(); } };
      el.appendChild(d);
      it.row = d;
    }
    it.row.classList.toggle("on", i === previewState.current);
  });
}

// Offer the other tools that can work on this file, so it does not have to be found again.
function renderActs(it){
  const box = $("vActs");
  box.innerHTML = "";
  const hubs = hubsOf(it.kind);
  const offers = [["convert", "Convert it"]];
  if (hubs.includes("raster") || it.kind === "pdf") offers.push(["images", "Edit as an image"]);
  if (hubs.includes("raster")) offers.push(["batch", "Resize or compress"]);
  if (it.kind === "pdf") offers.push(["pdf", "Edit pages"]);
  box.appendChild(vEl("span", null, "Open in"));
  for (const [app, label] of offers){
    const b = vEl("button", { class: "sm", type: "button" }, label);
    b.onclick = () => bus.send(app, [it.file]);
    box.appendChild(b);
  }
}

async function openPreview(i){
  const it = previewState.items[i];
  if (!it) return;
  previewState.current = i;
  const turn = ++previewState.turn;
  renderPreviewList();
  renderActs(it);
  $("vPanelView").classList.remove("off");
  $("vTitle").textContent = it.file.name;
  vClearStage();

  const meta = $("vMeta");
  const hubs = hubsOf(it.kind).join(", ");
  meta.innerHTML = `<div class="route"><b>${escHtml(KINDS[it.kind].label)}</b> <i>${fmtBytes(it.file.size)}</i>` +
    (it.file.type ? ` <i>${escHtml(it.file.type)}</i>` : "") +
    (hubs ? ` <i>as</i> <em>${escHtml(hubs)}</em>` : "") + `</div>`;

  const stage = $("vStage");
  stage.appendChild(vEl("div", { class: "note" }, "Loading."));
  try {
    await renderPreview(it, turn);
  } catch (e){
    if (turn !== previewState.turn) return;       // another file was opened meanwhile
    vClearStage();
    stage.appendChild(vEl("pre", null, hexDump(await rawBytes(it), 512)));
    const ext = (it.file.name.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();
    vHelp(HELP_BY_EXT[ext] || "generic", `Could not display this file: ${e.message}`);
  }
}

// A slow file must not paint over a newer one. Every repaint checks first.
function fresh(turn){
  if (turn !== previewState.turn){ const e = new Error("superseded"); e.name = "AbortError"; throw e; }
}

async function renderPreview(it, turn){
  const stage = $("vStage");
  const kind = it.kind;
  const ext = (it.file.name.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();
  const hubs = hubsOf(kind);

  if (/^(mp4|m4v|mov|webm|mkv|avi|ogv)$/.test(ext) || /^video\//.test(it.file.type)){
    const v = vEl("video", { controls: "", playsinline: "" });
    v.src = vUrl(it.file);
    const ok = await new Promise(res => {
      v.onloadeddata = () => res(true);
      v.onerror = () => res(false);
      setTimeout(() => res(!!v.videoWidth), 4000);
    });
    fresh(turn); vClearStage();
    if (ok){
      const v2 = vEl("video", { controls: "", playsinline: "" });
      v2.src = vUrl(it.file);
      stage.appendChild(v2);
      previewState.cleanup.push(() => { v2.pause(); v2.removeAttribute("src"); });
      return;
    }
    stage.appendChild(vEl("pre", null, hexDump(await rawBytes(it), 512)));
    vHelp("video", "This browser will not play this video");
    return;
  }

  if (hubs.includes("anim")){
    const frames = await decodeFrames(it.file, kind, 400);
    fresh(turn); vClearStage();
    const wrap = vEl("div", { class: "cols" });
    stage.appendChild(wrap);
    const holder = vEl("div");
    wrap.appendChild(holder);
    const bar = vEl("div", { class: "pager" });
    wrap.appendChild(bar);
    let n = 0, timer = null;
    const draw = () => {
      holder.innerHTML = "";
      const c = document.createElement("canvas");
      c.width = frames[n].canvas.width;
      c.height = frames[n].canvas.height;
      c.getContext("2d").drawImage(frames[n].canvas, 0, 0);
      holder.appendChild(c);
      label.textContent = `frame ${n + 1} of ${frames.length}, ${frames[n].delay} ms`;
    };
    const play = vEl("button", { class: "sm" }, frames.length > 1 ? "Play" : "Single frame");
    const prev = vEl("button", { class: "sm" }, "Previous");
    const next = vEl("button", { class: "sm" }, "Next");
    const label = vEl("span");
    bar.append(play, prev, next, label);
    prev.onclick = () => { n = (n - 1 + frames.length) % frames.length; draw(); };
    next.onclick = () => { n = (n + 1) % frames.length; draw(); };
    play.onclick = () => {
      if (timer){ clearInterval(timer); timer = null; play.textContent = "Play"; return; }
      if (frames.length < 2) return;
      play.textContent = "Pause";
      timer = setInterval(() => { n = (n + 1) % frames.length; draw(); }, frames[n].delay || 100);
    };
    previewState.cleanup.push(() => timer && clearInterval(timer));
    draw();
    return;
  }

  if (hubs.includes("raster")){
    const canvas = await buildHub(it, "raster", { allowModules: true, vecSize: 2048 });
    fresh(turn); vClearStage();
    const wrap = vStack();
    wrap.appendChild(vEl("div", { class: "note" }, `${canvas.width} by ${canvas.height} pixels` +
      (VECTOR_KINDS.has(kind) ? ", drawn from vectors at 2048 px on the long side" : "")));
    vShowCanvas(canvas, wrap);
    if (kind === "psd") vHelp("psd", "About this file");
    return;
  }

  if (hubs.includes("audio")){
    const buf = await buildHub(it, "audio", {});
    fresh(turn); vClearStage();
    const wrap = vEl("div", { class: "cols" });
    stage.appendChild(wrap);
    const c = document.createElement("canvas");
    c.width = 900; c.height = 150;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / c.width));
    ctx.strokeStyle = "#0a0a0a";
    ctx.beginPath();
    for (let x = 0; x < c.width; x++){
      let lo = 1, hi = -1;
      for (let k = 0; k < step; k++){
        const v = data[x * step + k];
        if (v === undefined) break;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      ctx.moveTo(x + 0.5, (1 - hi) * c.height / 2);
      ctx.lineTo(x + 0.5, (1 - lo) * c.height / 2);
    }
    ctx.stroke();
    wrap.appendChild(c);
    wrap.appendChild(vEl("div", { class: "note" },
      `${buf.numberOfChannels} channel${buf.numberOfChannels === 1 ? "" : "s"}, ` +
      `${buf.sampleRate} Hz, ${buf.duration.toFixed(2)} seconds`));
    const a = vEl("audio", { controls: "" });
    a.src = vUrl(new Blob([audioToWav(buf, 16)], { type: "audio/wav" }));
    wrap.appendChild(a);
    previewState.cleanup.push(() => { a.pause(); a.removeAttribute("src"); });
    return;
  }

  if (kind === "pdf"){
    const doc = await buildHub(it, "pdf", { allowModules: true });
    fresh(turn); vClearStage();
    const wrap = vEl("div", { class: "cols" });
    stage.appendChild(wrap);
    const holder = vEl("div");
    const bar = vEl("div", { class: "pager" });
    const prev = vEl("button", { class: "sm" }, "Previous");
    const next = vEl("button", { class: "sm" }, "Next");
    const label = vEl("span");
    bar.append(prev, next, label);
    wrap.append(holder, bar);
    let n = 1;
    const draw = async () => {
      label.textContent = `page ${n} of ${doc.numPages}`;
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1.5 });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const cx = c.getContext("2d");
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      holder.innerHTML = "";
      holder.appendChild(c);
    };
    prev.onclick = async () => { n = n > 1 ? n - 1 : doc.numPages; await draw(); };
    next.onclick = async () => { n = n < doc.numPages ? n + 1 : 1; await draw(); };
    await draw();
    return;
  }

  if (hubs.includes("mesh")){
    const m = await buildHub(it, "mesh", {});
    fresh(turn); vClearStage();
    const st = meshStats(m);
    const wrap = vStack();
    wrap.appendChild(vEl("div", { class: "note" },
      `${m.verts.length} vertices, ${m.faces.length} faces, ` +
      `${st.size.map(x => x.toFixed(3)).join(" by ")} units`));
    vShowCanvas(meshToCanvas(m, { meshSize: 620 }), wrap);
    return;
  }

  if (hubs.includes("cues")){
    const cues = await buildHub(it, "cues", {});
    fresh(turn); vClearStage();
    const t = vEl("table");
    t.innerHTML = "<thead><tr><th>start</th><th>end</th><th>text</th></tr></thead><tbody>" +
      cues.slice(0, 500).map(c =>
        `<tr><td>${tc(c.start, true)}</td><td>${tc(c.end, true)}</td>` +
        `<td style="white-space:normal">${escHtml(c.text)}</td></tr>`).join("") + "</tbody>";
    stage.appendChild(t);
    return;
  }

  if (hubs.includes("archive")){
    const entries = await buildHub(it, "archive", {});
    fresh(turn); vClearStage();
    const t = vEl("table");
    t.innerHTML = "<thead><tr><th>name</th><th>size</th></tr></thead><tbody>" +
      entries.slice(0, 2000).map(e =>
        `<tr><td>${escHtml(e.name)}</td><td>${fmtBytes(e.bytes.length)}</td></tr>`).join("") + "</tbody>";
    const wrap = vStack();
    wrap.appendChild(vEl("div", { class: "note" },
      `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`));
    wrap.appendChild(t);
    return;
  }

  if (hubs.includes("table")){
    const sheets = await buildHub(it, "table", { hasHeader: true });
    fresh(turn); vClearStage();
    const wrap = vEl("div", { class: "cols" });
    stage.appendChild(wrap);
    for (const sh of sheets.slice(0, 6)){
      wrap.appendChild(vEl("div", { class: "note" },
        `${sh.name}, ${sh.rows.length} row${sh.rows.length === 1 ? "" : "s"}`));
      const t = vEl("table");
      t.innerHTML = (sh.headers.length ? "<thead><tr>" + sh.headers.map(h =>
        `<th>${escHtml(h)}</th>`).join("") + "</tr></thead>" : "") +
        "<tbody>" + sh.rows.slice(0, 200).map(r => "<tr>" + r.map(c =>
        `<td>${escHtml(String(c ?? ""))}</td>`).join("") + "</tr>").join("") + "</tbody>";
      wrap.appendChild(t);
    }
    return;
  }

  if (hubs.includes("rich")){
    const html = await buildHub(it, "rich", {});
    fresh(turn); vClearStage();
    const d = new DOMParser().parseFromString(html, "text/html");
    d.querySelectorAll("script,style,link,meta,iframe,object,embed").forEach(n => n.remove());
    const box = vEl("div");
    box.style.cssText = "width:100%;max-height:68vh;overflow:auto;background:#fff;padding:18px 22px;border-radius:4px;font-size:14px;line-height:1.6";
    box.innerHTML = d.body ? d.body.innerHTML : "";
    box.querySelectorAll("table").forEach(t => { t.style.width = "auto"; });
    stage.appendChild(box);
    return;
  }

  if (hubs.includes("plain")){
    const text = await rawText(it);
    fresh(turn); vClearStage();
    stage.appendChild(vEl("pre", null, text.slice(0, 200000)));
    if (HELP_BY_EXT[ext]) vHelp(HELP_BY_EXT[ext], "This looks like a fallback, not a real preview");
    return;
  }

  if (/^(ttf|otf|woff|woff2)$/.test(ext)){
    const url = vUrl(it.file);
    const face = new FontFace("previewFont", `url(${url})`);
    await face.load();
    document.fonts.add(face);
    previewState.cleanup.push(() => document.fonts.delete(face));
    fresh(turn); vClearStage();
    const box = vEl("div");
    box.style.cssText = "width:100%;background:#fff;padding:20px;border-radius:4px;font-family:previewFont";
    box.innerHTML = [
      `<div style="font-size:40px;line-height:1.2">Handgloves 123</div>`,
      `<div style="font-size:22px;margin-top:10px">ABCDEFGHIJKLMNOPQRSTUVWXYZ</div>`,
      `<div style="font-size:22px">abcdefghijklmnopqrstuvwxyz 0123456789</div>`,
      `<div style="font-size:15px;margin-top:12px">The quick brown fox jumps over the lazy dog.</div>`
    ].join("");
    stage.appendChild(box);
    vHelp("font", "About this file");
    return;
  }

  const bytes = await rawBytes(it);
  fresh(turn); vClearStage();
  stage.appendChild(vEl("pre", null, hexDump(bytes, 1024)));
  vHelp(HELP_BY_EXT[ext] || "generic", "Nothing here can display this file");
}

export async function addFiles(files){
  const first = previewState.items.length;
  previewState.items.push(...await identify(files));
  renderPreviewList();
  // show the newest arrival: the user just handed it over
  if (previewState.items.length > first) await openPreview(first);
}
