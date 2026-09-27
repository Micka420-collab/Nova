// Renders the installer artwork (macOS DMG background, Windows NSIS bitmaps) from the brand
// geometry in packages/ui/src/brand/paths.ts. Run: pnpm installer-art (outputs go to apps/desktop/build).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const paths = readFileSync(root("packages/ui/src/brand/paths.ts"), "utf8");
const constant = (name) => {
  const match = paths.match(new RegExp(`export const ${name} =\\s*((?:"[^"]*"\\s*\\+?\\s*)+);`));
  if (!match) throw new Error(`brand constant ${name} not found`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map((part) => part[1]).join("");
};
const MARK = constant("MARK_PATH");
const WORDMARK = constant("WORDMARK_PATH");
const FONT = root("packages/ui/assets/fonts/Manrope-wght.ttf");

const C = {
  night: "#111619",
  panel: "#192226",
  raised: "#243035",
  text: "#F2F5F3",
  muted: "#ABB9BB",
  jade: "#86D8BB",
  paper: "#F5F3EC",
  ink: "#172328",
  jadeDark: "#216B56",
};

/** Mark (256-unit viewBox) placed at x,y with the given size. */
const mark = (x, y, size, fill) =>
  `<path transform="translate(${x} ${y}) scale(${size / 256})" d="${MARK}" fill="${fill}"/>`;
/** Wordmark (153x48 units, round strokes) placed at x,y with the given height. */
const wordmark = (x, y, height, stroke) =>
  `<path transform="translate(${x} ${y}) scale(${height / 48})" d="${WORDMARK}" fill="none" stroke="${stroke}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
const text = (x, y, size, fill, content, { weight = 500, anchor = "middle", spacing = 0 } = {}) =>
  `<text x="${x}" y="${y}" font-family="Manrope" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${spacing}">${content}</text>`;

// Subtle mineral grain: deterministic dots, cheap and rendered identically everywhere.
function grain(width, height, count, color, opacity) {
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let dots = "";
  for (let i = 0; i < count; i++) {
    dots += `<circle cx="${(next() * width).toFixed(1)}" cy="${(next() * height).toFixed(1)}" r="${(0.4 + next() * 0.8).toFixed(2)}"/>`;
  }
  return `<g fill="${color}" opacity="${opacity}">${dots}</g>`;
}

/** macOS DMG window 660x420: app icon at (180,230), Applications at (480,230). */
function dmgBackground() {
  const w = 660;
  const h = 420;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="75%">
      <stop offset="0" stop-color="${C.jade}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${C.jade}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.night}"/>
      <stop offset="1" stop-color="${C.panel}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#floor)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  ${grain(w, h, 420, C.text, 0.05)}
  ${mark(262, 34, 36, C.jade)}
  ${wordmark(306, 42, 20, C.text)}
  ${text(330, 104, 15, C.muted, "Glisse NOVA dans le dossier Applications")}
  <!-- Open orbit from the app to Applications: the brand signature, with its moon. -->
  <path d="M232 262 C 290 318, 370 318, 428 262" fill="none" stroke="${C.jade}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1 9" opacity="0.9"/>
  <path d="M418 252 L430 261 L416 266" fill="none" stroke="${C.jade}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="330" cy="304" r="4" fill="${C.jade}"/>
  <line x1="40" y1="366" x2="620" y2="366" stroke="${C.raised}" stroke-width="1"/>
  ${text(330, 392, 12, C.muted, "Une idée. Un compagnon. Du concret.", { weight: 600, spacing: 0.4 })}
</svg>`;
}

/** NSIS welcome/finish sidebar, 164x314. */
function nsisSidebar() {
  const w = 164;
  const h = 314;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="30%" r="70%">
      <stop offset="0" stop-color="${C.jade}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${C.jade}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.night}"/>
      <stop offset="1" stop-color="${C.panel}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#floor)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  ${grain(w, h, 120, C.text, 0.05)}
  ${mark(22, 30, 120, C.jade)}
  ${wordmark(36, 160, 30, C.text)}
  <line x1="28" y1="222" x2="136" y2="222" stroke="${C.raised}" stroke-width="1"/>
  ${text(82, 246, 11, C.muted, "Une idée.", { weight: 600 })}
  ${text(82, 263, 11, C.muted, "Un compagnon.", { weight: 600 })}
  ${text(82, 280, 11, C.jade, "Du concret.", { weight: 700 })}
</svg>`;
}

/** NSIS page header, 150x57, drawn on the light header strip of the wizard. */
function nsisHeader() {
  const w = 150;
  const h = 57;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#FFFFFF"/>
  ${mark(38, 9, 40, C.jadeDark)}
  ${wordmark(82, 21, 15, C.ink)}
</svg>`;
}

function render(svg, scale = 1) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: "Manrope" },
  });
  return resvg.render();
}

/** 24-bit bottom-up BMP (the format NSIS Modern UI requires), alpha flattened on `background`. */
function toBmp(image, background) {
  const { width, height, pixels } = image;
  const bg = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const out = Buffer.alloc(size);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(rowSize * height, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = pixels[i + 3] / 255;
      const [r, g, b] = [0, 1, 2].map((c) => Math.round(pixels[i + c] * a + bg[c] * (1 - a)));
      out[row + x * 3] = b;
      out[row + x * 3 + 1] = g;
      out[row + x * 3 + 2] = r;
    }
  }
  return out;
}

const build = (name) => root(`apps/desktop/build/${name}`);
const outputs = [
  [build("dmg-background.png"), render(dmgBackground()).asPng()],
  [build("dmg-background@2x.png"), render(dmgBackground(), 2).asPng()],
  [build("installerSidebar.bmp"), toBmp(render(nsisSidebar()), C.night)],
  [build("uninstallerSidebar.bmp"), toBmp(render(nsisSidebar()), C.night)],
  [build("installerHeader.bmp"), toBmp(render(nsisHeader()), "#FFFFFF")],
];
for (const [file, bytes] of outputs) {
  writeFileSync(file, bytes);
  process.stdout.write(`installer-art: ${file.slice(root("").length)}\n`);
}
