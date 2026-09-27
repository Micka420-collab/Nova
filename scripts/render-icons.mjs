// Renders the NOVA app icon (packages/ui/assets/app-icon.svg) to the PNGs used by the desktop build
// and the favicon. Usage: `pnpm icons` (node scripts/render-icons.mjs).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages/ui/assets/app-icon.svg");

// The app icon keeps the macOS safe margin (a 824px tile on a 1024px canvas); the favicon crops to the
// tile so the mark stays legible at 32px.
const TILE_VIEWBOX = 'viewBox="100 100 824 824"';

const targets = [
  { file: "apps/desktop/build/icon.png", size: 1024, crop: false },
  { file: "apps/desktop/build/icon-512.png", size: 512, crop: false },
  { file: "apps/desktop/build/icon-256.png", size: 256, crop: false },
  { file: "packages/ui/assets/favicon-32.png", size: 32, crop: true },
];

const svg = await readFile(source, "utf8");
if (!svg.includes('viewBox="0 0 1024 1024"')) {
  throw new Error("app-icon.svg must keep viewBox=\"0 0 1024 1024\" (the favicon crop depends on it)");
}

for (const target of targets) {
  const input = target.crop ? svg.replace('viewBox="0 0 1024 1024"', TILE_VIEWBOX) : svg;
  const rendered = new Resvg(input, {
    fitTo: { mode: "width", value: target.size },
    font: { loadSystemFonts: false },
    shapeRendering: 2,
  }).render();
  const out = join(root, target.file);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, rendered.asPng());
  process.stdout.write(`icons: ${relative(root, out)} (${rendered.width}x${rendered.height})\n`);
}
