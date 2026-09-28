// xterm.js themes from docs/design/VISUAL.md §2.4 (ANSI palette) and §5.6 (terminal panel).
// xterm needs literal colors (it draws on a canvas), so the values mirror the tokens here instead of
// reading CSS variables; terminal-theme.test.ts checks every foreground against the background.
// Weak colors sent by programs (256/truecolor) are raised by `minimumContrastRatio` at render time.
import type { ITheme } from "@xterm/xterm";

export type TerminalColorScheme = "dark" | "light";

/** ANSI 0–15, in order: black, red, green, yellow, blue, magenta, cyan, white, then the bright set. */
export const ANSI_PALETTES: Record<TerminalColorScheme, readonly string[]> = {
  dark: [
    "#243035", // 0 is a background color at night (1.43:1 as text): minimumContrastRatio lifts it
    "#F18A8A",
    "#86D8BB",
    "#EEC181",
    "#9CC7D6",
    "#D9B8CF",
    "#8FD3D3",
    "#D5DFDB",
    "#8C9EA0",
    "#F5A3A3",
    "#9FE2CA",
    "#F3D3A3",
    "#B4D7E3",
    "#E6CCDD",
    "#A8E0E0",
    "#F2F5F3",
  ],
  light: [
    "#172328",
    "#B3261E",
    "#216B56",
    "#7D5310",
    "#2B6076",
    "#7B4B70",
    "#1F6A6A",
    "#4B5A5D",
    "#556668",
    "#9C1F18",
    "#1A5A48",
    "#6A4407",
    "#215064",
    "#663A5C",
    "#185858",
    "#172328",
  ],
};

const SURFACES: Record<TerminalColorScheme, { background: string; foreground: string; accent: string; selection: string; scrollbar: string }> = {
  dark: { background: "#0A0E10", foreground: "#F2F5F3", accent: "#86D8BB", selection: "#2F5E50", scrollbar: "#3A4A50" },
  light: { background: "#F7F5EE", foreground: "#172328", accent: "#216B56", selection: "#BFE3D4", scrollbar: "#C9C4B8" },
};

/** Text contrast floor (WCAG AA); 7 in high-contrast mode (POWER_UX §5.5). */
export const TERMINAL_MIN_CONTRAST = 4.5;
export const TERMINAL_MIN_CONTRAST_HIGH = 7;

export function terminalTheme(scheme: TerminalColorScheme): ITheme {
  const surface = SURFACES[scheme];
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] =
    ANSI_PALETTES[scheme];
  return {
    background: surface.background,
    foreground: surface.foreground,
    cursor: surface.accent,
    cursorAccent: surface.background,
    selectionBackground: surface.selection,
    selectionForeground: surface.foreground,
    scrollbarSliderBackground: `${surface.scrollbar}99`,
    scrollbarSliderHoverBackground: `${surface.scrollbar}CC`,
    scrollbarSliderActiveBackground: surface.scrollbar,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

/** Current scheme of the document (`data-theme` on <html>, dark by default like tokens.css). */
export function documentColorScheme(doc: Pick<Document, "documentElement"> = document): TerminalColorScheme {
  return doc.documentElement.dataset["theme"] === "light" ? "light" : "dark";
}
