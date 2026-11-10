// Optional downloads, fetched only when a format needs them.

import { KINDS, routeFor } from "./registry.js";

export function loadScript(src){
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("could not load " + src.split("/")[2] + ", check the connection"));
    document.head.appendChild(s);
  });
}

export const MODULES = {
  pdfjs: {
    label: "PDF reading",
    size: "about 1 MB from cdnjs",
    loaded: false,
    lib: null,
    async load(){
      if (this.loaded) return this.lib;
      const base = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = base + "/pdf.min.js";
        s.onload = res;
        s.onerror = () => rej(new Error("could not load pdf.js, check the connection"));
        document.head.appendChild(s);
      });
      const lib = window.pdfjsLib;
      if (!lib) throw new Error("pdf.js loaded but did not register");
      try {
        const wsrc = await (await fetch(base + "/pdf.worker.min.js")).text();
        lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wsrc], { type: "text/javascript" }));
      } catch (e){
        lib.GlobalWorkerOptions.workerSrc = base + "/pdf.worker.min.js";
      }
      this.lib = lib;
      this.loaded = true;
      return lib;
    }
  },
  ghostscript: {
    label: "Ghostscript, for EPS and PostScript",
    size: "about 16 MB from jsdelivr",
    loaded: false,
    lib: null,
    async load(){
      if (this.loaded) return this.lib;
      if (this._loading) return this._loading;
      this._loading = (async () => {
        const base = "https://cdn.jsdelivr.net/npm/@jspawn/ghostscript-wasm@0.0.2/";
        await loadScript(base + "gs.js");
        const factory = window.Module;
        if (typeof factory !== "function") throw new Error("Ghostscript loaded but did not register");
        const res = await fetch(base + "gs.wasm");
        if (!res.ok) throw new Error("could not fetch the Ghostscript binary, status " + res.status);
        const wasmBinary = new Uint8Array(await res.arrayBuffer());
        this.lib = { factory, wasmBinary, base };
        this.loaded = true;
        return this.lib;
      })();
      try { return await this._loading; }
      finally { this._loading = null; }
    }
  },
  heif: {
    label: "HEIC decoding",
    size: "about 1.3 MB from jsdelivr",
    loaded: false,
    lib: null,
    async load(){
      if (this.loaded) return this.lib;
      await loadScript("https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js");
      if (typeof window.heic2any !== "function") throw new Error("the HEIC decoder loaded but did not register");
      this.lib = window.heic2any;
      this.loaded = true;
      return this.lib;
    }
  },
  jxl: {
    label: "JPEG XL decoding",
    size: "about 1 MB from jsdelivr",
    loaded: false,
    lib: null,
    async load(){
      if (this.loaded) return this.lib;
      const mod = await import("https://cdn.jsdelivr.net/npm/@jsquash/jxl@1.3.0/decode.js");
      const fn = mod.default || mod.decode;
      if (typeof fn !== "function") throw new Error("the JPEG XL decoder loaded but has no decode function");
      this.lib = fn;
      this.loaded = true;
      return this.lib;
    }
  },
  // these two live in their own worker, which fetches them; see wasmtools.js
  ffmpeg: {
    label: "ffmpeg, for video and audio",
    size: "about 32 MB from jsdelivr, kept by the browser after the first use",
    loaded: false,
    async load(){ return true; }
  },
  sevenzip: {
    label: "7-Zip, for archives",
    size: "about 1.7 MB from jsdelivr",
    loaded: false,
    async load(){ return true; }
  },
  parquet: {
    label: "Parquet reading",
    size: "about 150 KB from jsdelivr",
    loaded: false,
    lib: null,
    async load(){
      if (this.loaded) return this.lib;
      this.lib = await import("https://cdn.jsdelivr.net/npm/hyparquet@1.33.0/src/index.js");
      this.loaded = true;
      return this.lib;
    }
  },
  avifenc: {
    label: "AVIF encoder",
    size: "about 3 MB from jsdelivr",
    loaded: false,
    lib: null,
    async load(){
      if (this.loaded) return this.lib;
      const base = "https://cdn.jsdelivr.net/npm/@jsquash/avif@2.1.1/codec/enc/";
      const factory = (await import(base + "avif_enc.js")).default;
      this.lib = await factory({ locateFile: f => base + f });
      this.loaded = true;
      return this.lib;
    }
  },
  jxlenc: {
    label: "JPEG XL encoder",
    size: "about 3 MB from jsdelivr",
    loaded: false,
    lib: null,
    async load(){
      if (this.loaded) return this.lib;
      const base = "https://cdn.jsdelivr.net/npm/@jsquash/jxl@1.3.0/codec/enc/";
      const factory = (await import(base + "jxl_enc.js")).default;
      this.lib = await factory({ locateFile: f => base + f });
      this.loaded = true;
      return this.lib;
    }
  },
  woff2: {
    label: "WOFF2 font codec",
    size: "about 1.3 MB from jsdelivr",
    loaded: false,
    lib: null,
    async load(){
      if (this.loaded) return this.lib;
      // two classic scripts that share global names, so each runs inside its own function
      const base = "https://cdn.jsdelivr.net/npm/wawoff2@2.0.1/build/";
      const one = async file => {
        const r = await fetch(base + file);
        if (!r.ok) throw new Error("could not load the WOFF2 codec, check the connection");
        const code = await r.text();
        return new Promise((res, rej) => {
          const M = { onRuntimeInitialized(){ res(M); }, onAbort: e => rej(new Error("the WOFF2 codec failed to start: " + e)) };
          try { new Function("Module", code)(M); } catch (e){ rej(e); }
        });
      };
      const dec = await one("decompress_binding.js");
      const enc = await one("compress_binding.js");
      this.lib = { decompress: b => dec.decompress(b), compress: b => enc.compress(b) };
      this.loaded = true;
      return this.lib;
    }
  },
  bgremove: {
    label: "background removal model",
    size: "roughly 40 to 90 MB, fetched once and then cached",
    loaded: false,
    lib: null,
    async load(){
      if (this.loaded) return this.lib;
      const mod = await import("https://esm.sh/@imgly/background-removal@1.7.0");
      const fn = mod.removeBackground || (mod.default && mod.default.removeBackground) || mod.default;
      if (typeof fn !== "function") throw new Error("the background removal library has no removeBackground");
      this.lib = fn;
      this.loaded = true;
      return this.lib;
    }
  }
};

export const MODULE_HUBS = { pdf: "pdfjs", av: "ffmpeg" };

export async function useModule(name, opts){
  const m = MODULES[name];
  if (!m.loaded){
    if (opts && opts.allowModules === false) throw new Error(`needs the optional ${m.label} module`);
    if (opts && typeof opts.notify === "function") opts.notify(`  loading ${m.label} (${m.size})`);
  }
  return m.load();
}

// outputs that need a download whatever the input is
export const TARGET_MODULE = { avif: "avifenc", jxl: "jxlenc", woff2: "woff2", sevenz: "sevenzip", txz: "sevenzip", tbz2: "sevenzip", xz: "sevenzip", bz2: "sevenzip" };

export function needsModuleFor(item, target){
  const hub = routeFor(item.kind, target);
  if (!hub) return false;
  if (MODULE_HUBS[hub]) return true;
  const km = KINDS[item.kind].module;
  if (km && hub !== "bytes" && hub !== "plain" && MODULES[km] && !MODULES[km].loaded) return true;
  const tm = TARGET_MODULE[target];
  return !!(tm && MODULES[tm] && !MODULES[tm].loaded);
}
