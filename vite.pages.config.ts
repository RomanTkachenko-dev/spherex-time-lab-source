import { cpSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const base = "/spherex-time-lab-source/";
const api = process.env.PAGES_API_ORIGIN || "";
if (api && !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(api)) throw new Error("PAGES_API_ORIGIN must be an HTTPS origin");
const out = resolve("dist/pages");

export default defineConfig({
  root: "static-site",
  base,
  publicDir: false,
  resolve: { alias: { "@": resolve(".") } },
  define: { __PAGES_BASE__: JSON.stringify(base), __API_ORIGIN__: JSON.stringify(api) },
  build: { outDir: out, emptyOutDir: true, sourcemap: false },
  plugins: [{
    name: "pages-runtime-assets",
    closeBundle() {
      for (const dir of ["data/atlas", "data/epochs", "vendor/aladin-lite-3.8.2"]) {
        cpSync(resolve("public", dir), resolve(out, dir), { recursive: true });
      }
      if (api) {
        cpSync(resolve("public/science"), resolve(out, "science"), { recursive: true });
      }
      writeFileSync(resolve(out, ".nojekyll"), "");
    },
  }],
});
