// A small pool of workers. Heavy jobs run here so the page keeps responding,
// and several files are processed at once.

const LIMIT = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

let slots = [];
let queue = [];
let seq = 0;
let broken = typeof Worker === "undefined";

function fail(job, message, name){
  const err = new Error(message);
  if (name) err.name = name;
  else err.fallback = true;      // the caller may run the job on the page instead
  job.reject(err);
}

function spawn(){
  const slot = { w: null, job: null, ready: false };
  try {
    slot.w = new Worker(new URL("./job.js", import.meta.url), { type: "module" });
  } catch (e){
    broken = true;
    return null;
  }
  slot.w.onmessage = e => {
    const m = e.data;
    if (m.ready){ slot.ready = true; return; }
    const job = slot.job;
    if (!job || m.id !== job.id) return;
    if (m.log !== undefined){ if (job.onLog) job.onLog(m.log); return; }
    slot.job = null;
    if (m.ok) job.resolve(m.result);
    else {
      const err = new Error(m.error.message);
      err.fallback = !!m.error.fallback;
      job.reject(err);
    }
    pump();
  };
  slot.w.onerror = e => {
    e.preventDefault && e.preventDefault();
    // A worker that dies before it says hello could not load its code.
    // Stop using workers; every job still runs, on the page.
    if (!slot.ready) broken = true;
    const job = slot.job;
    slot.job = null;
    slots = slots.filter(s => s !== slot);
    slot.w.terminate();
    if (job) fail(job, "the background worker stopped");
    pump();
  };
  slots.push(slot);
  return slot;
}

function pump(){
  while (queue.length){
    let slot = slots.find(s => !s.job);
    if (!slot && !broken && slots.length < LIMIT) slot = spawn();
    if (!slot){
      if (broken && !slots.length) for (const job of queue.splice(0)) fail(job, "background workers are unavailable");
      return;
    }
    const job = queue.shift();
    slot.job = job;
    try {
      slot.w.postMessage({ id: job.id, op: job.op, payload: job.payload }, job.transfer || []);
    } catch (e){
      slot.job = null;
      fail(job, "could not hand the job to a worker");
    }
  }
}

export const pool = {
  size: LIMIT,
  get ok(){ return !broken; },

  run(op, payload, options){
    const { transfer, onLog } = options || {};
    return new Promise((resolve, reject) => {
      const job = { id: ++seq, op, payload, transfer, onLog, resolve, reject };
      if (broken){ fail(job, "background workers are unavailable"); return; }
      queue.push(job);
      pump();
    });
  },

  // Start workers before they are needed, so the first job does not wait for them.
  warm(n){
    const want = Math.min(n || 1, LIMIT);
    while (!broken && slots.length < want) if (!spawn()) break;
  },

  // Drop every running and waiting job. Workers are replaced on next use.
  cancel(){
    for (const job of queue.splice(0)) fail(job, "stopped", "AbortError");
    for (const slot of slots){
      slot.w.terminate();
      if (slot.job) fail(slot.job, "stopped", "AbortError");
    }
    slots = [];
  }
};

// Try the pool first; if the job needs the document, or workers are not
// available here, run the same work on the page.
export async function offload(op, payload, onPage, options){
  if (!pool.ok) return onPage();
  try {
    return await pool.run(op, payload, options);
  } catch (e){
    if (!e.fallback) throw e;
    return onPage();
  }
}
