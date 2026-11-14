import { publicAsset } from "./site-mode";
export type SkyOverlay = { removeAll(): void; addFootprints(shapes: unknown[]): void };
export type SkyImage = { setFrequency(value: { value: number; unit: 'Hz' }): void };
export type SkyViewer = {
  gotoRaDec(ra: number, dec: number): void;
  getRaDec(): [number, number]; getFov(): [number, number]; setFoV(degrees: number): void;
  addOverlay(overlay: SkyOverlay): void;
  setBaseImageLayer(layer: SkyImage | string): unknown;
  on(event: "positionChanged" | "click", callback: (event: { ra: number; dec: number; isDragging?: boolean }) => void): void;
  remove(): void;
};
export type AladinApi = {
  init: Promise<unknown>;
  aladin(container: HTMLElement, options: Record<string, unknown>): SkyViewer;
  graphicOverlay(options: Record<string, unknown>): SkyOverlay;
  polygon(points: [number, number][]): unknown;
  imageHiPS(url: string, options: { successCallback: (image: SkyImage) => void; errorCallback?: () => void }): SkyImage;
  circle(ra: number, dec: number, radius: number): unknown;
};
let loading: Promise<AladinApi> | null = null;
export function loadAladin(): Promise<AladinApi> {
  if (!loading) {
    // Public assets must be loaded through HTML, outside Vite's source import graph.
    // The small module entry keeps the upstream distribution unmodified and replaceable.
    loading = new Promise<AladinApi>((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = publicAsset("/vendor/aladin-lite-3.8.2/entry.js");
      const timer = setTimeout(() => { cleanup(); reject(new Error("Aladin module loading timed out")); }, 25000);
      function cleanup() { clearTimeout(timer); script.onload = null; script.onerror = null; script.remove(); }
      script.onload = () => {
        const api = (window as Window & { spherexAladin?: AladinApi }).spherexAladin;
        cleanup();
        if (!api) { reject(new Error("Aladin module did not initialize")); return; }
        api.init.then(() => resolve(api), reject);
      };
      script.onerror = () => { cleanup(); reject(new Error("Aladin module could not be loaded")); };
      document.head.appendChild(script);
    }).catch(error => { loading = null; throw error; });
  }
  return loading;
}
