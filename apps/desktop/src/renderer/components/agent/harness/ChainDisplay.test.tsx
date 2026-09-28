import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installDomPolyfills } from "../../../test/dom";
import type { ToolItem } from "../../missions/timeline";
import { ChainCalls, ChainDisplay } from "./ChainDisplay";

installDomPolyfills();
afterEach(cleanup);

describe("ChainDisplay", () => {
  it("shows the outcome, the call count, the duration and the result", () => {
    render(<ChainDisplay display={{ kind: "chain", state: "succeeded", toolCalls: 3, durationMs: 1_450, resultPreview: '{"files":2}' }} />);
    expect(screen.getByText("Programme terminé · 3 appels d’outil · 1,5 s")).toBeTruthy();
    expect(screen.getByText("Résultat du programme")).toBeTruthy();
    expect(screen.getByText('{"files":2}')).toBeTruthy();
  });

  it("says a stopped program's calls already happened, and shows no result", () => {
    render(<ChainDisplay display={{ kind: "chain", state: "limit", toolCalls: 1, durationMs: 200, resultPreview: null }} />);
    expect(screen.getByText("Programme arrêté : limite atteinte · 1 appel d’outil · moins d’une seconde")).toBeTruthy();
    expect(screen.getByText(/Les appels faits avant l’arrêt ont eu lieu/)).toBeTruthy();
    expect(screen.queryByText("Résultat du programme")).toBeNull();
  });
});

describe("ChainCalls", () => {
  const child: ToolItem = {
    kind: "tool", id: "inner-1", seq: 3, at: 3,
    call: { id: "inner-1", name: "read_file", operation: "read", argumentsPreview: "{}", path: "src/a.ts", host: null, argv: null, parentCallId: "chain-1" },
    taskId: null, permission: null, approvalId: null, state: "succeeded", isolationLevel: null, display: null, durationMs: null, output: "",
  };

  it("lists the program's calls with the timeline's own renderer, under the folded program", () => {
    render(
      <ChainCalls
        run={{ callId: "chain-1", programPreview: "await nova.read_file({ path: 'src/a.ts' })", startedAt: 1, summary: null }}
        items={[child]}
        renderItem={(item) => <span>carte {item.id}</span>}
      />,
    );
    expect(screen.getByText("Programme")).toBeTruthy();
    expect(screen.getByRole("list", { name: "1 appel de ce programme" })).toBeTruthy();
    expect(screen.getByText("carte inner-1")).toBeTruthy();
  });

  it("says when the program is unknown and when it made no call", () => {
    render(<ChainCalls run={{ callId: "chain-1", programPreview: null, startedAt: null, summary: null }} items={[]} renderItem={() => null} />);
    expect(screen.getByText("Programme : inconnu (début absent du journal)")).toBeTruthy();
    expect(screen.getByText("Aucun appel d’outil.")).toBeTruthy();
  });
});
