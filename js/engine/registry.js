// What each format is, which shared shapes it can become, and what can be built from them.

export const KINDS = {
  png:   { label:"PNG",       ext:["png"],                       hubs:["raster","bytes"] },
  jpeg:  { label:"JPEG",      ext:["jpg","jpeg","jpe","jfif"],   hubs:["raster","bytes"] },
  webp:  { label:"WebP",      ext:["webp"],                      hubs:["anim","raster","bytes"] },
  gif:   { label:"GIF",       ext:["gif"],                       hubs:["anim","raster","bytes"] },
  bmp:   { label:"BMP",       ext:["bmp","dib"],                 hubs:["raster","bytes"] },
  avif:  { label:"AVIF",      ext:["avif"],                      hubs:["anim","raster","bytes"] },
  ico:   { label:"ICO",       ext:["ico","cur"],                 hubs:["raster","bytes"] },
  svg:   { label:"SVG",       ext:["svg"],                       hubs:["raster","plain","bytes"] },
  eps:   { label:"EPS",       ext:["eps","epsf","epsi","ps","ai"], hubs:["raster","bytes"], module:"ghostscript" },
  heic:  { label:"HEIC",      ext:["heic","heif","hif"],         hubs:["raster","bytes"], module:"heif" },
  jxl:   { label:"JPEG XL",   ext:["jxl"],                       hubs:["raster","bytes"], module:"jxl" },
  dds:   { label:"DDS",       ext:["dds"],                       hubs:["raster","bytes"] },
  sgi:   { label:"SGI",       ext:["sgi","rgb","rgba","bw","int","inta"], hubs:["raster","bytes"] },
  ras:   { label:"Sun raster", ext:["ras","sun","rs","im1","im8","im24","im32"], hubs:["raster","bytes"] },
  hdr:   { label:"Radiance HDR", ext:["hdr","rgbe"],             hubs:["raster","bytes"] },
  pfm:   { label:"PFM",       ext:["pfm"],                       hubs:["raster","bytes"] },
  farbfeld:{ label:"farbfeld", ext:["ff"],                      hubs:["raster","bytes"] },
  wbmp:  { label:"WBMP",      ext:["wbmp"],                      hubs:["raster","bytes"] },
  xbm:   { label:"XBM",       ext:["xbm"],                       hubs:["raster","plain","bytes"] },
  xpm:   { label:"XPM",       ext:["xpm"],                       hubs:["raster","plain","bytes"] },
  tiff:  { label:"TIFF",      ext:["tif","tiff"],                hubs:["raster","bytes"] },
  tga:   { label:"TGA",       ext:["tga","targa","icb","vda","vst"], hubs:["raster","bytes"] },
  pnm:   { label:"Netpbm",    ext:["ppm","pgm","pbm","pnm"],     hubs:["raster","bytes"] },
  qoi:   { label:"QOI",       ext:["qoi"],                       hubs:["raster","bytes"] },
  pcx:   { label:"PCX",       ext:["pcx"],                       hubs:["raster","bytes"] },
  icns:  { label:"ICNS",      ext:["icns"],                      hubs:["raster","icons","bytes"] },
  psd:   { label:"PSD",       ext:["psd","psb"],                 hubs:["raster","bytes"] },
  obj:   { label:"OBJ",       ext:["obj"],                       hubs:["mesh","table","plain","bytes"] },
  off:   { label:"OFF",       ext:["off"],                       hubs:["mesh","table","plain","bytes"] },
  stl:   { label:"STL",       ext:["stl"],                       hubs:["mesh","table","bytes"] },

  csv:   { label:"CSV",       ext:["csv"],                       hubs:["table","plain","bytes"] },
  tsv:   { label:"TSV",       ext:["tsv","tab"],                 hubs:["table","plain","bytes"] },
  json:  { label:"JSON",      ext:["json"],                      hubs:["table","tree","plain","bytes"] },
  jsonl: { label:"JSONL",     ext:["jsonl","ndjson"],            hubs:["table","plain","bytes"] },
  yaml:  { label:"YAML",      ext:["yaml","yml"],                hubs:["tree","table","plain","bytes"] },
  xml:   { label:"XML",       ext:["xml","plist","atom","rss","rdf","mathml","smil",
                                   "xspf","vml","wordml","apml","inkml","sgml"], hubs:["tree","table","plain","bytes"] },
  toml:  { label:"TOML",      ext:["toml"],                      hubs:["tree","table","plain","bytes"] },
  ini:   { label:"INI",       ext:["ini","cfg","conf","properties","env"], hubs:["tree","table","plain","bytes"] },
  jsonc: { label:"JSONC",     ext:["jsonc","json5"],              hubs:["tree","table","plain","bytes"] },
  har:   { label:"HAR",       ext:["har"],                       hubs:["table","tree","plain","bytes"] },
  gpx:   { label:"GPX",       ext:["gpx"],                       hubs:["table","tree","plain","bytes"] },
  kml:   { label:"KML",       ext:["kml"],                       hubs:["table","tree","plain","bytes"] },
  kmz:   { label:"KMZ",       ext:["kmz"],                       hubs:["table","archive","bytes"] },
  geojson:{ label:"GeoJSON",  ext:["geojson"],                   hubs:["table","tree","plain","bytes"] },
  dbf:   { label:"dBase",     ext:["dbf"],                       hubs:["table","bytes"] },
  sqlite:{ label:"SQLite",    ext:["sqlite","sqlite3","db","db3"], hubs:["table","bytes"] },
  msgpack:{ label:"MessagePack", ext:["msgpack","mpk"],          hubs:["tree","table","bytes"] },
  cbor:  { label:"CBOR",      ext:["cbor"],                      hubs:["tree","table","bytes"] },
  bson:  { label:"BSON",      ext:["bson"],                      hubs:["tree","table","bytes"] },
  bplist:{ label:"Binary plist", ext:["bplist"],                hubs:["tree","table","bytes"] },

  md:    { label:"Markdown",  ext:["md","markdown","mdown","mkd"], hubs:["rich","plain","bytes"] },
  html:  { label:"HTML",      ext:["html","htm","xhtml","sht","shtm","shtml"], hubs:["rich","table","plain","bytes"] },
  txt:   { label:"Text",      ext:["txt","text","log","nfo","asc"], hubs:["rich","plain","bytes"] },
  code:  { label:"Code",      ext:["js","mjs","cjs","ts","tsx","jsx","vue","py","rb","go","rs",
                                   "c","h","cc","cpp","hpp","cs","java","kt","swift","php","pl",
                                   "lua","r","scala","sh","bash","zsh","bat","cmd","ps1",
                                   "css","scss","less","sql","graphql","dockerfile","makefile",
                                   "diff","patch"], hubs:["rich","plain","bytes"] },
  rtf:   { label:"RTF",       ext:["rtf"],                       hubs:["rich","bytes"] },
  docx:  { label:"DOCX",      ext:["docx","docm"],                hubs:["rich","bytes"] },
  pptx:  { label:"PPTX",      ext:["pptx","pptm"],                hubs:["rich","bytes"] },
  xlsx:  { label:"XLSX",      ext:["xlsx","xlsm"],                hubs:["table","bytes"] },
  odt:   { label:"ODT",       ext:["odt","ott"],                  hubs:["rich","bytes"] },
  ods:   { label:"ODS",       ext:["ods","ots"],                  hubs:["table","bytes"] },
  odp:   { label:"ODP",       ext:["odp","otp"],                  hubs:["rich","bytes"] },
  epub:  { label:"EPUB",      ext:["epub"],                      hubs:["rich","bytes"] },
  mobi:  { label:"MOBI",      ext:["mobi","prc","azw","azw3","pdb"], hubs:["rich","bytes"] },
  fb2:   { label:"FB2",       ext:["fb2"],                       hubs:["rich","bytes"] },
  ipynb: { label:"Notebook",  ext:["ipynb"],                      hubs:["rich","bytes"] },
  mhtml: { label:"MHTML",     ext:["mht","mhtml","mhtm"],        hubs:["rich","bytes"] },

  zip:   { label:"ZIP",       ext:["zip"],                       hubs:["archive","bytes"] },
  tar:   { label:"TAR",       ext:["tar"],                       hubs:["archive","bytes"] },
  gz:    { label:"Gzip",      ext:["gz"],                        hubs:["archive","bytes"] },
  tgz:   { label:"TGZ",       ext:["tgz"],                       hubs:["archive","bytes"] },

  eml:   { label:"EML",       ext:["eml","mbox"],                hubs:["rich","bytes"] },
  ics:   { label:"ICS",       ext:["ics","ical","ifb"],          hubs:["table","plain","bytes"] },
  vcf:   { label:"vCard",     ext:["vcf","vcard"],               hubs:["table","plain","bytes"] },

  srt:   { label:"SRT",       ext:["srt"],                       hubs:["cues","plain","bytes"] },
  vtt:   { label:"WebVTT",    ext:["vtt"],                       hubs:["cues","plain","bytes"] },
  ass:   { label:"ASS",       ext:["ass","ssa"],                 hubs:["cues","plain","bytes"] },
  subv:  { label:"MicroDVD",  ext:["sub"],                       hubs:["cues","plain","bytes"] },
  sbv:   { label:"SBV",       ext:["sbv"],                       hubs:["cues","plain","bytes"] },
  lrc:   { label:"LRC",       ext:["lrc"],                       hubs:["cues","plain","bytes"] },
  ttml:  { label:"TTML",      ext:["ttml","dfxp"],               hubs:["cues","plain","bytes"] },

  audio: { label:"Audio",     ext:["mp3","m4a","aac","ogg","oga","opus","flac","wav","wave","weba",
                                   "aif","aiff","aifc","au","snd","caf","mka",
                                   "mp4","m4v","mov","webm","mkv","avi"], hubs:["audio","bytes"] },
  pdf:   { label:"PDF",       ext:["pdf"],                       hubs:["bytes"], module:"pdfjs", moduleHubs:["pdf"] },
  bin:   { label:"Binary",    ext:[],                            hubs:["bytes"] }
};

export const VECTOR_KINDS = new Set(["svg", "eps"]);

export const TARGETS = {
  png:   { label:"PNG",       ext:"png",   via:["raster","mesh","pdf"],    group:"Image" },
  jpeg:  { label:"JPEG",      ext:"jpg",   via:["raster","mesh","pdf"],    group:"Image" },
  webp:  { label:"WebP",      ext:"webp",  via:["raster","mesh","pdf"],    group:"Image" },
  frames:{ label:"Frames",    ext:"png",   via:["anim"],                   group:"Image", multi:true },
  bmp:   { label:"BMP",       ext:"bmp",   via:["raster"],                 group:"Image" },
  ico:   { label:"ICO",       ext:"ico",   via:["raster"],                 group:"Image" },
  tiff:  { label:"TIFF",      ext:"tif",   via:["raster"],                 group:"Image" },
  xbm:   { label:"XBM",       ext:"xbm",   via:["raster"],                 group:"Image" },
  eps:   { label:"EPS",       ext:"eps",   via:["raster"],                 group:"Image" },
  svg:   { label:"SVG, embedded image", ext:"svg", via:["raster"],        group:"Image" },
  obj:   { label:"OBJ",       ext:"obj",   via:["mesh"],                   group:"Mesh" },
  off:   { label:"OFF",       ext:"off",   via:["mesh"],                   group:"Mesh" },
  stl:   { label:"STL",       ext:"stl",   via:["mesh"],                   group:"Mesh" },
  tga:   { label:"TGA",       ext:"tga",   via:["raster"],                 group:"Image" },
  ppm:   { label:"PPM",       ext:"ppm",   via:["raster"],                 group:"Image" },
  pgm:   { label:"PGM",       ext:"pgm",   via:["raster"],                 group:"Image" },
  qoi:   { label:"QOI",       ext:"qoi",   via:["raster"],                 group:"Image" },
  gif:   { label:"GIF",       ext:"gif",   via:["anim","raster"],          group:"Image" },

  csv:   { label:"CSV",       ext:"csv",   via:["table","cues"],           group:"Data" },
  tsv:   { label:"TSV",       ext:"tsv",   via:["table","cues"],           group:"Data" },
  json:  { label:"JSON",      ext:"json",  via:["tree","table","cues"],    group:"Data" },
  jsonl: { label:"JSONL",     ext:"jsonl", via:["table"],                  group:"Data" },
  yaml:  { label:"YAML",      ext:"yaml",  via:["tree","table"],           group:"Data" },
  xml:   { label:"XML",       ext:"xml",   via:["tree","table"],           group:"Data" },
  xlsx:  { label:"XLSX",      ext:"xlsx",  via:["table"],                  group:"Data" },
  toml:  { label:"TOML",      ext:"toml",  via:["tree"],                   group:"Data" },
  ini:   { label:"INI",       ext:"ini",   via:["tree"],                   group:"Data" },
  sql:   { label:"SQL",       ext:"sql",   via:["table"],                  group:"Data" },
  msgpack:{ label:"MessagePack", ext:"msgpack", via:["tree","table"],     group:"Data" },
  cbor:  { label:"CBOR",      ext:"cbor",  via:["tree","table"],           group:"Data" },
  geojson:{ label:"GeoJSON",  ext:"geojson", via:["table"],                group:"Geo" },
  gpx:   { label:"GPX",       ext:"gpx",   via:["table"],                  group:"Geo" },
  kml:   { label:"KML",       ext:"kml",   via:["table"],                  group:"Geo" },
  ics:   { label:"ICS",       ext:"ics",   via:["table"],                  group:"Data" },
  vcf:   { label:"vCard",     ext:"vcf",   via:["table"],                  group:"Data" },

  md:    { label:"Markdown",  ext:"md",    via:["rich","table","pdf","cues"],     group:"Document" },
  html:  { label:"HTML",      ext:"html",  via:["rich","table","pdf","cues"],     group:"Document" },
  txt:   { label:"Text",      ext:"txt",   via:["rich","table","cues","tree","pdf","plain"], group:"Document" },
  rtf:   { label:"RTF",       ext:"rtf",   via:["rich","pdf","cues"],             group:"Document" },
  docx:  { label:"DOCX",      ext:"docx",  via:["rich","pdf","cues"],             group:"Document" },
  doc:   { label:"DOC",       ext:"doc",   via:["rich","pdf","cues"],             group:"Document" },
  pdf:   { label:"PDF",       ext:"pdf",   via:["raster","rich","mesh","cues"],   group:"Document" },
  odt:   { label:"ODT",       ext:"odt",   via:["rich","pdf","cues"],             group:"Document" },
  epub:  { label:"EPUB",      ext:"epub",  via:["rich","pdf","cues"],             group:"Document" },
  latex: { label:"LaTeX",     ext:"tex",   via:["rich","pdf","cues"],      group:"Document" },
  adoc:  { label:"AsciiDoc",  ext:"adoc",  via:["rich","pdf","cues"],      group:"Document" },
  rst:   { label:"reST",      ext:"rst",   via:["rich","pdf","cues"],      group:"Document" },
  bbcode:{ label:"BBCode",    ext:"bbcode.txt", via:["rich","pdf","cues"], group:"Document" },
  ods:   { label:"ODS",       ext:"ods",   via:["table"],                  group:"Data" },

  srt:   { label:"SRT",       ext:"srt",   via:["cues"],                   group:"Subtitles" },
  vtt:   { label:"WebVTT",    ext:"vtt",   via:["cues"],                   group:"Subtitles" },
  ass:   { label:"ASS",       ext:"ass",   via:["cues"],                   group:"Subtitles" },
  subv:  { label:"MicroDVD",  ext:"sub",   via:["cues"],                   group:"Subtitles" },
  sbv:   { label:"SBV",       ext:"sbv",   via:["cues"],                   group:"Subtitles" },
  lrc:   { label:"LRC",       ext:"lrc",   via:["cues"],                   group:"Subtitles" },
  ttml:  { label:"TTML",      ext:"ttml",  via:["cues"],                   group:"Subtitles" },

  wav:   { label:"WAV",       ext:"wav",   via:["audio"],                  group:"Audio" },
  aiff:  { label:"AIFF",      ext:"aiff",  via:["audio"],                  group:"Audio" },
  pcm:   { label:"Raw PCM",   ext:"pcm",   via:["audio"],                  group:"Audio" },
  opus:  { label:"Opus",      ext:"opus",  via:["audio"],                  group:"Audio" },
  aac:   { label:"AAC",       ext:"aac",   via:["audio"],                  group:"Audio" },

  zip:   { label:"ZIP",       ext:"zip",   via:["archive","bytes"],        group:"Archive" },
  tar:   { label:"TAR",       ext:"tar",   via:["archive","bytes"],        group:"Archive" },
  tgz:   { label:"TGZ",       ext:"tgz",   via:["archive","bytes"],        group:"Archive" },
  gz:    { label:"Gzip",      ext:"gz",    via:["bytes"],                  group:"Archive" },
  files: { label:"Extract",   ext:"",      via:["archive","icons","anim","pdf"], group:"Archive", multi:true },

  base64:{ label:"Base64",    ext:"b64.txt",     via:["bytes"],            group:"Encoding" },
  base32:{ label:"Base32",    ext:"b32.txt",     via:["bytes"],            group:"Encoding" },
  urlenc:{ label:"URL encoded", ext:"urlenc.txt", via:["bytes"],           group:"Encoding" },
  qp:    { label:"Quoted printable", ext:"qp.txt", via:["bytes"],          group:"Encoding" },
  hex:   { label:"Hex",       ext:"hex.txt",     via:["bytes"],            group:"Encoding" },
  datauri:{ label:"Data URI", ext:"datauri.txt", via:["bytes"],            group:"Encoding" }
};

export const GROUP_ORDER = ["Image","Document","Data","Geo","Mesh","Subtitles","Audio","Archive","Encoding"];

export const EXT2KIND = (() => {
  const m = new Map();
  for (const [k, v] of Object.entries(KINDS)) for (const e of v.ext) m.set(e, k);
  return m;
})();

export const MIME = {
  png:"image/png", jpeg:"image/jpeg", webp:"image/webp", bmp:"image/bmp", ico:"image/x-icon",
  tiff:"image/tiff", tga:"image/x-tga", xbm:"image/x-xbitmap",
  eps:"application/postscript", svg:"image/svg+xml",
  obj:"model/obj", off:"model/off", stl:"model/stl", ppm:"image/x-portable-pixmap", pgm:"image/x-portable-graymap",
  qoi:"image/qoi", gif:"image/gif", frames:"image/png",
  csv:"text/csv", tsv:"text/tab-separated-values", json:"application/json", jsonl:"application/x-ndjson",
  yaml:"text/yaml", xml:"application/xml", md:"text/markdown", html:"text/html", txt:"text/plain",
  rtf:"application/rtf", doc:"application/msword", docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf:"application/pdf",
  odt:"application/vnd.oasis.opendocument.text", ods:"application/vnd.oasis.opendocument.spreadsheet",
  epub:"application/epub+zip",
  srt:"text/plain", vtt:"text/vtt",
  ass:"text/x-ssa", subv:"text/plain", sbv:"text/plain", lrc:"text/plain",
  ttml:"application/ttml+xml", latex:"application/x-tex", adoc:"text/plain",
  rst:"text/x-rst", bbcode:"text/plain", wav:"audio/wav", zip:"application/zip",
  tar:"application/x-tar", tgz:"application/gzip", gz:"application/gzip",
  base64:"text/plain", hex:"text/plain", datauri:"text/plain",
  base32:"text/plain", urlenc:"text/plain", qp:"text/plain",
  aiff:"audio/aiff", pcm:"application/octet-stream", opus:"audio/ogg", aac:"audio/aac",
  toml:"application/toml", ini:"text/plain", sql:"application/sql",
  msgpack:"application/msgpack", cbor:"application/cbor",
  geojson:"application/geo+json", gpx:"application/gpx+xml",
  kml:"application/vnd.google-earth.kml+xml", ics:"text/calendar", vcf:"text/vcard"
};

export function hubsOf(kind){
  const k = KINDS[kind] || KINDS.bin;
  return k.hubs.concat(k.moduleHubs || []);
}

export function routeFor(kind, target){
  const def = TARGETS[target];
  if (!def) return null;
  const hubs = hubsOf(kind);
  for (const h of def.via) if (hubs.includes(h)) return h;
  return null;
}

export const COMBINE = {
  pdf:  ["raster","rich"],
  gif:  ["anim","raster"],
  xlsx: ["table"], ods: ["table"], csv: ["table"], tsv: ["table"],
  json: ["table"], sql: ["table"],
  epub: ["rich"], docx: ["rich"], doc: ["rich"], rtf: ["rich"], odt: ["rich"], md: ["rich"], html: ["rich"], txt: ["rich"],
  latex: ["rich"], adoc: ["rich"], rst: ["rich"], bbcode: ["rich"],
  zip:  ["bytes"], tar: ["bytes"], tgz: ["bytes"]
};

export function canCombine(items, target){
  const hubs = COMBINE[target];
  if (!hubs || items.length < 2) return null;
  for (const hub of hubs){
    const eligible = items.filter(it => hubsOf(it.kind).includes(hub));
    if (eligible.length >= 2 && TARGETS[target].via.includes(hub)) return { hub, eligible };
  }
  return null;
}
