// GPX, KML and GeoJSON.

import { ZipReader } from "./containers.js";
import { coerce, scalar } from "./table.js";
import { parseXml } from "./tree.js";
import { xmlEsc } from "./util.js";

export function gpxToSheets(text){
  const doc = parseXml(text, "gpx");
  const kid = (el, tag) => {
    const n = el.getElementsByTagName(tag)[0];
    return n && n.parentNode === el ? n.textContent.trim() : "";
  };
  const rows = [];
  const point = (el, type, group) => rows.push([
    type, group,
    el.getAttribute("lat") || "", el.getAttribute("lon") || "",
    kid(el, "ele"), kid(el, "time"), kid(el, "name"), kid(el, "desc"), kid(el, "sym")
  ]);
  for (const w of doc.getElementsByTagName("wpt")) point(w, "waypoint", "");
  for (const t of doc.getElementsByTagName("trk")){
    const name = kid(t, "name");
    let seg = 0;
    for (const s of t.getElementsByTagName("trkseg")){
      seg++;
      for (const p of s.getElementsByTagName("trkpt")) point(p, "trackpoint", name || "track " + seg);
    }
  }
  for (const r of doc.getElementsByTagName("rte")){
    const name = kid(r, "name");
    for (const p of r.getElementsByTagName("rtept")) point(p, "routepoint", name);
  }
  if (!rows.length) throw new Error("no waypoints, tracks or routes found");
  return [{ name: "Points", headers: ["type","group","lat","lon","ele","time","name","desc","sym"], rows }];
}

export function kmlDocToSheets(doc){
  const rows = [];
  const firstText = (el, tag) => {
    const n = el.getElementsByTagName(tag)[0];
    return n ? n.textContent.trim() : "";
  };
  for (const pm of doc.getElementsByTagName("Placemark")){
    const geomEl = ["Point","LineString","Polygon","LinearRing","Track"]
      .map(t => pm.getElementsByTagName(t)[0]).find(Boolean);
    const geom = geomEl ? geomEl.tagName : "";
    const coordText = firstText(pm, "coordinates");
    const pts = coordText.split(/\s+/).filter(Boolean).map(c => c.split(","));
    const first = pts[0] || [];
    const ext = {};
    for (const d of pm.getElementsByTagName("Data")){
      const k = d.getAttribute("name");
      if (k) ext[k] = firstText(d, "value");
    }
    for (const sd of pm.getElementsByTagName("SimpleData")){
      const k = sd.getAttribute("name");
      if (k) ext[k] = sd.textContent.trim();
    }
    rows.push({
      name: firstText(pm, "name"),
      description: firstText(pm, "description").replace(/\s+/g, " "),
      geometry: geom,
      lat: first[1] || "", lon: first[0] || "", ele: first[2] || "",
      points: String(pts.length),
      ext
    });
  }
  if (!rows.length) throw new Error("no Placemark elements found");
  const extKeys = [];
  for (const r of rows) for (const k of Object.keys(r.ext)) if (!extKeys.includes(k)) extKeys.push(k);
  const headers = ["name","description","geometry","lat","lon","ele","points", ...extKeys];
  return [{ name: "Placemarks", headers,
    rows: rows.map(r => headers.map(h => (h in r.ext ? r.ext[h] : r[h]) ?? "")) }];
}

export function kmlToSheets(text){ return kmlDocToSheets(parseXml(text, "kml")); }

export async function kmzToSheets(blob){
  const z = new ZipReader(blob);
  await z.open();
  const e = z.find("doc.kml") || z.entries.find(x => /\.kml$/i.test(x.name));
  if (!e) throw new Error("no kml file inside this kmz");
  return kmlToSheets(await z.text(e));
}

export function geojsonToSheets(text){
  const g = JSON.parse(text);
  const feats = g.type === "FeatureCollection" ? (g.features || [])
    : g.type === "Feature" ? [g]
    : g.type ? [{ type: "Feature", properties: {}, geometry: g }] : [];
  if (!feats.length) throw new Error("no GeoJSON features found");
  const firstCoord = geom => {
    if (!geom) return [];
    let c = geom.coordinates;
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    return Array.isArray(c) ? c : [];
  };
  const countCoords = geom => {
    let n = 0;
    const walk = c => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === "number"){ n++; return; }
      c.forEach(walk);
    };
    walk(geom && geom.coordinates);
    return n;
  };
  const propKeys = [];
  for (const f of feats) for (const k of Object.keys(f.properties || {})) if (!propKeys.includes(k)) propKeys.push(k);
  const headers = ["geometry","lon","lat","ele","points", ...propKeys];
  const rows = feats.map(f => {
    const c = firstCoord(f.geometry);
    const base = {
      geometry: (f.geometry || {}).type || "",
      lon: c[0] ?? "", lat: c[1] ?? "", ele: c[2] ?? "",
      points: String(countCoords(f.geometry))
    };
    return headers.map(h => h in base ? base[h] : scalar((f.properties || {})[h]));
  });
  return [{ name: "Features", headers, rows }];
}

export function findCols(sheet, names){
  const idx = {};
  sheet.headers.forEach((h, i) => {
    const k = String(h).toLowerCase().replace(/[^a-z]/g, "");
    for (const [want, alts] of Object.entries(names)){
      if (idx[want] === undefined && alts.includes(k)) idx[want] = i;
    }
  });
  return idx;
}

export const GEO_COLS = {
  lat: ["lat","latitude","y"], lon: ["lon","lng","long","longitude","x"],
  ele: ["ele","elev","elevation","alt","altitude","z"],
  name: ["name","title","label"], desc: ["desc","description","note","notes"],
  time: ["time","timestamp","date","datetime"]
};

export function sheetsToGeojson(sheets, pretty){
  const sh = sheets[0];
  const c = findCols(sh, GEO_COLS);
  if (c.lat === undefined || c.lon === undefined) throw new Error("needs latitude and longitude columns");
  const skip = new Set([c.lat, c.lon, c.ele]);
  const features = sh.rows.map(r => {
    const lon = parseFloat(r[c.lon]), lat = parseFloat(r[c.lat]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const coords = [lon, lat];
    const ele = c.ele !== undefined ? parseFloat(r[c.ele]) : NaN;
    if (Number.isFinite(ele)) coords.push(ele);
    const props = {};
    sh.headers.forEach((h, i) => { if (!skip.has(i) && r[i] !== "" && r[i] !== undefined) props[h] = coerce(r[i]); });
    return { type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: props };
  }).filter(Boolean);
  if (!features.length) throw new Error("no rows had usable coordinates");
  return JSON.stringify({ type: "FeatureCollection", features }, null, pretty === false ? 0 : 2) + "\n";
}

export function sheetsToGpx(sheets){
  const sh = sheets[0];
  const c = findCols(sh, GEO_COLS);
  if (c.lat === undefined || c.lon === undefined) throw new Error("needs latitude and longitude columns");
  const pts = sh.rows.map(r => {
    const lon = parseFloat(r[c.lon]), lat = parseFloat(r[c.lat]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const bits = [];
    const ele = c.ele !== undefined ? parseFloat(r[c.ele]) : NaN;
    if (Number.isFinite(ele)) bits.push(`<ele>${ele}</ele>`);
    if (c.time !== undefined && r[c.time]) bits.push(`<time>${xmlEsc(r[c.time])}</time>`);
    if (c.name !== undefined && r[c.name]) bits.push(`<name>${xmlEsc(r[c.name])}</name>`);
    if (c.desc !== undefined && r[c.desc]) bits.push(`<desc>${xmlEsc(r[c.desc])}</desc>`);
    return `  <wpt lat="${lat}" lon="${lon}">${bits.length ? "\n    " + bits.join("\n    ") + "\n  " : ""}</wpt>`;
  }).filter(Boolean);
  if (!pts.length) throw new Error("no rows had usable coordinates");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="convert.html" xmlns="http://www.topografix.com/GPX/1/1">
${pts.join("\n")}
</gpx>
`;
}

export function sheetsToKml(sheets){
  const sh = sheets[0];
  const c = findCols(sh, GEO_COLS);
  if (c.lat === undefined || c.lon === undefined) throw new Error("needs latitude and longitude columns");
  const skip = new Set([c.lat, c.lon, c.ele, c.name, c.desc]);
  const marks = sh.rows.map(r => {
    const lon = parseFloat(r[c.lon]), lat = parseFloat(r[c.lat]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const ele = c.ele !== undefined ? parseFloat(r[c.ele]) : NaN;
    const data = sh.headers.map((h, i) => (!skip.has(i) && r[i] !== "" && r[i] !== undefined)
      ? `        <Data name="${xmlEsc(h)}"><value>${xmlEsc(r[i])}</value></Data>` : "").filter(Boolean);
    return `    <Placemark>
      <name>${xmlEsc(c.name !== undefined ? r[c.name] || "" : "")}</name>
      <description>${xmlEsc(c.desc !== undefined ? r[c.desc] || "" : "")}</description>${data.length ? `
      <ExtendedData>
${data.join("\n")}
      </ExtendedData>` : ""}
      <Point><coordinates>${lon},${lat}${Number.isFinite(ele) ? "," + ele : ""}</coordinates></Point>
    </Placemark>`;
  }).filter(Boolean);
  if (!marks.length) throw new Error("no rows had usable coordinates");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
${marks.join("\n")}
  </Document>
</kml>
`;
}
