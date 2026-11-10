# tools

File tools that run in the browser. Live at [tools.katr.es](https://tools.katr.es).

Files stay on the device. Nothing is uploaded. There is no server code and no build step.

## What is here

| Tab | What it does |
| --- | --- |
| Convert | Turns files into other formats: images, documents, data, subtitles, audio, archives, encodings. About 80 input formats, covering more than 200 file extensions, and 70 outputs. |
| Images | Edits one image at a time: crop, rotate, flip, remove a colour, remove a background. |
| Batch | Resizes, compresses and renames many images in one run. Can hold each file under a size limit. |
| PDF | Reorders, removes, rotates, crops and merges pages. Saves losslessly or as page images. |
| Preview | Shows what a file holds, or says what can open it. Hands the file to the other tabs. |

Drop files anywhere on the page, drop a whole folder, or paste from the clipboard. They go to the open tab.

## How it is built

Plain ES modules, served as they are.

```
index.html          all markup, so the page paints before any script runs
css/app.css
js/main.js          tabs, file intake, loads each tab on first open
js/ui/              one module per tab, plus shared page helpers in dom.js
js/engine/          formats and conversions, no page code
js/worker/          a small worker pool and the worker entry
```

Three things keep it quick:

1. **Each tab loads on first open.** The first paint needs the page, the stylesheet and about a dozen small modules. The converter itself (about 30 modules) is fetched when the page goes idle.
2. **Heavy work runs in workers.** Image decoding, resizing, encoding, archives and most data conversions run in a pool of up to four workers, several files at once. The page stays responsive and Stop works at once.
3. **Lists update in place.** A status change touches one row. PDF thumbnails are drawn once and reused.

Work that needs the document (HTML, XML, Office files, SVG, audio, pdf.js) cannot run in a worker. The worker reports this and the same job runs on the page instead.

### How a conversion works

Every format declares which shared shapes it can become: `raster`, `table`, `tree`, `rich`, `cues`, `audio`, `mesh`, `archive`, `bytes`. Every target declares which shapes it can be written from. A conversion is one hop in and one hop out, so adding a format means writing one reader or one writer, and it then works with everything on the other side. `js/engine/registry.js` holds both lists.

### Optional downloads

A few formats need a large library. Each is fetched from a CDN only when a file needs it:

| For | Library | From |
| --- | --- | --- |
| PDF reading | pdf.js 3.11 | cdnjs |
| EPS, PostScript, AI | Ghostscript (WebAssembly) | jsDelivr |
| HEIC | heic2any | jsDelivr |
| JPEG XL | jSquash | jsDelivr |
| Background removal by model | @imgly/background-removal | esm.sh |

These fetch code only. The file being worked on never leaves the browser.

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
