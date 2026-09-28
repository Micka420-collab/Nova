// One xterm.js instance bound to one session's MessagePort (POWER_UX §5, VISUAL §5.6).
// Rendering: the WebGL addon is loaded BEFORE `open()` so xterm never builds its DOM renderer, whose
// <style> elements and per-cell style attributes the CSP refuses (see ./style-nonce.ts). Without
// WebGL2 the DOM renderer is used, its <style> elements get the page nonce, and the panel says the
// terminal is degraded instead of pretending.
import { useEffect, useLayoutEffect, useRef, type Ref } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
// oxlint-disable-next-line import/no-unassigned-import -- xterm's own stylesheet, emitted as a CSS file (style-src 'self')
import "@xterm/xterm/css/xterm.css";
import type { TerminalSession } from "@nova/shared";
import { styleNonce } from "../../lib/csp-nonce";
import { terminalCopy as copy } from "./copy";
import { isMacPlatform, terminalKeyAction } from "./keys";
import { TerminalPortClient, type TerminalExit } from "./terminal-client";
import {
  TERMINAL_MIN_CONTRAST,
  TERMINAL_MIN_CONTRAST_HIGH,
  terminalTheme,
  type TerminalColorScheme,
} from "./terminal-theme";
import { withStyleNonce } from "./style-nonce";

export type RendererIssue = "webgl-unavailable" | "webgl-lost";

export interface TerminalHandle {
  focus(): void;
  clear(): void;
  findNext(query: string): boolean;
  findPrevious(query: string): boolean;
  clearSearch(): void;
  selection(): string;
  /** Last lines of the buffer (trailing blanks dropped), at most `maxChars` characters. */
  tail(lines: number, maxChars: number): string;
}

export interface TerminalViewProps {
  session: TerminalSession;
  /** Resolves with this session's data port (fresh from create, or after terminal.attach). */
  acquirePort(): Promise<MessagePort>;
  onResize(cols: number, rows: number): void;
  onExit(exit: TerminalExit): void;
  onPortError(message: string): void;
  onSelectionChange(hasSelection: boolean): void;
  onOpenLink(uri: string): void;
  /** F6: focus leaves the terminal (the panel moves it to its tab list). */
  onLeave(): void;
  onFind(): void;
  onExplain(): void;
  onRendererIssue(issue: RendererIssue): void;
  /** Agent sessions before "Prendre la main": no input at all. */
  readOnly: boolean;
  colorScheme: TerminalColorScheme;
  screenReaderMode: boolean;
  highContrast: boolean;
  reducedMotion: boolean;
  label: string;
  hidden: boolean;
  handleRef?: Ref<TerminalHandle>;
}

const FONT_FAMILY = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace';
const RESIZE_DEBOUNCE_MS = 80;

let webgl2: boolean | null = null;

/** Probed once; the probe context is released right away (browsers cap live WebGL contexts). */
export function webgl2Available(): boolean {
  if (webgl2 !== null) return webgl2;
  try {
    const context = document.createElement("canvas").getContext("webgl2");
    webgl2 = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/**
 * The DOM renderer applies contrast-adjusted colors through `style` attributes, which the CSP
 * blocks (one console error per cell): in degraded mode the adjustment is off, cells keep their
 * palette color (VISUAL §2.4 foregrounds already reach 4.5:1 except night index 0).
 */
function contrastFloor(props: Pick<TerminalViewProps, "highContrast">, degraded: boolean): number {
  if (degraded) return 1;
  return props.highContrast ? TERMINAL_MIN_CONTRAST_HIGH : TERMINAL_MIN_CONTRAST;
}

function options(props: TerminalViewProps): ITerminalOptions {
  return {
    fontFamily: FONT_FAMILY,
    fontSize: 13,
    // JetBrains Mono's own line box at 13 px is ~17.2 px, rounded up to the 18 px of VISUAL §5.6.
    lineHeight: 1,
    cursorStyle: "block",
    cursorBlink: !props.reducedMotion,
    scrollback: 5_000,
    theme: terminalTheme(props.colorScheme),
    minimumContrastRatio: contrastFloor(props, !webgl2Available()),
    screenReaderMode: props.screenReaderMode,
    disableStdin: props.readOnly,
    allowProposedApi: false,
  };
}

export function TerminalView(props: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const terminal = useRef<Terminal | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const degraded = useRef(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const initial = latest.current;
    const term = new Terminal(options(initial));
    const fit = new FitAddon();
    const finder = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(finder);
    term.loadAddon(new WebLinksAddon((_event, uri) => latest.current.onOpenLink(uri)));
    const nonce = styleNonce();
    const loadWebgl = (): boolean => {
      if (!webgl2Available()) return false;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // Falls back to the DOM renderer (created during dispose: its <style> needs the nonce).
          withStyleNonce(document, nonce, () => addon.dispose());
          if (!loadWebgl()) {
            degraded.current = true;
            term.options.minimumContrastRatio = contrastFloor(latest.current, true);
            latest.current.onRendererIssue("webgl-lost");
          }
        });
        term.loadAddon(addon);
        return true;
      } catch {
        return false;
      }
    };
    if (!loadWebgl()) {
      degraded.current = true;
      initial.onRendererIssue("webgl-unavailable");
    }
    withStyleNonce(document, nonce, () => term.open(element));
    terminal.current = term;
    search.current = finder;

    const mac = isMacPlatform();
    term.attachCustomKeyEventHandler((event) => {
      const action = terminalKeyAction(event, term.hasSelection(), mac);
      if (action === "shell") return true;
      if (event.type !== "keydown") return false;
      const view = latest.current;
      if (action === "copy") {
        if (term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        event.preventDefault();
      } else if (action === "paste") {
        event.preventDefault();
        if (!view.readOnly) void navigator.clipboard?.readText().then((text) => term.paste(text));
      } else if (action === "find") {
        event.preventDefault();
        view.onFind();
      } else if (action === "explain") {
        event.preventDefault();
        view.onExplain();
      } else if (action === "leave") {
        event.preventDefault();
        view.onLeave();
      }
      // "app": not handled by xterm, the keydown bubbles to the application shortcuts.
      return false;
    });

    let client: TerminalPortClient | null = null;
    let disposed = false;
    const disposables = [
      term.onData((data) => client?.input(data)),
      term.onSelectionChange(() => latest.current.onSelectionChange(term.hasSelection())),
    ];

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    disposables.push(
      term.onResize(({ cols, rows }) => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => latest.current.onResize(cols, rows), RESIZE_DEBOUNCE_MS);
      }),
    );
    let frame = 0;
    const refit = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Hidden (display: none) views have no size: fitting them would shrink the pty to 2×1.
        if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
    observer?.observe(element);
    refit();

    initial
      .acquirePort()
      .then((port) => {
        if (disposed) {
          port.close();
          return;
        }
        client = new TerminalPortClient(port, term, { onExit: (exit) => latest.current.onExit(exit) });
      })
      .catch((error: unknown) => {
        if (!disposed) latest.current.onPortError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      cancelAnimationFrame(frame);
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const disposable of disposables) disposable.dispose();
      client?.dispose();
      terminal.current = null;
      search.current = null;
      term.dispose();
    };
    // One terminal per mount: the panel keys each view by session id (and reconnect generation).
  }, []);

  // Live option changes (theme switch, a11y mode, take-over) without recreating the terminal.
  const { colorScheme, highContrast, screenReaderMode, readOnly, reducedMotion } = props;
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.theme = terminalTheme(colorScheme);
    term.options.minimumContrastRatio = contrastFloor({ highContrast }, degraded.current);
    term.options.screenReaderMode = screenReaderMode;
    term.options.disableStdin = readOnly;
    term.options.cursorBlink = !reducedMotion;
  }, [colorScheme, highContrast, screenReaderMode, readOnly, reducedMotion]);

  const { handleRef } = props;
  useEffect(() => {
    const handle: TerminalHandle = {
      focus: () => terminal.current?.focus(),
      clear: () => terminal.current?.clear(),
      findNext: (query) => search.current?.findNext(query) ?? false,
      findPrevious: (query) => search.current?.findPrevious(query) ?? false,
      clearSearch: () => search.current?.clearDecorations(),
      selection: () => terminal.current?.getSelection() ?? "",
      tail: (lines, maxChars) => {
        const buffer = terminal.current?.buffer.active;
        if (!buffer) return "";
        const out: string[] = [];
        for (let y = buffer.length - 1; y >= 0 && out.length < lines; y -= 1) {
          out.push(buffer.getLine(y)?.translateToString(true) ?? "");
        }
        const text = out.reverse().join("\n").trimEnd();
        return text.length > maxChars ? text.slice(text.length - maxChars) : text;
      },
    };
    setRef(handleRef, handle);
    return () => setRef(handleRef, null);
  }, [handleRef]);

  const hintId = `nv-terminal-hint-${props.session.id}`;
  return (
    <>
      <section
        className="nv-terminal-view"
        aria-label={props.label}
        aria-describedby={hintId}
        hidden={props.hidden}
        ref={host}
      />
      <span id={hintId} className="nv-visually-hidden">
        {copy.escapeHint}
      </span>
    </>
  );
}
