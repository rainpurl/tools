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

export const MODULE_HUBS = { pdf: "pdfjs" };

export async function useModule(name, opts){
  const m = MODULES[name];
  if (!m.loaded){
    if (opts && opts.allowModules === false) throw new Error(`needs the optional ${m.label} module`);
    if (opts && typeof opts.notify === "function") opts.notify(`  loading ${m.label} (${m.size})`);
  }
  return m.load();
}

export function needsModuleFor(item, target){
  const hub = routeFor(item.kind, target);
  if (!hub) return false;
  if (MODULE_HUBS[hub]) return true;
  const km = KINDS[item.kind].module;
  return !!(km && hub === "raster" && MODULES[km] && !MODULES[km].loaded);
}
