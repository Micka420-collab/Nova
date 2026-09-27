// Every dependency is bundled (externalizeDeps: false): the packaged app ships without node_modules.
// Only `electron` and Node builtins (node:sqlite included) stay external, per electron-vite presets.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: { input: { index: here("./src/main/index.ts") } },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: here("./src/preload/index.ts") },
        // Sandboxed preloads cannot be ES modules.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: here("./src/renderer"),
    plugins: [react()],
    build: {
      // No data: URIs: the CSP only allows data: for images, fonts and scripts must be files.
      assetsInlineLimit: 0,
      minify: true,
      rollupOptions: { input: { index: here("./src/renderer/index.html") } },
    },
  },
});
