// OBJ, OFF and STL meshes.

import { enc, utf8 } from "./util.js";

export function meshStats(m){
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of m.verts) for (let c = 0; c < 3; c++){
    if (v[c] < lo[c]) lo[c] = v[c];
    if (v[c] > hi[c]) hi[c] = v[c];
  }
  if (!m.verts.length) lo = hi = [0, 0, 0];
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

export function makeWelder(verts){
  const index = new Map();
  verts.forEach((v, i) => index.set(v.map(x => x.toFixed(6)).join(","), i));
  return v => {
    const key = v.map(x => x.toFixed(6)).join(",");
    const hit = index.get(key);
    if (hit !== undefined) return hit;
    verts.push(v);
    index.set(key, verts.length - 1);
    return verts.length - 1;
  };
}

export function objDecode(text, name){
  const verts = [], faces = [];
  let objName = "";
  for (const raw of text.split(/\r\n?|\n/)){
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (key === "v"){
      const p = rest.split(/\s+/).map(Number);
      if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) verts.push(p.slice(0, 3));
    } else if (key === "f"){
      const idx = rest.split(/\s+/).map(tok => {
        const n = parseInt(tok.split("/")[0], 10);
        if (!Number.isFinite(n)) return null;
        return n > 0 ? n - 1 : verts.length + n;
      }).filter(n => n !== null && n >= 0 && n < verts.length);
      if (idx.length >= 3) faces.push(idx);
    } else if ((key === "o" || key === "g") && !objName){
      objName = rest;
    }
  }
  if (!verts.length) throw new Error("no vertices found in this obj file");
  return { name: objName || name || "mesh", verts, faces };
}

export function meshToObj(m){
  const out = [`# written by tools.katr.es`, `o ${(m.name || "mesh").replace(/\s+/g, "_")}`];
  for (const v of m.verts) out.push(`v ${v[0]} ${v[1]} ${v[2]}`);
  for (const f of m.faces) out.push("f " + f.map(i => i + 1).join(" "));
  return out.join("\n") + "\n";
}

export function offDecode(text, name){
  const clean = text.replace(/#[^\n]*/g, " ");
  const toks = clean.split(/\s+/).filter(Boolean);
  let p = 0;
  if (!/^[CN]?OFF$/i.test(toks[0] || "")) throw new Error("not an off file");
  p = 1;
  const nv = +toks[p++], nf = +toks[p++];
  p++;
  if (!Number.isFinite(nv) || !Number.isFinite(nf) || nv < 0) throw new Error("bad off counts");
  const extra = /^COFF$/i.test(toks[0]) ? 3 : /^NOFF$/i.test(toks[0]) ? 3 : 0;
  const verts = [];
  for (let i = 0; i < nv; i++){
    const x = +toks[p++], y = +toks[p++], z = +toks[p++];
    p += extra;
    if (![x, y, z].every(Number.isFinite)) throw new Error("bad vertex at index " + i);
    verts.push([x, y, z]);
  }
  const faces = [];
  for (let i = 0; i < nf && p < toks.length; i++){
    const n = +toks[p++];
    if (!Number.isFinite(n) || n < 3){ break; }
    const idx = [];
    for (let k = 0; k < n; k++) idx.push(+toks[p++]);
    if (idx.every(v => Number.isFinite(v) && v >= 0 && v < nv)) faces.push(idx);
    while (p < toks.length && !Number.isInteger(+toks[p])) p++;
  }
  if (!verts.length) throw new Error("no vertices found in this off file");
  return { name: name || "mesh", verts, faces };
}

export function meshToOff(m){
  const out = ["OFF", `${m.verts.length} ${m.faces.length} 0`];
  for (const v of m.verts) out.push(`${v[0]} ${v[1]} ${v[2]}`);
  for (const f of m.faces) out.push(`${f.length} ${f.join(" ")}`);
  return out.join("\n") + "\n";
}

export function triangulate(faces){
  const tris = [];
  for (const f of faces){
    for (let k = 1; k + 1 < f.length; k++) tris.push([f[0], f[k], f[k + 1]]);
  }
  return tris;
}

export function stlDecode(u8, name){
  if (u8.length >= 84){
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint32(80, true);
    if (n > 0 && 84 + n * 50 === u8.length){
      const verts = [], faces = [];
      const weld = makeWelder(verts);
      for (let i = 0; i < n; i++){
        const o = 84 + i * 50 + 12;
        const tri = [];
        for (let k = 0; k < 3; k++){
          const b = o + k * 12;
          tri.push(weld([dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)]));
        }
        if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) faces.push(tri);
      }
      if (!verts.length) throw new Error("binary stl has no vertices");
      return { name: name || "mesh", verts, faces };
    }
  }
  const text = utf8.decode(u8);
  if (!/^\s*solid/i.test(text) || !/facet/i.test(text))
    throw new Error("not a recognisable stl file, neither binary nor ascii");
  const verts = [], faces = [];
  const weld = makeWelder(verts);
  let tri = [];
  const nameMatch = text.match(/^\s*solid\s+(.*)$/im);
  for (const raw of text.split(/\r\n?|\n/)){
    const m = raw.trim().match(/^vertex\s+(\S+)\s+(\S+)\s+(\S+)/i);
    if (!m) continue;
    tri.push(weld([+m[1], +m[2], +m[3]]));
    if (tri.length === 3){
      if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) faces.push(tri);
      tri = [];
    }
  }
  if (!verts.length) throw new Error("ascii stl has no vertices");
  return { name: (nameMatch && nameMatch[1].trim()) || name || "mesh", verts, faces };
}

export function meshToStl(m, opts){
  const tris = triangulate(m.faces);
  const norm = t => {
    const [a, b, c] = t.map(i => m.verts[i]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
  };
  if (opts && opts.stlAscii){
    const nm = (m.name || "mesh").replace(/\s+/g, "_");
    const out = [`solid ${nm}`];
    for (const t of tris){
      const n = norm(t);
      out.push(`  facet normal ${n[0]} ${n[1]} ${n[2]}`, "    outer loop");
      for (const i of t) out.push(`      vertex ${m.verts[i][0]} ${m.verts[i][1]} ${m.verts[i][2]}`);
      out.push("    endloop", "  endfacet");
    }
    out.push(`endsolid ${nm}`);
    return enc.encode(out.join("\n") + "\n");
  }
  const buf = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(buf.buffer);
  buf.set(enc.encode("Binary STL written by tools.katr.es").subarray(0, 80), 0);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    const n = norm(t);
    dv.setFloat32(o, n[0], true); dv.setFloat32(o + 4, n[1], true); dv.setFloat32(o + 8, n[2], true);
    t.forEach((idx, k) => {
      const b = o + 12 + k * 12;
      dv.setFloat32(b, m.verts[idx][0], true);
      dv.setFloat32(b + 4, m.verts[idx][1], true);
      dv.setFloat32(b + 8, m.verts[idx][2], true);
    });
  });
  return buf;
}

export function meshToSheets(m){
  const s = meshStats(m);
  return [
    { name: "vertices", headers: ["index","x","y","z"],
      rows: m.verts.map((v, i) => [String(i), String(v[0]), String(v[1]), String(v[2])]) },
    { name: "faces", headers: ["index","sides","v1","v2","v3","v4"],
      rows: m.faces.map((f, i) => [String(i), String(f.length),
        ...[0,1,2,3].map(k => f[k] === undefined ? "" : String(f[k]))]) },
    { name: "summary", headers: ["property","value"], rows: [
      ["name", m.name || "mesh"],
      ["vertices", String(m.verts.length)],
      ["faces", String(m.faces.length)],
      ["triangles", String(triangulate(m.faces).length)],
      ["min x", String(s.lo[0])], ["min y", String(s.lo[1])], ["min z", String(s.lo[2])],
      ["max x", String(s.hi[0])], ["max y", String(s.hi[1])], ["max z", String(s.hi[2])],
      ["width", String(s.size[0])], ["height", String(s.size[1])], ["depth", String(s.size[2])]
    ] }
  ];
}

export function meshToCanvas(m, opts){
  const size = Math.max(64, Math.min(4096, +(opts.meshSize || 720)));
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = opts.imgBg || "#ffffff";
  ctx.fillRect(0, 0, size, size);
  const st = meshStats(m);
  const scale = 0.82 * size / Math.max(st.size[0], st.size[1], st.size[2], 1e-9);
  const cx = (st.lo[0] + st.hi[0]) / 2, cy = (st.lo[1] + st.hi[1]) / 2, cz = (st.lo[2] + st.hi[2]) / 2;
  const ay = 0.6, ax = 0.45;
  const proj = v => {
    let x = v[0] - cx, y = v[1] - cy, z = v[2] - cz;
    let x1 = x * Math.cos(ay) + z * Math.sin(ay);
    let z1 = -x * Math.sin(ay) + z * Math.cos(ay);
    let y1 = y * Math.cos(ax) - z1 * Math.sin(ax);
    let z2 = y * Math.sin(ax) + z1 * Math.cos(ax);
    return [size / 2 + x1 * scale, size / 2 - y1 * scale, z2];
  };
  const tris = triangulate(m.faces).map(t => {
    const p = t.map(i => proj(m.verts[i]));
    return { p, depth: (p[0][2] + p[1][2] + p[2][2]) / 3 };
  });
  tris.sort((a, b) => a.depth - b.depth);
  for (const t of tris){
    const [a, b, d] = t.p;
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - a[0], vy = d[1] - a[1];
    const facing = ux * vy - uy * vx;
    const shade = Math.max(0, Math.min(1, 0.35 + Math.abs(facing) / (scale * scale * 1.2)));
    const g = Math.round(70 + shade * 150);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  if (!tris.length){
    ctx.fillStyle = "#333";
    for (const v of m.verts.slice(0, 20000)){
      const p = proj(v);
      ctx.fillRect(p[0] - 1, p[1] - 1, 2, 2);
    }
  }
  return c;
}
