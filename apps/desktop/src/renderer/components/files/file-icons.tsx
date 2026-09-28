// Monochrome file-type icons for the tree (VISUAL §2.9: short list, no colored language logos).
// Drawn on the lucide grid (24, stroke 2, round caps); lucide-react is not a dependency of the app.
import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="nova-tree__icon"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

const PAGE = <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z M14 2v4a2 2 0 0 0 2 2h4" />;

export type FileIconKind = "code" | "style" | "data" | "image" | "document" | "config" | "lock" | "file";

const EXTENSIONS: Record<string, FileIconKind> = {
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  py: "code",
  rs: "code",
  go: "code",
  java: "code",
  c: "code",
  h: "code",
  cpp: "code",
  sh: "code",
  html: "code",
  vue: "code",
  svelte: "code",
  sql: "code",
  css: "style",
  scss: "style",
  less: "style",
  json: "data",
  csv: "data",
  xml: "data",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  env: "config",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  ico: "image",
  md: "document",
  txt: "document",
  pdf: "document",
  lock: "lock",
};

export function fileIconKind(name: string): FileIconKind {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name.startsWith(".") ? "config" : "file";
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? "file";
}

export function FileIcon({ name }: { name: string }) {
  switch (fileIconKind(name)) {
    case "code":
      return (
        <Icon>
          {PAGE}
          <path d="m10 13-2 2 2 2 M14 17l2-2-2-2" />
        </Icon>
      );
    case "style":
      return (
        <Icon>
          {PAGE}
          <path d="M9 13h6 M9 17h3" />
        </Icon>
      );
    case "data":
      return (
        <Icon>
          {PAGE}
          <path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1 M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" />
        </Icon>
      );
    case "image":
      return (
        <Icon>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
        </Icon>
      );
    case "document":
      return (
        <Icon>
          {PAGE}
          <path d="M16 13H8 M16 17H8 M10 9H8" />
        </Icon>
      );
    case "config":
      return (
        <Icon>
          {PAGE}
          <circle cx="12" cy="15" r="2" />
        </Icon>
      );
    case "lock":
      return <LockIcon />;
    default:
      return <Icon>{PAGE}</Icon>;
  }
}

export function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <Icon>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </Icon>
  ) : (
    <Icon>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  );
}

export function LockIcon() {
  return (
    <Icon>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Icon>
  );
}

export function ChevronIcon() {
  return (
    <Icon>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  );
}
