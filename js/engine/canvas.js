// Small canvas helpers every image path uses.

export function bitmapToCanvas(bmp){
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return c;
}

export const MAX_DIM = 16384;

export const MAX_AREA = 1.2e8;

export function vectorScale(w, h, target){
  let s = target ? target / Math.max(w, h) : 1;
  s = Math.min(s, MAX_DIM / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
  return s;
}

export function resizeCanvas(canvas, maxDim, bg){
  let { width: w, height: h } = canvas;
  let scale = 1;
  if (maxDim && Math.max(w, h) > maxDim) scale = maxDim / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  if (scale === 1 && !bg) return canvas;
  const c = new OffscreenCanvas(nw, nh);
  const ctx = c.getContext("2d");
  if (bg){ ctx.fillStyle = bg; ctx.fillRect(0, 0, nw, nh); }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, nw, nh);
  return c;
}

export function canvasFromRGBA(w, h, rgba){
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
  return c;
}

export function canvasRGBA(canvas){
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
}
