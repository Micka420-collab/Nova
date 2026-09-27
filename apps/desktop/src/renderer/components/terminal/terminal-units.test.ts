import { describe, expect, it, vi } from "vitest";
import { contrastRatio, CONTRAST_TEXT } from "@nova/ui";
import { terminalKeyAction } from "./keys";
import { withStyleNonce } from "./style-nonce";
import { TerminalPortClient, type ClientPort } from "./terminal-client";
import { ANSI_PALETTES, terminalTheme } from "./terminal-theme";

function fakePort() {
  const posted: unknown[] = [];
  const port: ClientPort & { posted: unknown[]; closed: boolean; deliver(data: unknown): void } = {
    posted,
    closed: false,
    onmessage: null,
    postMessage: (message: unknown) => posted.push(message),
    start: () => {},
    close() {
      this.closed = true;
    },
    deliver(data: unknown) {
      this.onmessage?.({ data } as MessageEvent);
    },
  };
  return port;
}

describe("TerminalPortClient", () => {
  it("acks output only after xterm has written it, and forwards input and exit", () => {
    const port = fakePort();
    const pending: (() => void)[] = [];
    const writes: string[] = [];
    const exits: unknown[] = [];
    const client = new TerminalPortClient(
      port,
      { write: (data, done) => (writes.push(data), pending.push(done)) },
      { onExit: (exit) => exits.push(exit) },
    );
    port.deliver({ type: "replay", data: "$ " });
    port.deliver({ type: "output", data: "héllo\r\n" });
    expect(writes).toEqual(["$ ", "héllo\r\n"]);
    expect(port.posted).toEqual([]);
    pending.shift()?.();
    pending.shift()?.();
    expect(port.posted).toEqual([
      { type: "ack", chars: 2 },
      { type: "ack", chars: 7 },
    ]);

    client.input("ls\r");
    port.deliver({ type: "exit", exitCode: 2, signal: null });
    expect(port.posted.at(-1)).toEqual({ type: "input", data: "ls\r" });
    expect(exits).toEqual([{ exitCode: 2, signal: null }]);
  });

  it("ignores malformed messages and stops acking once disposed", () => {
    const port = fakePort();
    const pending: (() => void)[] = [];
    const client = new TerminalPortClient(port, { write: (_data, done) => pending.push(done) }, { onExit: vi.fn<(exit: unknown) => void>() });
    port.deliver({ type: "output", data: 42 });
    port.deliver({ type: "exit", exitCode: "1" });
    port.deliver("raw");
    expect(pending).toHaveLength(0);
    port.deliver({ type: "output", data: "x" });
    client.dispose();
    pending[0]?.();
    client.input("late");
    expect(port.posted).toEqual([]);
    expect(port.closed).toBe(true);
  });
});

describe("terminal theme (VISUAL §2.4)", () => {
  it.each(["dark", "light"] as const)("every %s foreground reaches 4.5:1 on the terminal background", (scheme) => {
    const theme = terminalTheme(scheme);
    const background = theme.background as string;
    // Index 0 at night is a background color by design (lifted by minimumContrastRatio).
    const foregrounds = ANSI_PALETTES[scheme].filter((_, index) => !(scheme === "dark" && index === 0));
    for (const color of [...foregrounds, theme.foreground as string, theme.cursor as string]) {
      expect({ color, ratio: contrastRatio(color, background) >= CONTRAST_TEXT }).toEqual({ color, ratio: true });
    }
  });
});

const key = (init: Partial<KeyboardEvent>) =>
  ({ key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init }) as KeyboardEvent;

describe("terminal keys (POWER_UX §5.5)", () => {
  it("Ctrl+C copies a selection, otherwise it is SIGINT for the shell", () => {
    expect(terminalKeyAction(key({ key: "c", ctrlKey: true }), true, false)).toBe("copy");
    expect(terminalKeyAction(key({ key: "c", ctrlKey: true }), false, false)).toBe("shell");
  });

  it("lets application shortcuts through and keeps shell keys in the shell", () => {
    expect(terminalKeyAction(key({ key: "j", ctrlKey: true }), false, false)).toBe("app");
    expect(terminalKeyAction(key({ key: "P", ctrlKey: true, shiftKey: true }), false, false)).toBe("app");
    expect(terminalKeyAction(key({ key: "2", code: "Digit2", altKey: true }), false, false)).toBe("app");
    for (const shellKey of ["d", "r", "z", "w", "a", "e"]) {
      expect([shellKey, terminalKeyAction(key({ key: shellKey, ctrlKey: true }), false, false)]).toEqual([shellKey, "shell"]);
    }
    expect(terminalKeyAction(key({ key: "Escape" }), false, false)).toBe("shell");
    expect(terminalKeyAction(key({ key: "F6" }), false, false)).toBe("leave");
    expect(terminalKeyAction(key({ key: "V", ctrlKey: true, shiftKey: true }), false, false)).toBe("paste");
  });

  it("uses ⌘ on macOS and leaves ⌃ keys to the shell there", () => {
    expect(terminalKeyAction(key({ key: "c", metaKey: true }), false, true)).toBe("copy");
    expect(terminalKeyAction(key({ key: "c", ctrlKey: true }), true, true)).toBe("shell");
    expect(terminalKeyAction(key({ key: "j", metaKey: true }), false, true)).toBe("app");
  });
});

describe("withStyleNonce", () => {
  it("stamps the nonce on <style> elements created during the call only, then restores createElement", () => {
    const inside = withStyleNonce(document, "abc123", () => {
      const style = document.createElement("style");
      const div = document.createElement("div");
      return { style, div };
    });
    expect(inside.style.nonce).toBe("abc123");
    expect(inside.div.getAttribute("nonce")).toBeNull();
    expect(document.createElement("style").nonce).toBeFalsy();
    expect(Object.hasOwn(document, "createElement")).toBe(false);
  });

  it("restores createElement when the call throws", () => {
    expect(() =>
      withStyleNonce(document, "n", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(Object.hasOwn(document, "createElement")).toBe(false);
  });
});
