// The panel over a fake terminal API and fake MessagePorts. xterm itself is replaced (jsdom has no
// canvas/WebGL); the real browser rendering is proven by the lead's E2E on the built app.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NovaApi, NovaPortRegistry, TerminalSession } from "@nova/shared";
import { createTerminalStore } from "../../state/terminal-slice";
import { TerminalPanel, type TerminalExplainRequest } from "./TerminalPanel";

const { FakeTerminal, terminals } = vi.hoisted(() => {
  const created: InstanceType<typeof Fake>[] = [];
  class Fake {
    options: Record<string, unknown>;
    written: string[] = [];
    private dataListener: ((data: string) => void) | null = null;
    readonly lines: string[] = [];
    readonly buffer: { active: { length: number; getLine(y: number): { translateToString(): string } } };
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      created.push(this);
      const lines = this.lines;
      this.buffer = {
        active: {
          get length() {
            return lines.length;
          },
          getLine: (y: number) => ({ translateToString: () => lines[y] ?? "" }),
        },
      };
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomKeyEventHandler(): void {}
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return { dispose: () => {} };
    }
    onSelectionChange() {
      return { dispose: () => {} };
    }
    onResize() {
      return { dispose: () => {} };
    }
    hasSelection = () => false;
    getSelection = () => "";
    clearSelection(): void {}
    write(data: string, callback: () => void): void {
      this.written.push(data);
      this.lines.push(...data.split("\n"));
      queueMicrotask(callback);
    }
    paste(): void {}
    focus(): void {}
    clear(): void {}
    dispose(): void {}
    type(data: string): void {
      this.dataListener?.(data);
    }
  }
  return { FakeTerminal: Fake, terminals: created };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext() {
      return true;
    }
    findPrevious() {
      return true;
    }
    clearDecorations() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// jsdom has no WebGL: pretend WebGL2 exists so the view takes its normal (non-degraded) path.
HTMLCanvasElement.prototype.getContext = (() => ({ getExtension: () => null })) as unknown as HTMLCanvasElement["getContext"];

const WORKSPACE = "7a1c1f7e-8f5b-4b87-9d7c-1f0f3f1f0a01";

function session(id: string, overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id,
    workspaceId: WORKSPACE,
    cwd: "",
    shell: "zsh",
    title: "zsh",
    owner: "user",
    missionId: null,
    cols: 100,
    rows: 30,
    state: "running",
    exitCode: null,
    createdAt: 1,
    ...overrides,
  };
}

class FakePort {
  posted: unknown[] = [];
  closed = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  start(): void {}
  close(): void {
    this.closed = true;
  }
  host(data: unknown): void {
    act(() => this.onmessage?.({ data } as MessageEvent));
  }
}

function setup(existing: TerminalSession[] = []) {
  const ports = new Map<string, FakePort>();
  const portFor = (id: string): FakePort => {
    let port = ports.get(id);
    if (!port) {
      port = new FakePort();
      ports.set(id, port);
    }
    return port;
  };
  const registry: NovaPortRegistry = {
    take: async (_kind, id) => portFor(id) as unknown as MessagePort,
    dispose: () => {},
  };
  type Api = NovaApi["terminal"];
  const api = {
    create: vi.fn<Api["create"]>(async () => session("11111111-1111-4111-8111-111111111111")),
    list: vi.fn<Api["list"]>(async () => existing),
    attach: vi.fn<Api["attach"]>(async ({ sessionId }) => existing.find((s) => s.id === sessionId) ?? session(sessionId)),
    resize: vi.fn<Api["resize"]>(async () => {}),
    kill: vi.fn<Api["kill"]>(async () => {}),
  };
  const store = createTerminalStore();
  const explains: TerminalExplainRequest[] = [];
  const onTakeOver = vi.fn<(id: string) => Promise<TerminalSession>>(async (id: string) => session(id, { owner: "user", title: "pnpm test" }));
  render(
    <TerminalPanel
      api={api}
      ports={registry}
      store={store}
      workspaceId={WORKSPACE}
      onExplain={(request) => explains.push(request)}
      onOpenLink={() => {}}
      onTakeOver={onTakeOver}
      colorScheme="dark"
    />,
  );
  return { api, store, portFor, explains, onTakeOver };
}

afterEach(() => {
  cleanup();
  terminals.length = 0;
});

describe("TerminalPanel", () => {
  it("opens a session, streams output with acks, sends keystrokes and shows a failed exit", async () => {
    const { api, portFor, explains } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Nouveau terminal" }));
    const id = "11111111-1111-4111-8111-111111111111";
    await screen.findByRole("tab", { name: /zsh/ });
    expect(api.create).toHaveBeenCalledWith({ workspaceId: WORKSPACE, cwd: "", cols: 100, rows: 30 });
    // A fresh session uses the port sent with `create`: no attach.
    expect(api.attach).not.toHaveBeenCalled();
    const port = portFor(id);
    await waitFor(() => expect(port.onmessage).not.toBeNull());
    expect(terminals[0]?.options).toMatchObject({ minimumContrastRatio: 4.5, scrollback: 5_000, disableStdin: false });
    expect(screen.queryByText(/mode dégradé/)).toBeNull();

    const output = "Error: token sk-or-v1-0123456789abcdef0123456789abcdef\nboom";
    port.host({ type: "output", data: output });
    await waitFor(() => expect(port.posted).toContainEqual({ type: "ack", chars: output.length }));
    act(() => terminals[0]?.type("ls\r"));
    expect(port.posted).toContainEqual({ type: "input", data: "ls\r" });

    port.host({ type: "exit", exitCode: 2, signal: null });
    expect(await screen.findByText("Échec · code 2")).toBeTruthy();
    expect(screen.getByText("Processus terminé avec le code 2.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expliquer l'erreur" }));
    expect(explains).toHaveLength(1);
    expect(explains[0]).toMatchObject({ sessionId: id, source: "failure", exitCode: 2, shell: "zsh" });
    expect(explains[0]?.text).toContain("boom");
    expect(explains[0]?.text).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("reattaches existing sessions after a reload and replays their screen", async () => {
    const existing = session("22222222-2222-4222-8222-222222222222", { title: "bash", shell: "bash" });
    const { api, portFor } = setup([existing]);
    await screen.findByRole("tab", { name: /bash/ });
    await waitFor(() => expect(api.attach).toHaveBeenCalledWith({ sessionId: existing.id }));
    const port = portFor(existing.id);
    await waitFor(() => expect(port.onmessage).not.toBeNull());
    port.host({ type: "replay", data: "previous screen" });
    expect(terminals.at(-1)?.written).toEqual(["previous screen"]);
  });

  it("keeps agent sessions read-only until the user takes over", async () => {
    const agent = session("33333333-3333-4333-8333-333333333333", {
      owner: "agent",
      missionId: "44444444-4444-4444-8444-444444444444",
      title: "pnpm test",
    });
    const { onTakeOver } = setup([agent]);
    expect(await screen.findByText(/Session de Nomi en lecture seule/)).toBeTruthy();
    await waitFor(() => expect(terminals.at(-1)?.options["disableStdin"]).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Prendre la main" }));
    await waitFor(() => expect(onTakeOver).toHaveBeenCalledWith(agent.id));
    await waitFor(() => expect(screen.queryByText(/lecture seule/)).toBeNull());
    expect(terminals.at(-1)?.options["disableStdin"]).toBe(false);
  });

  it("shows the real error when the terminal is unavailable", async () => {
    const store = createTerminalStore();
    const refuse = async (): Promise<never> => {
      throw new Error("pty-host: node-pty could not be loaded");
    };
    const api: NovaApi["terminal"] = { create: refuse, list: refuse, attach: refuse, resize: refuse, kill: refuse };
    render(
      <TerminalPanel
        api={api}
        ports={{ take: () => new Promise<MessagePort>(() => {}), dispose: () => {} }}
        store={store}
        workspaceId={WORKSPACE}
        onOpenLink={() => {}}
      />,
    );
    expect(await screen.findByText("Terminal indisponible")).toBeTruthy();
    expect(screen.getByText("pty-host: node-pty could not be loaded")).toBeTruthy();
  });
});
