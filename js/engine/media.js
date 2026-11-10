// Video and audio through ffmpeg, and archives through 7-Zip. Both run in
// their own worker and are fetched the first time a file needs them.

import { tarRead, tarWrite } from "./containers.js";
import { MODULES } from "./modules.js";
import { MIME } from "./registry.js";
import { plainName, runTool } from "./wasmtools.js";

function announce(name, opts){
  const m = MODULES[name];
  if (m.loaded) return;
  if (opts && opts.allowModules === false) throw new Error(`needs the optional ${m.label} module`);
  if (opts && typeof opts.notify === "function") opts.notify(`  loading ${m.label} (${m.size})`);
}

/* ==========================================================================
   ffmpeg
   ========================================================================== */

const CRF = { high: 20, medium: 25, low: 31 };
const VQ = { high: 3, medium: 6, low: 10 };              // for codecs that take a 1 to 31 quality scale

// Each recipe returns the output arguments for one target.
const VIDEO = {
  mp4:  o => ["-c:v", "libx264", "-preset", "veryfast", "-crf", CRF[o.q], "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", o.ab, "-movflags", "+faststart"],
  mov:  o => ["-c:v", "libx264", "-preset", "veryfast", "-crf", CRF[o.q], "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", o.ab],
  mkv:  o => ["-c:v", "libx264", "-preset", "veryfast", "-crf", CRF[o.q], "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", o.ab],
  webm: o => ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "5", "-crf", { high: 8, medium: 16, low: 28 }[o.q], "-b:v", { high: "4M", medium: "2M", low: "900k" }[o.q], "-c:a", "libvorbis", "-b:a", o.ab],
  avi:  o => ["-c:v", "mpeg4", "-vtag", "xvid", "-q:v", VQ[o.q], "-c:a", "libmp3lame", "-b:a", o.ab],
  wmv:  o => ["-c:v", "wmv2", "-q:v", VQ[o.q], "-c:a", "wmav2", "-b:a", o.ab],
  flv:  o => ["-c:v", "flv1", "-q:v", VQ[o.q], "-c:a", "libmp3lame", "-ar", "44100", "-b:a", o.ab],
  ogv:  o => ["-c:v", "libtheora", "-q:v", { high: 8, medium: 6, low: 4 }[o.q], "-c:a", "libvorbis", "-b:a", o.ab],
  mpg:  o => ["-c:v", "mpeg2video", "-q:v", VQ[o.q], "-c:a", "mp2", "-b:a", o.ab]
};
const AUDIO = {
  mp3:  o => ["-c:a", "libmp3lame", "-b:a", o.ab],
  flac: () => ["-c:a", "flac"],
  ogg:  o => ["-c:a", "libvorbis", "-b:a", o.ab],
  m4a:  o => ["-c:a", "aac", "-b:a", o.ab, "-f", "ipod"],
  wma:  o => ["-c:a", "wmav2", "-b:a", o.ab],
  ac3:  o => ["-c:a", "ac3", "-b:a", o.ab],
  opus: o => ["-c:a", "libopus", "-b:a", o.ab],
  aac:  o => ["-c:a", "aac", "-b:a", o.ab, "-f", "adts"],
  wav:  o => ["-c:a", o.bits === 24 ? "pcm_s24le" : o.bits === 32 ? "pcm_f32le" : "pcm_s16le"],
  aiff: o => ["-c:a", o.bits === 24 ? "pcm_s24be" : o.bits === 32 ? "pcm_s32be" : "pcm_s16be"]
};
export const AV_VIDEO = Object.keys(VIDEO);
export const AV_AUDIO = Object.keys(AUDIO);

export async function avConvert(item, target, opts){
  opts = opts || {};
  announce("ffmpeg", opts);
  const notify = typeof opts.notify === "function" ? opts.notify : null;
  const inName = plainName(item.file.name, item.kind === "gif" ? "gif" : "");
  const o = {
    q: ["high", "medium", "low"].includes(opts.videoQuality) ? opts.videoQuality : "medium",
    ab: Math.round((+opts.audioBitrate || 128000) / 1000) + "k",
    bits: +opts.wavBits || 16
  };
  const args = [];
  const start = Math.max(0, +opts.clipStart || 0), end = Math.max(0, +opts.clipEnd || 0);
  if (start) args.push("-ss", String(start));
  args.push("-i", "/in/" + inName);
  if (end > start) args.push("-t", String(end - start));

  const height = +opts.videoHeight || 0, fps = +opts.videoFps || 0;
  let outName, mime;
  if (VIDEO[target]){
    const vf = [];
    // encoders need even sizes; a larger source is brought down to the chosen height
    vf.push(height ? `scale=-2:'min(${height},trunc(ih/2)*2)'` : "scale=trunc(iw/2)*2:trunc(ih/2)*2");
    if (fps) vf.push(`fps=${fps}`);
    args.push("-vf", vf.join(","), ...VIDEO[target](o).map(String));
    if (!args.includes("-pix_fmt")) args.push("-pix_fmt", "yuv420p");
    if (opts.videoMute) args.push("-an");
    outName = "out." + target;
    mime = MIME[target] || "video/" + target;
  } else if (AUDIO[target]){
    args.push("-vn", ...AUDIO[target](o).map(String));
    outName = "out." + (target === "aiff" ? "aif" : target);
    mime = MIME[target] || "audio/" + target;
  } else if (target === "gif"){
    const w = Math.max(16, +opts.gifWidth || 480), f = fps || 12;
    args.push("-vf", `fps=${f},scale='min(${w},iw)':-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${+opts.gifColors || 256}[p];[b][p]paletteuse`, "-loop", String(opts.gifLoop === 1 ? -1 : 0));
    outName = "out.gif";
    mime = "image/gif";
  } else if (target === "frames"){
    args.push("-vf", `fps=${fps || 1}`, "-frames:v", String(Math.max(1, +opts.frameLimit || 600)));
    outName = "frame-%05d.png";
    mime = "image/png";
  } else throw new Error("no video or audio recipe for " + target);
  args.push("/out/" + outName);

  let last = -1;
  const files = await runTool("ffmpeg", { inputs: [{ name: inName, blob: item.file }], args }, {
    onProgress: p => {
      const step = Math.floor(p * 10);
      if (notify && step > last && step < 10){ last = step; notify(`      ${step * 10}% of ${item.file.name}`); }
      if (typeof opts.onProgress === "function") opts.onProgress(p);
    }
  });
  const base = item.outBase || "output";
  if (target === "frames"){
    return files.sort((a, b) => a.name.localeCompare(b.name)).map(f => ({ name: `${base}-${f.name}`, path: `${base}/${f.name}`, bytes: f.bytes, mime }));
  }
  const ext = outName.split(".").pop();
  return [{ name: `${base}.${ext}`, bytes: files[0].bytes, mime }];
}

// Pictures in formats the browser and the built-in decoders cannot read.
export async function avDecodeImage(file, kind, opts){
  announce("ffmpeg", opts);
  const inName = plainName(file.name, kind);
  const files = await runTool("ffmpeg", { inputs: [{ name: inName, blob: file }], args: ["-i", "/in/" + inName, "-frames:v", "1", "-update", "1", "/out/out.png"], lenient: true });
  const bmp = await createImageBitmap(new Blob([files[0].bytes], { type: "image/png" }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return c;
}

/* ==========================================================================
   7-Zip
   ========================================================================== */

export async function sevenExtract(file, kind, opts){
  opts = opts || {};
  announce("sevenzip", opts);
  const inName = plainName(file.name, kind);
  const args = ["x", "/in/" + inName, "-o/out", "-y", "-bd"];
  if (opts.archivePassword) args.push("-p" + opts.archivePassword);
  else args.push("-p");                                  // an empty password, so a locked file fails instead of waiting
  let files = await runTool("7z", { inputs: [{ name: inName, blob: file }], args });
  // a compressed tar unpacks to the tar; open that too
  if (files.length === 1 && (/\.tar$/i.test(files[0].name) || /\.(txz|tbz2?|tzst|tlz|taz|tar\.[a-z0-9]+)$/i.test(file.name))){
    try {
      const inner = tarRead(files[0].bytes);
      if (inner.length) files = inner;
    } catch (e){ /* not a tar after all */ }
  }
  if (files.length === 1 && files[0].name === "input") files[0].name = file.name.replace(/\.[^.]+$/, "") || "file";
  return files.map(f => ({ name: f.name, bytes: f.bytes }));
}

const SEVEN_TYPE = { sevenz: "7z", xz: "xz", bz2: "bzip2", txz: "xz", tbz2: "bzip2", wim: "wim" };

export async function sevenCreate(members, target, opts){
  opts = opts || {};
  announce("sevenzip", opts);
  let inputs = members.map(m => ({ name: m.name.replace(/^\/+/, ""), blob: new Blob([m.bytes]) }));
  if (target === "txz" || target === "tbz2") inputs = [{ name: "archive.tar", blob: new Blob([tarWrite(members)]) }];
  const level = { fast: 1, normal: 5, small: 9 }[opts.archiveLevel] || 5;
  const args = ["a", "-t" + SEVEN_TYPE[target], "-mx=" + level, "-bd", "/out/out", "-r", "*"];
  if (target === "sevenz" && opts.archivePassword) args.push("-p" + opts.archivePassword, "-mhe=on");
  const files = await runTool("7z", { inputs, args, cwd: "/in" });
  return files[0].bytes;
}
