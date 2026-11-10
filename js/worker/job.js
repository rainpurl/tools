// Worker side of the pool. One job at a time: convert a file, process a batch
// image, or run a pixel operation on a bitmap.

import { convertItem } from "../engine/convert.js";
import { PIXEL_OPS, processImage } from "../engine/imageops.js";

// Each output must own its whole buffer before it can be handed back without a copy.
function own(bytes, seen){
  let b = bytes;
  if (!(b instanceof Uint8Array)) b = new Uint8Array(b);
  if (b.byteOffset !== 0 || b.byteLength !== b.buffer.byteLength || seen.has(b.buffer)) b = b.slice();
  seen.add(b.buffer);
  return b;
}

const OPS = {
  async convert(p, notify){
    const item = { file: p.file, kind: p.kind, outBase: p.outBase };
    const outs = await convertItem(item, p.target, { ...p.opts, notify });
    const seen = new Set();
    const result = outs.map(o => ({ name: o.name, path: o.path, mime: o.mime, bytes: own(o.bytes, seen) }));
    return { result, transfer: result.map(o => o.bytes.buffer) };
  },

  async batch(p, notify){
    const r = await processImage(p.file, p.kind, p.settings, { allowModules: true, notify });
    r.bytes = own(r.bytes, new Set());
    return { result: r, transfer: [r.bytes.buffer] };
  },

  async pixel(p, notify){
    const fn = PIXEL_OPS[p.name];
    if (!fn) throw new Error("unknown pixel operation " + p.name);
    const src = new OffscreenCanvas(p.bitmap.width, p.bitmap.height);
    src.getContext("2d").drawImage(p.bitmap, 0, 0);
    p.bitmap.close();
    const out = await fn(src, p.params, notify);
    if (!out) return { result: { bitmap: null }, transfer: [] };
    const bitmap = out.transferToImageBitmap();
    return { result: { bitmap }, transfer: [bitmap] };
  }
};

self.onmessage = async e => {
  const { id, op, payload } = e.data;
  const notify = msg => self.postMessage({ id, log: String(msg) });
  try {
    const { result, transfer } = await OPS[op](payload, notify);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err){
    const message = (err && err.message) || String(err);
    // No document in here. Anything that reached for one is retried on the page.
    const fallback = err instanceof ReferenceError || /is not defined|is not a constructor/.test(message);
    self.postMessage({ id, ok: false, error: { message, fallback } });
  }
};

self.postMessage({ ready: true });
