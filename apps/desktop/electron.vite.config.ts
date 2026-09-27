// Every dependency is bundled (externalizeDeps: false), except the native/binary packages of ADR-012
// (node-pty, @vscode/ripgrep): they stay external, are declared in `dependencies` so electron-builder
// ships them in node_modules, and are unpacked from the asar (electron-builder.yml `asarUnpack`).
// `electron` and Node builtins (node:sqlite included) stay external, per electron-vite presets.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** Native or binary packages loaded from node_modules at runtime (never bundled). */
const NATIVE_EXTERNALS = ["node-pty", "@vscode/ripgrep"];

/** utilityProcess entries, built next to the main bundle as out/main/workers/<name>.js. */
const WORKERS = ["pty-host", "fs-worker", "agent-runtime", "mcp-host"] as const;
const workerInputs = Object.fromEntries(
  WORKERS.map((name) => [`workers/${name}`, here(`./src/workers/${name}.ts`)]),
);

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: here("./src/main/index.ts"), ...workerInputs },
        external: NATIVE_EXTERNALS,
      },
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
