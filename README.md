# tools

File tools that run in the browser. Live at [tools.katr.es](https://tools.katr.es).

Files stay on the device. Nothing is uploaded. There is no server code and no build step.

## What is here

| Tab | What it does |
| --- | --- |
| Convert | Turns files into other formats. About 120 input formats, covering more than 400 file extensions, and about 100 outputs. |
| Images | Edits one image at a time: crop, rotate, flip, resize, remove a colour, remove a background. Opens GIFs and animated PNGs as a strip of frames: delete, keep, copy, reorder, reverse, retime or save single frames. |
| Batch | Resizes, compresses and renames many images in one run. Can hold each file under a size limit. |
| PDF | Reorders, removes, rotates, crops and merges pages. Saves losslessly or as page images. |
| Preview | Shows what a file holds, or says what can open it. Hands the file to the other tabs. |

Each tab starts with one box that takes files. The tools for a file show once it is loaded.

Drop files anywhere on the page, drop a whole folder, or paste from the clipboard. They go to the open tab.

## How it is built

Plain ES modules, served as they are.

```
index.html          all markup, so the page paints before any script runs
css/app.css
js/main.js          tabs, file intake, loads each tab on first open
js/ui/              one module per tab, plus shared page helpers in dom.js
js/engine/          formats and conversions, no page code
js/worker/          a small worker pool, the worker entry, and a second worker for ffmpeg and 7-Zip
```

Three things keep it quick:

1. **Each tab loads on first open.** The first paint needs the page, the stylesheet and about a dozen small modules. The converter itself (about 30 modules) is fetched when the page goes idle.
2. **Heavy work runs in workers.** Image decoding, resizing, encoding, archives and most data conversions run in a pool of up to four workers, several files at once. The page stays responsive and Stop works at once.
3. **Lists update in place.** A status change touches one row. PDF thumbnails are drawn once and reused.

Work that needs the document (HTML, XML, Office files, SVG, audio, pdf.js) cannot run in a worker. The worker reports this and the same job runs on the page instead.

### How a conversion works

Every format declares which shared shapes it can become: `raster`, `anim`, `table`, `tree`, `rich`, `cues`, `audio`, `av`, `mesh`, `font`, `archive`, `bytes`. Every target declares which shapes it can be written from. A conversion is one hop in and one hop out, so adding a format means writing one reader or one writer, and it then works with everything on the other side. `js/engine/registry.js` holds both lists.

### What it reads and writes

| Group | Reads | Writes |
| --- | --- | --- |
| Image | PNG, JPEG, WebP, GIF, APNG, AVIF, HEIC, JPEG XL, JPEG 2000, TIFF, BMP, ICO, ICNS, SVG, SVGZ, EPS, PS, AI, PSD, OpenRaster, Krita, TGA, DDS, EXR, DPX, HDR, QOI, PCX, PNM and more; the preview inside camera raw files (CR2, NEF, ARW, DNG and others) | PNG, JPEG, WebP, AVIF, JPEG XL, GIF, APNG, TIFF, BMP, ICO, ICNS, SVG, EPS, TGA, QOI, PPM, PGM, XBM |
| Video | MP4, MOV, WebM, MKV, AVI, WMV, FLV, MPEG, TS, 3GP, OGV, MXF and others | MP4, WebM, MOV, MKV, AVI, WMV, FLV, OGV, MPEG, GIF, frames, any audio format |
| Audio | MP3, M4A, AAC, OGG, Opus, FLAC, WAV, AIFF, WMA, AC3, AMR, APE and others | MP3, WAV, FLAC, M4A, OGG, Opus, AAC, AIFF, WMA, AC3 |
| Document | PDF, DOCX, DOC, RTF, ODT, PPTX, PPT, ODP, XPS, EPUB, MOBI, FB2, HTML, Markdown, notebooks, MHTML, Pages / Numbers / Keynote previews | PDF, DOCX, DOC, RTF, ODT, PPTX, EPUB, HTML, Markdown, text, LaTeX, AsciiDoc, reST |
| Data | CSV, TSV, XLSX, XLS, ODS, JSON, YAML, XML, TOML, INI, SQLite, Parquet, NumPy, DBF, MessagePack, CBOR, BSON, BibTeX, RIS | CSV, TSV, XLSX, ODS, JSON, JSONL, YAML, XML, TOML, INI, SQL, MessagePack, CBOR, BibTeX, RIS |
| Mail and calendar | EML, MSG, mbox, ICS, vCard | ICS, vCard |
| Geo | GPX, KML, KMZ, GeoJSON | GeoJSON, GPX, KML |
| Mesh | OBJ, OFF, STL, PLY, GLB, 3MF | OBJ, OFF, STL, PLY, GLB |
| Subtitles | SRT, WebVTT, ASS, MicroDVD, SBV, LRC, TTML | the same |
| Font | TTF, OTF, WOFF, WOFF2, TTC | TTF / OTF, WOFF, WOFF2, a specimen picture |
| Archive | ZIP, 7z, RAR, TAR, GZ, XZ, BZ2, Zstandard, CAB, ISO, DMG, WIM, DEB, RPM, MSI, comic archives and others | ZIP, 7z, TAR, TGZ, TAR.XZ, TAR.BZ2, GZ, XZ, BZ2 |

### PDF to Word

PDF to DOCX, DOC and RTF keeps the layout as real, editable Word content: fonts, sizes, colours, bold, italic, underline, alignment, indents, lists, tables with borders and shading, pictures, links, columns, and the running header and footer with a live page number. A PDF stores marks on a page, so paragraphs, tables and lists are worked out from positions. A scanned PDF holds only pictures of text, so its pages come through as pictures. The `.doc` output is rich text in a `.doc` file, which Word opens as a document.

### Optional downloads

A few formats need a large library. Each is fetched from a CDN only when a file needs it:

| For | Library | From |
| --- | --- | --- |
| PDF reading | pdf.js 3.11 | cdnjs |
| Video, audio outside the browser's own set, JPEG 2000, EXR, DPX | ffmpeg (WebAssembly, about 32 MB) | jsDelivr |
| 7z, RAR, XZ, BZ2, CAB, ISO and other archives | 7-Zip (WebAssembly) | jsDelivr |
| EPS, PostScript, AI | Ghostscript (WebAssembly) | jsDelivr |
| HEIC | heic2any | jsDelivr |
| AVIF and JPEG XL writing, JPEG XL reading | jSquash | jsDelivr |
| WOFF2 | wawoff2 | jsDelivr |
| Parquet | hyparquet | jsDelivr |
| Background removal by model | @imgly/background-removal | esm.sh |

These fetch code only. The file being worked on never leaves the browser.

### What it cannot do

Some formats have no decoder that runs in a browser, or are closed: DWG and other CAD drawings, Outlook PST stores, DjVu, HEIC writing, WMF and EMF, SAS / SPSS / Stata data, Shapefile, Avro and Arrow, STEP and IGES, files locked by DRM (Kindle and Apple books, protected video). Full camera raw development is also out; the preview stored in the raw file is used.

## Run it locally

Any static server works. Modules do not load from `file://`.

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Deploy

Cloudflare Pages, connected to this repository.

- Framework preset: None
- Build command: none
- Build output directory: `/`

Every push to `main` goes live.

## Browser support

Recent Chrome, Edge, Firefox and Safari. Workers need module worker support (Chrome 80, Firefox 114, Safari 15). Without it everything still runs, on the page. Some encoders (Opus, AAC, animated frames) need Chrome or Edge.
