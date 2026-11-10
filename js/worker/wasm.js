// Two large tools compiled to WebAssembly, each fetched on first use: ffmpeg for
// video and audio, and 7-Zip for archives. Input files are mounted, not copied,
// so a large file costs no extra memory on the way in.

const CDN = "https://cdn.jsdelivr.net/npm/";
const FFMPEG = CDN + "@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js";
const SEVENZIP = CDN + "7z-wasm@1.2.0/7zz.es6.js";

let ff = null;                       // ffmpeg stays loaded; it is 32 MB
let sevenFactory = null;
let jobId = 0;
const post = (m, transfer) => self.postMessage({ id: jobId, ...m }, transfer || []);

function walk(FS, dir, base, out){
  for (const name of FS.readdir(dir)){
    if (name === "." || name === "..") continue;
    const path = dir + "/" + name;
    const st = FS.stat(path);
    if (FS.isDir(st.mode)) walk(FS, path, base ? base + "/" + name : name, out);
    else if (FS.isFile(st.mode)) out.push({ name: base ? base + "/" + name : name, path });
  }
  return out;
}

function rmTree(FS, dir){
  for (const name of FS.readdir(dir)){
    if (name === "." || name === "..") continue;
    const path = dir + "/" + name;
    if (FS.isDir(FS.stat(path).mode)){ rmTree(FS, path); FS.rmdir(path); }
    else FS.unlink(path);
  }
}

function collect(FS, dir){
  const files = walk(FS, dir, "", []).map(f => {
    const data = FS.readFile(f.path);
    // own the whole buffer so it can be handed over without a copy
    const bytes = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
    return { name: f.name, bytes };
  });
  return files;
}

async function runFfmpeg(p){
  if (!ff){
    // the same package from a second host, in case the first will not serve a file this large
    let last;
    for (const url of [FFMPEG, FFMPEG.replace(CDN, "https://unpkg.com/")]){
      try {
        const mod = await import(url);
        const wasmURL = url.replace(/\.js$/, ".wasm");
        ff = await mod.default({ mainScriptUrlOrBlob: `${url}#${btoa(JSON.stringify({ wasmURL, workerURL: "" }))}` });
        break;
      } catch (e){ last = e; }
    }
    if (!ff) throw new Error("ffmpeg could not be fetched, check the connection" + (last && last.message ? " (" + String(last.message).slice(0, 120) + ")" : ""));
  }
  const FS = ff.FS;
  const tail = [];
  ff.setLogger(({ message }) => {
    tail.push(message);
    if (tail.length > 40) tail.shift();
    if (p.verbose) post({ log: message });
  });
  ff.setProgress(({ progress }) => { if (progress >= 0 && progress <= 1) post({ progress }); });
  try { FS.mkdir("/in"); } catch (e){ /* left from an earlier job */ }
  try { FS.mkdir("/out"); } catch (e){ rmTree(FS, "/out"); }
  FS.mount(FS.filesystems.WORKERFS, { blobs: p.inputs.map(i => ({ name: i.name, data: i.blob })) }, "/in");
  try {
    ff.setTimeout(-1);
    ff.exec(...p.args);
    const code = ff.ret;
    const files = collect(FS, "/out");
    if (!files.length || (code !== 0 && !p.lenient)){
      const why = tail.filter(l => /error|invalid|unknown|unsupported|not found|no such|could not|unable|failed/i.test(l)).slice(-2).join(" ") ||
        tail.slice(-1)[0] || "ffmpeg stopped with code " + code;
      throw new Error(why.slice(0, 300));
    }
    return files;
  } finally {
    try { rmTree(FS, "/out"); } catch (e){ /* nothing to clear */ }
    try { FS.unmount("/in"); } catch (e){ /* was not mounted */ }
    try { ff.reset(); } catch (e){ /* older cores have no reset */ }
  }
}

async function run7z(p){
  if (!sevenFactory) sevenFactory = (await import(SEVENZIP)).default;
  const lines = [];
  // a fresh copy per job: 7-Zip is not built to run its main twice
  const z = await sevenFactory({
    locateFile: f => SEVENZIP.replace(/[^/]+$/, f),
    print: l => { lines.push(l); if (lines.length > 4000) lines.shift(); },
    printErr: l => { lines.push(l); }
  });
  const FS = z.FS;
  FS.mkdir("/in");
  FS.mkdir("/out");
  FS.mount(z.WORKERFS, { blobs: p.inputs.map(i => ({ name: i.name, data: i.blob })) }, "/in");
  FS.chdir(p.cwd || "/out");
  let code = 0;
  try { z.callMain(p.args); }
  catch (e){ code = typeof e.status === "number" ? e.status : 2; }
  if (p.listing) return [{ name: "listing.txt", bytes: new TextEncoder().encode(lines.join("\n")) }];
  const files = collect(FS, "/out");
  // code 1 is a warning: some entries could not be read, the rest are fine
  if (code > 1 || !files.length){
    const why = lines.filter(l => /error|cannot|can't|unsupported|wrong password|encrypted|not archive/i.test(l)).slice(0, 2).join(" ") ||
      (files.length ? "" : "nothing could be read from this file");
    if (why || !files.length) throw new Error((why || "7-Zip stopped with code " + code).slice(0, 300));
  }
  return files;
}

let line = Promise.resolve();
self.onmessage = e => {
  const { id, tool, payload } = e.data;
  line = line.then(async () => {
    jobId = id;
    try {
      const files = await (tool === "ffmpeg" ? runFfmpeg(payload) : run7z(payload));
      post({ ok: true, files }, files.map(f => f.bytes.buffer));
    } catch (err){
      post({ ok: false, error: (err && err.message) || String(err) });
    }
  });
};

self.postMessage({ ready: true });
