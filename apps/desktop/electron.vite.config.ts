// Every dependency is bundled (externalizeDeps: false), except the native/binary packages of ADR-012
// (node-pty, @vscode/ripgrep): they stay external, are declared in `dependencies` so electron-builder
// ships them in node_modules, and are unpacked from the asar (electron-builder.yml `asarUnpack`).
// `electron` and Node builtins (node:sqlite included) stay external, per electron-vite presets.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** Native or binary packages loaded from node_modules at runtime (never bundled). */
const NATIVE_EXTERNALS = ["node-pty", "@vscode/ripgrep"];

/**
 * turndown's ES build calls a bare `require("@mixmark-io/domino")` (its Node HTML parser) that
 * Rollup leaves to runtime, where pnpm's strict layout (and the packaged app) cannot resolve it.
 * Its CommonJS build lets the bundler see that require and bundle domino with the rest.
 */
const TURNDOWN_CJS = createRequire(here("../../packages/web/package.json")).resolve("turndown");

/**
 * utilityProcess entries, built next to the main bundle as out/main/workers/<name>.js. `chain-host`
 * is not in the WorkerPool: the chain service forks one host per program (J2-B L4).
 */
const WORKERS = ["pty-host", "fs-worker", "agent-runtime", "mcp-host", "chain-host"] as const;
const workerInputs = Object.fromEntries(
  WORKERS.map((name) => [`workers/${name}`, here(`./src/workers/${name}.ts`)]),
);

export default defineConfig({
  main: {
    resolve: { alias: { turndown: TURNDOWN_CJS } },
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
