// Audio decoding and the WAV, AIFF, PCM, Opus and AAC writers.

import { concatBytes, enc } from "./util.js";

export async function decodeAudio(blob){
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("no Web Audio support");
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(buf);
  } catch (e){
    throw new Error("this browser could not decode the audio");
  } finally {
    ctx.close && ctx.close();
  }
}

export function audioToWav(buf, bits){
  const chans = buf.numberOfChannels;
  const frames = buf.length;
  const rate = buf.sampleRate;
  const data = [];
  for (let c = 0; c < chans; c++) data.push(buf.getChannelData(c));
  const bytesPer = bits === 32 ? 4 : bits === 24 ? 3 : 2;
  const dataSize = frames * chans * bytesPer;
  const out = new Uint8Array(44 + dataSize);
  const dv = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  str(8, "WAVEfmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, bits === 32 ? 3 : 1, true);
  dv.setUint16(22, chans, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * chans * bytesPer, true);
  dv.setUint16(32, chans * bytesPer, true);
  dv.setUint16(34, bits, true);
  str(36, "data");
  dv.setUint32(40, dataSize, true);
  let p = 44;
  for (let i = 0; i < frames; i++){
    for (let c = 0; c < chans; c++){
      let s = data[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      if (bits === 32){ dv.setFloat32(p, s, true); p += 4; }
      else if (bits === 24){
        const v = Math.round(s * 8388607);
        out[p++] = v & 255; out[p++] = (v >> 8) & 255; out[p++] = (v >> 16) & 255;
      } else {
        dv.setInt16(p, Math.round(s * 32767), true); p += 2;
      }
    }
  }
  return out;
}

export async function resampleAudio(buf, rate){
  if (buf.sampleRate === rate) return buf;
  const frames = Math.ceil(buf.duration * rate);
  const off = new OfflineAudioContext(buf.numberOfChannels, frames, rate);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

export function writeExtended(dv, off, rate){
  if (!rate){ for (let i = 0; i < 10; i++) dv.setUint8(off + i, 0); return; }
  const exp = Math.floor(Math.log2(rate));
  const mant = rate / Math.pow(2, exp);
  dv.setUint16(off, exp + 16383);
  const scaled = mant * Math.pow(2, 63);
  dv.setUint32(off + 2, Math.floor(scaled / 0x100000000));
  dv.setUint32(off + 6, scaled % 0x100000000);
}

export function audioToAiff(buf, bits){
  const ch = buf.numberOfChannels, frames = buf.length;
  const bytesPer = bits === 32 ? 4 : bits === 24 ? 3 : 2;
  const dataSize = frames * ch * bytesPer;
  const ssndSize = dataSize + 8;
  const out = new Uint8Array(54 + dataSize);
  const dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, "FORM");
  dv.setUint32(4, out.length - 8);
  tag(8, "AIFF");
  tag(12, "COMM");
  dv.setUint32(16, 18);
  dv.setInt16(20, ch);
  dv.setUint32(22, frames);
  dv.setInt16(26, bits);
  writeExtended(dv, 28, buf.sampleRate);
  tag(38, "SSND");
  dv.setUint32(42, ssndSize);
  dv.setUint32(46, 0);
  dv.setUint32(50, 0);

  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let p = 54;
  for (let i = 0; i < frames; i++){
    for (let c = 0; c < ch; c++){
      let s = data[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      if (bits === 32){ dv.setInt32(p, Math.round(s * 2147483647)); p += 4; }
      else if (bits === 24){
        const v = Math.round(s * 8388607) & 0xffffff;
        out[p++] = (v >> 16) & 255; out[p++] = (v >> 8) & 255; out[p++] = v & 255;
      } else { dv.setInt16(p, Math.round(s * 32767)); p += 2; }
    }
  }
  return out;
}

export function audioToPcm(buf, bits, littleEndian){
  const ch = buf.numberOfChannels, frames = buf.length;
  const bytesPer = bits === 32 ? 4 : bits === 24 ? 3 : 2;
  const out = new Uint8Array(frames * ch * bytesPer);
  const dv = new DataView(out.buffer);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let p = 0;
  const le = littleEndian !== false;
  for (let i = 0; i < frames; i++){
    for (let c = 0; c < ch; c++){
      let s = data[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      if (bits === 32){ dv.setFloat32(p, s, le); p += 4; }
      else if (bits === 24){
        const v = Math.round(s * 8388607) & 0xffffff;
        if (le){ out[p++] = v & 255; out[p++] = (v >> 8) & 255; out[p++] = (v >> 16) & 255; }
        else { out[p++] = (v >> 16) & 255; out[p++] = (v >> 8) & 255; out[p++] = v & 255; }
      } else { dv.setInt16(p, Math.round(s * 32767), le); p += 2; }
    }
  }
  return out;
}

export const AUDIO_CODECS = {
  opus: { codec: "opus", container: "ogg", rate: 48000, label: "Opus" },
  aac:  { codec: "mp4a.40.2", container: "adts", rate: 0, label: "AAC" }
};

export async function audioCodecSupported(name, channels, rate){
  const def = AUDIO_CODECS[name];
  if (!def || typeof AudioEncoder === "undefined") return false;
  try {
    const res = await AudioEncoder.isConfigSupported({
      codec: def.codec,
      sampleRate: def.rate || rate || 48000,
      numberOfChannels: channels || 2,
      bitrate: 128000
    });
    return !!res.supported;
  } catch (e){ return false; }
}

export async function encodeAudioChunks(buf, name, bitrate){
  const def = AUDIO_CODECS[name];
  if (typeof AudioEncoder === "undefined") throw new Error("this browser has no AudioEncoder");
  const rate = def.rate || buf.sampleRate;
  const src = await resampleAudio(buf, rate);
  const ch = src.numberOfChannels;

  const supported = await audioCodecSupported(name, ch, rate);
  if (!supported) throw new Error(`${def.label} encoding is not available in this browser build`);

  const chunks = [];
  let failure = null;
  const encoder = new AudioEncoder({
    output: c => {
      const b = new Uint8Array(c.byteLength);
      c.copyTo(b);
      chunks.push({ bytes: b, duration: c.duration, timestamp: c.timestamp });
    },
    error: e => { failure = e; }
  });
  encoder.configure({ codec: def.codec, sampleRate: rate, numberOfChannels: ch, bitrate: bitrate || 128000 });

  const block = Math.round(rate * 0.02);
  const planes = [];
  for (let c = 0; c < ch; c++) planes.push(src.getChannelData(c));
  for (let off = 0; off < src.length; off += block){
    if (failure) break;
    const n = Math.min(block, src.length - off);
    const planar = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) planar.set(planes[c].subarray(off, off + n), c * n);
    const ad = new AudioData({
      format: "f32-planar",
      sampleRate: rate,
      numberOfFrames: n,
      numberOfChannels: ch,
      timestamp: Math.round(off / rate * 1e6),
      data: planar
    });
    encoder.encode(ad);
    ad.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw new Error("encoder failed: " + failure.message);
  if (!chunks.length) throw new Error("encoder produced no output");
  return { chunks, rate, channels: ch, frames: src.length };
}

export const OGG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++){
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(bytes){
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ bytes[i]) & 255]) >>> 0;
  return crc >>> 0;
}

export function oggPage(packets, serial, seq, headerType, granule){
  const segments = [];
  for (const p of packets){
    let left = p.length;
    while (left >= 255){ segments.push(255); left -= 255; }
    segments.push(left);
  }
  if (segments.length > 255) throw new Error("too many ogg segments for one page");
  const payload = concatBytes(packets);
  const page = new Uint8Array(27 + segments.length + payload.length);
  const dv = new DataView(page.buffer);
  page.set(enc.encode("OggS"), 0);
  page[4] = 0;
  page[5] = headerType;
  dv.setUint32(6, granule >>> 0, true);
  dv.setUint32(10, Math.floor(granule / 0x100000000), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  dv.setUint32(22, 0, true);
  page[26] = segments.length;
  page.set(Uint8Array.from(segments), 27);
  page.set(payload, 27 + segments.length);
  dv.setUint32(22, oggCrc(page), true);
  return page;
}

export async function audioToOpus(buf, opts){
  const { chunks, rate, channels } = await encodeAudioChunks(buf, "opus", opts.audioBitrate);
  const preSkip = 312;

  const head = new Uint8Array(19);
  head.set(enc.encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = channels;
  new DataView(head.buffer).setUint16(10, preSkip, true);
  new DataView(head.buffer).setUint32(12, rate, true);
  new DataView(head.buffer).setInt16(16, 0, true);
  head[18] = 0;

  const vendor = enc.encode("tools.katr.es");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(enc.encode("OpusTags"), 0);
  const tv = new DataView(tags.buffer);
  tv.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  tv.setUint32(12 + vendor.length, 0, true);

  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages = [];
  let seq = 0;
  pages.push(oggPage([head], serial, seq++, 2, 0));
  pages.push(oggPage([tags], serial, seq++, 0, 0));

  let granule = preSkip;
  let batch = [], batchSegs = 0;
  const flush = (last) => {
    if (!batch.length) return;
    pages.push(oggPage(batch, serial, seq++, last ? 4 : 0, granule));
    batch = []; batchSegs = 0;
  };
  for (let i = 0; i < chunks.length; i++){
    const c = chunks[i];
    const segs = Math.floor(c.bytes.length / 255) + 1;
    if (batchSegs + segs > 255) flush(false);
    batch.push(c.bytes);
    batchSegs += segs;
    granule += Math.round((c.duration || 20000) / 1e6 * 48000);
    if (i === chunks.length - 1) flush(true);
  }
  if (batch.length) flush(true);
  return concatBytes(pages);
}

export const ADTS_RATES = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];

export function adtsHeader(payloadLen, rate, channels){
  let idx = ADTS_RATES.indexOf(rate);
  if (idx < 0) idx = 4;
  const cfg = channels === 8 ? 7 : Math.min(7, Math.max(1, channels));
  const len = payloadLen + 7;
  if (len > 0x1fff) throw new Error("aac frame is too long for an adts header");
  const h = new Uint8Array(7);
  h[0] = 0xff;
  h[1] = 0xf1;
  h[2] = (1 << 6) | (idx << 2) | ((cfg >> 2) & 1);
  h[3] = ((cfg & 3) << 6) | ((len >> 11) & 3);
  h[4] = (len >> 3) & 0xff;
  h[5] = ((len & 7) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}

export async function audioToAac(buf, opts){
  const { chunks, rate, channels } = await encodeAudioChunks(buf, "aac", opts.audioBitrate);
  const parts = [];
  for (const c of chunks) parts.push(adtsHeader(c.bytes.length, rate, channels), c.bytes);
  return concatBytes(parts);
}

export function readExtended(dv, off){
  const exp = dv.getUint16(off) & 0x7fff;
  const hi = dv.getUint32(off + 2), lo = dv.getUint32(off + 6);
  if (!exp && !hi && !lo) return 0;
  return (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
}

export async function aiffDecode(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== "FORM" || (tag(8) !== "AIFF" && tag(8) !== "AIFC"))
    throw new Error("not an aiff file");
  let p = 12, comm = null, ssnd = null, compression = "NONE";
  while (p + 8 <= u8.length){
    const id = tag(p);
    const size = dv.getUint32(p + 4);
    const body = p + 8;
    if (id === "COMM"){
      comm = { channels: dv.getInt16(body), frames: dv.getUint32(body + 2),
               bits: dv.getInt16(body + 6), rate: readExtended(dv, body + 8) };
      if (size >= 22) compression = tag(body + 18);
    } else if (id === "SSND"){
      ssnd = { off: body + 8 + dv.getUint32(body), end: body + size };
    }
    p = body + size + (size & 1);
  }
  if (!comm || !ssnd) throw new Error("aiff is missing its COMM or SSND chunk");
  if (!["NONE", "sowt", "fl32", "FL32"].includes(compression))
    throw new Error("aiff compression " + compression + " is unsupported");
  const { channels, frames, bits, rate } = comm;
  if (!channels || !rate) throw new Error("aiff header has no channels or sample rate");
  const little = compression === "sowt";
  const float = compression === "fl32" || compression === "FL32";
  const bytesPer = float ? 4 : Math.ceil(bits / 8);
  const ctx = new OfflineAudioContext(channels, Math.max(1, frames), rate);
  const buf = ctx.createBuffer(channels, Math.max(1, frames), rate);
  const planes = [];
  for (let c = 0; c < channels; c++) planes.push(buf.getChannelData(c));
  for (let i = 0; i < frames; i++){
    for (let c = 0; c < channels; c++){
      const o = ssnd.off + (i * channels + c) * bytesPer;
      if (o + bytesPer > u8.length || o + bytesPer > ssnd.end) break;
      let v;
      if (float) v = dv.getFloat32(o, little);
      else if (bytesPer === 1) v = (u8[o] - 128) / 128;
      else if (bytesPer === 2) v = dv.getInt16(o, little) / 32768;
      else if (bytesPer === 3){
        const b0 = little ? u8[o + 2] : u8[o], b1 = u8[o + 1], b2 = little ? u8[o] : u8[o + 2];
        let x = (b0 << 16) | (b1 << 8) | b2;
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else v = dv.getInt32(o, little) / 2147483648;
      planes[c][i] = v;
    }
  }
  return buf;
}
