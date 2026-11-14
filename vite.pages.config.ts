import { cpSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const base = "/spherex-time-lab-source/";
const out = resolve("dist/pages");

export default defineConfig({
  root: "pages",
  base,
  publicDir: false,
  resolve: { alias: { "@": resolve(".") } },
  define: { __PAGES_BASE__: JSON.stringify(base) },
  build: { outDir: out, emptyOutDir: true, sourcemap: false },
  plugins: [{
    name: "pages-runtime-assets",
    closeBundle() {
      for (const dir of ["data/atlas", "vendor/aladin-lite-3.8.2"]) {
        cpSync(resolve("public", dir), resolve(out, dir), { recursive: true });
      }
      writeFileSync(resolve(out, ".nojekyll"), "");
    },
  }],
});
