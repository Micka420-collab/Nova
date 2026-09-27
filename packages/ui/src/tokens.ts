export type ThemeName = "dark" | "light";

export interface Palette {
  bg: string;
  panel: string;
  raised: string;
  raisedHover: string;
  field: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  onAccent: string;
  amber: string;
  amberSoft: string;
  danger: string;
  dangerHover: string;
  dangerSoft: string;
  onDanger: string;
  info: string;
  infoSoft: string;
  focus: string;
  selection: string;
  tooltipBg: string;
  tooltipText: string;
  nomiHead: string;
  nomiBody: string;
  nomiTop: string;
  nomiEye: string;
  nomiEdge: string;
  nomiHeadError: string;
  nomiBodyError: string;
  nomiTopError: string;
  nomiHeadOffline: string;
  nomiBodyOffline: string;
  nomiTopOffline: string;
}

/** "Nuit minérale" (dark, default) and "Papier minéral" (light). Mirrored by styles/tokens.css. */
export const palettes = {
  dark: {
    bg: "#111619",
    panel: "#192226",
    raised: "#243035",
    raisedHover: "#2C3A40",
    field: "#0D1215",
    border: "#2A363B",
    borderStrong: "#758689",
    text: "#F2F5F3",
    textSecondary: "#ABB9BB",
    accent: "#86D8BB",
    accentHover: "#9FE2CA",
    accentSoft: "#1B3A31",
    onAccent: "#111619",
    amber: "#EEC181",
    amberSoft: "#3A3020",
    danger: "#F18A8A",
    dangerHover: "#F5A3A3",
    dangerSoft: "#3D2426",
    onDanger: "#111619",
    info: "#9CC7D6",
    infoSoft: "#1D3039",
    focus: "#86D8BB",
    selection: "#2F5E50",
    tooltipBg: "#DDE5E2",
    tooltipText: "#111619",
    nomiHead: "#C9D9D1",
    nomiBody: "#7C9A94",
    nomiTop: "#9DB8B1",
    nomiEye: "#111619",
    nomiEdge: "#67847F",
    nomiHeadError: "#E3C2BF",
    nomiBodyError: "#A07F7D",
    nomiTopError: "#C29F9C",
    nomiHeadOffline: "#9AA3A4",
    nomiBodyOffline: "#5D6769",
    nomiTopOffline: "#7B8587",
  },
  light: {
    bg: "#F5F3EC",
    panel: "#EEEBE3",
    raised: "#FFFFFF",
    raisedHover: "#F4F2EC",
    field: "#FFFFFF",
    border: "#DDD8CC",
    borderStrong: "#76848A",
    text: "#172328",
    textSecondary: "#4B5A5D",
    accent: "#216B56",
    accentHover: "#1A5A48",
    accentSoft: "#DDEFE7",
    onAccent: "#FFFFFF",
    amber: "#7D5310",
    amberSoft: "#F6E8D0",
    danger: "#B3261E",
    dangerHover: "#9C1F18",
    dangerSoft: "#F9E1DF",
    onDanger: "#FFFFFF",
    info: "#2B6076",
    infoSoft: "#E0ECF1",
    focus: "#216B56",
    selection: "#BFE3D4",
    tooltipBg: "#172328",
    tooltipText: "#F2F5F3",
    nomiHead: "#C3D4CD",
    nomiBody: "#7F9D96",
    nomiTop: "#A3BCB5",
    nomiEye: "#172328",
    nomiEdge: "#56736D",
    nomiHeadError: "#E6C9C5",
    nomiBodyError: "#A8807C",
    nomiTopError: "#C9A5A1",
    nomiHeadOffline: "#C9CFCF",
    nomiBodyOffline: "#8E9798",
    nomiTopOffline: "#AAB2B3",
  },
} as const satisfies Record<ThemeName, Palette>;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48 } as const;

export const radius = { xs: 6, sm: 10, md: 12, lg: 16, pill: 999 } as const;

export const duration = { fast: 120, base: 180, slow: 220 } as const;

export const fontFamily = {
  ui: '"Manrope Variable", "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
} as const;

/** CSS custom property name for a palette key: `textSecondary` -> `--nv-text-secondary`. */
export function cssVarName(key: keyof Palette): string {
  return `--nv-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}
