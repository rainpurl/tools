// More 3D formats: PLY, binary glTF and 3MF.

import { ZipReader } from "./containers.js";
import { triangulate } from "./mesh.js";
import { concatBytes, enc, latin1, utf8 } from "./util.js";

/* ---- PLY ---------------------------------------------------------------- */

const PLY_SIZE = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

export function plyDecode(u8, name){
  // the header is text, even when the body is binary
  let end = -1;
  for (let i = 0; i < Math.min(u8.length, 1 << 16); i++){
    if (u8[i] === 0x65 && latin1.decode(u8.subarray(i, i + 10)) === "end_header"){
      end = i + 10;
      while (end < u8.length && u8[end] !== 0x0a) end++;
      end++;
      break;
    }
  }
  if (end < 0) throw new Error("this PLY file has no header end");
  const header = latin1.decode(u8.subarray(0, end)).split(/\r?\n/).map(l => l.trim());
  let format = "ascii";
  const elements = [];
  for (const line of header){
    const t = line.split(/\s+/);
    if (t[0] === "format") format = t[1];
    else if (t[0] === "element") elements.push({ name: t[1], count: +t[2], props: [] });
    else if (t[0] === "property" && elements.length){
      const el = elements[elements.length - 1];
      if (t[1] === "list") el.props.push({ list: true, countType: t[2], type: t[3], name: t[4] });
      else el.props.push({ type: t[1], name: t[2] });
    }
  }
  const verts = [], faces = [];
  const take = (el, values) => {
    if (el.name === "vertex") verts.push([values.x || 0, values.y || 0, values.z || 0]);
    else if (el.name === "face"){
      const idx = values.vertex_indices || values.vertex_index;
      if (idx && idx.length >= 3) faces.push(idx);
    }
  };
  if (format === "ascii"){
    const lines = utf8.decode(u8.subarray(end)).split(/\r?\n/);
    let li = 0;
    for (const el of elements){
      for (let n = 0; n < el.count && li < lines.length; n++){
        const t = lines[li++].trim().split(/\s+/).map(Number);
        const values = {};
        let k = 0;
        for (const p of el.props){
          if (p.list){ const c = t[k++]; values[p.name] = t.slice(k, k + c); k += c; }
          else values[p.name] = t[k++];
        }
        take(el, values);
      }
    }
  } else {
    const le = format === "binary_little_endian";
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = end;
    const read = type => {
      const size = PLY_SIZE[type];
      if (!size || p + size > u8.length) throw new Error("this PLY file is cut short or uses an unknown type");
      let v;
      switch (type){
        case "char": case "int8": v = dv.getInt8(p); break;
        case "uchar": case "uint8": v = dv.getUint8(p); break;
        case "short": case "int16": v = dv.getInt16(p, le); break;
        case "ushort": case "uint16": v = dv.getUint16(p, le); break;
        case "int": case "int32": v = dv.getInt32(p, le); break;
        case "uint": case "uint32": v = dv.getUint32(p, le); break;
        case "float": case "float32": v = dv.getFloat32(p, le); break;
        default: v = dv.getFloat64(p, le);
      }
      p += size;
      return v;
    };
    for (const el of elements){
      for (let n = 0; n < el.count; n++){
        const values = {};
        for (const pr of el.props){
          if (pr.list){ const c = read(pr.countType); const a = []; for (let k = 0; k < c; k++) a.push(read(pr.type)); values[pr.name] = a; }
          else values[pr.name] = read(pr.type);
        }
        take(el, values);
      }
    }
  }
  if (!verts.length) throw new Error("this PLY file has no vertices");
  return { name, verts, faces };
}

export function meshToPly(m){
  const head = enc.encode(`ply\nformat binary_little_endian 1.0\ncomment written by tools.katr.es\nelement vertex ${m.verts.length}\n` +
    `property float x\nproperty float y\nproperty float z\nelement face ${m.faces.length}\nproperty list uchar int vertex_indices\nend_header\n`);
  const vb = new Uint8Array(m.verts.length * 12);
  const vdv = new DataView(vb.buffer);
  m.verts.forEach((v, i) => { vdv.setFloat32(i * 12, v[0], true); vdv.setFloat32(i * 12 + 4, v[1], true); vdv.setFloat32(i * 12 + 8, v[2], true); });
  const fb = new Uint8Array(m.faces.reduce((a, f) => a + 1 + Math.min(255, f.length) * 4, 0));
  const fdv = new DataView(fb.buffer);
  let p = 0;
  for (const f of m.faces){
    const n = Math.min(255, f.length);
    fb[p++] = n;
    for (let k = 0; k < n; k++){ fdv.setInt32(p, f[k], true); p += 4; }
  }
  return concatBytes([head, vb, fb]);
}

/* ---- binary glTF -------------------------------------------------------- */

const mat = {
  mul: (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; },
  ident: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  trs: (t, q, s) => {
    const [x, y, z, w] = q, [sx, sy, sz] = s;
    return [
      (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
      (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
      (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      t[0], t[1], t[2], 1
    ];
  }
};

export function glbDecode(u8, name){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a binary glTF file");
  let json = null, bin = null;
  for (let p = 12; p + 8 <= u8.length;){
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(utf8.decode(u8.subarray(p + 8, p + 8 + len)));
    else if (type === 0x004e4942) bin = u8.subarray(p + 8, p + 8 + len);
    p += 8 + len + ((4 - len % 4) % 4);
  }
  if (!json || !bin) throw new Error("this glTF file keeps its data in separate files, which cannot be read here");
  const bdv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const COMP = { 5120: [1, "getInt8"], 5121: [1, "getUint8"], 5122: [2, "getInt16"], 5123: [2, "getUint16"], 5125: [4, "getUint32"], 5126: [4, "getFloat32"] };
  const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const accessor = i => {
    const a = json.accessors[i], view = json.bufferViews[a.bufferView];
    const [size, fn] = COMP[a.componentType], width = WIDTH[a.type] || 1;
    const stride = view.byteStride || size * width;
    const base = (view.byteOffset || 0) + (a.byteOffset || 0);
    const out = [];
    for (let n = 0; n < a.count; n++){
      const row = [];
      for (let k = 0; k < width; k++) row.push(bdv[fn](base + n * stride + k * size, true));
      out.push(width === 1 ? row[0] : row);
    }
    return out;
  };
  const verts = [], faces = [];
  const addMesh = (mi, m) => {
    for (const prim of json.meshes[mi].primitives || []){
      if (prim.mode !== undefined && prim.mode !== 4) continue;         // triangles only
      if (prim.attributes.POSITION === undefined) continue;
      const base = verts.length;
      for (const v of accessor(prim.attributes.POSITION)){
        verts.push([m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]]);
      }
      const idx = prim.indices !== undefined ? accessor(prim.indices) : Array.from({ length: verts.length - base }, (_, k) => k);
      for (let k = 0; k + 2 < idx.length; k += 3) faces.push([base + idx[k], base + idx[k + 1], base + idx[k + 2]]);
    }
  };
  const visit = (ni, parent, depth) => {
    const node = json.nodes[ni];
    if (!node || depth > 64) return;
    const local = node.matrix || mat.trs(node.translation || [0, 0, 0], node.rotation || [0, 0, 0, 1], node.scale || [1, 1, 1]);
    const world = mat.mul(parent, local);
    if (node.mesh !== undefined) addMesh(node.mesh, world);
    for (const c of node.children || []) visit(c, world, depth + 1);
  };
  const scene = json.scenes && json.scenes[json.scene || 0];
  if (scene && scene.nodes) for (const n of scene.nodes) visit(n, mat.ident(), 0);
  else (json.meshes || []).forEach((_, i) => addMesh(i, mat.ident()));
  if (!verts.length) throw new Error("this glTF file has no triangle meshes");
  return { name, verts, faces };
}

export function meshToGlb(m){
  const tris = triangulate(m.faces);
  const pos = new Float32Array(m.verts.length * 3);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  m.verts.forEach((v, i) => {
    for (let c = 0; c < 3; c++){
      const x = Math.fround(v[c]);
      pos[i * 3 + c] = x;
      if (x < lo[c]) lo[c] = x;
      if (x > hi[c]) hi[c] = x;
    }
  });
  const idx = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => idx.set(t, i * 3));
  const json = {
    asset: { version: "2.0", generator: "tools.katr.es" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: m.name || "mesh" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: m.verts.length, type: "VEC3", min: lo, max: hi },
      { bufferView: 1, componentType: 5125, count: idx.length, type: "SCALAR" }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 }
    ],
    buffers: [{ byteLength: pos.byteLength + idx.byteLength }]
  };
  let jb = enc.encode(JSON.stringify(json));
  if (jb.length % 4) jb = concatBytes([jb, new Uint8Array(4 - jb.length % 4).fill(0x20)]);
  const bin = concatBytes([new Uint8Array(pos.buffer), new Uint8Array(idx.buffer)]);
  const head = new Uint8Array(12), jh = new Uint8Array(8), bh = new Uint8Array(8);
  const total = 12 + 8 + jb.length + 8 + bin.length;
  new DataView(head.buffer).setUint32(0, 0x46546c67, true);
  new DataView(head.buffer).setUint32(4, 2, true);
  new DataView(head.buffer).setUint32(8, total, true);
  new DataView(jh.buffer).setUint32(0, jb.length, true);
  new DataView(jh.buffer).setUint32(4, 0x4e4f534a, true);
  new DataView(bh.buffer).setUint32(0, bin.length, true);
  new DataView(bh.buffer).setUint32(4, 0x004e4942, true);
  return concatBytes([head, jh, jb, bh, bin]);
}

/* ---- 3MF ---------------------------------------------------------------- */

export async function threeMfDecode(blob, name){
  const z = new ZipReader(blob);
  await z.open();
  const entry = z.entries.find(e => /\.model$/i.test(e.name));
  if (!entry) throw new Error("this 3MF file has no model in it");
  const doc = new DOMParser().parseFromString(await z.text(entry), "application/xml");
  const verts = [], faces = [];
  for (const mesh of doc.getElementsByTagName("mesh")){
    const base = verts.length;
    for (const v of mesh.getElementsByTagName("vertex")) verts.push([+v.getAttribute("x") || 0, +v.getAttribute("y") || 0, +v.getAttribute("z") || 0]);
    for (const t of mesh.getElementsByTagName("triangle")) faces.push([base + +t.getAttribute("v1"), base + +t.getAttribute("v2"), base + +t.getAttribute("v3")]);
  }
  if (!verts.length) throw new Error("this 3MF file has no mesh in it");
  return { name, verts, faces };
}
