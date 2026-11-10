// Page side of the ffmpeg and 7-Zip worker. One worker, one job at a time.

import { MODULES } from "./modules.js";

let worker = null;
let seq = 0;
const waiting = new Map();

function start(){
  if (worker) return worker;
  worker = new Worker(new URL("../worker/wasm.js", import.meta.url), { type: "module" });
  worker.onmessage = e => {
    const m = e.data;
    const job = waiting.get(m.id);
    if (!job) return;
    if (m.log !== undefined){ if (job.onLog) job.onLog(m.log); return; }
    if (m.progress !== undefined){ if (job.onProgress) job.onProgress(m.progress); return; }
    waiting.delete(m.id);
    if (m.ok){
      if (MODULES[job.module]) MODULES[job.module].loaded = true;
      job.resolve(m.files);
    } else job.reject(new Error(m.error));
  };
  worker.onerror = e => {
    e.preventDefault && e.preventDefault();
    stopTools("the converter stopped: " + (e.message || "it could not load, check the connection"));
  };
  return worker;
}

export function runTool(tool, payload, options){
  const { onLog, onProgress } = options || {};
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject, onLog, onProgress, module: tool === "ffmpeg" ? "ffmpeg" : "sevenzip" });
    try { start().postMessage({ id, tool, payload }); }
    catch (e){ waiting.delete(id); reject(e); }
  });
}

// Drop the running job and everything queued. The worker is rebuilt on next use.
export function stopTools(reason){
  if (worker){ worker.terminate(); worker = null; }
  for (const job of waiting.values()){
    const err = new Error(reason || "stopped");
    if (!reason) err.name = "AbortError";
    job.reject(err);
  }
  waiting.clear();
  if (MODULES.ffmpeg) MODULES.ffmpeg.loaded = false;
}

// A name ffmpeg and 7-Zip can open: no spaces or odd characters, extension kept.
export function plainName(name, fallback){
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || "");
  return "input" + (m ? "." + m[1].toLowerCase() : fallback ? "." + fallback : "");
}
