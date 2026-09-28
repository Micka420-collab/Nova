import { describe, expect, it } from "vitest";
import type { MissionTask, ToolDisplay } from "@nova/shared";
import { evaluateAcceptance } from "./acceptance";

const TASK: MissionTask = { id: "t1", missionId: "m1", seq: 0, title: "Le test passe", state: "running", acceptance: { kind: "test_passes", detail: "npm test" } };
const tests = (exitCode: number, passed: number | null, failed: number | null): ToolDisplay => ({
  kind: "tests",
  runner: "other",
  passed,
  failed,
  skipped: null,
  exitCode,
  proofId: null,
});

describe("evaluateAcceptance — test_passes", () => {
  it("states only what the runner reported: no « ? » for counts it did not give", () => {
    expect(evaluateAcceptance([TASK], [{ ok: true, display: tests(0, null, null) }])).toEqual([{ taskId: "t1", state: "verified", reason: "tests verts" }]);
    expect(evaluateAcceptance([TASK], [{ ok: false, display: tests(1, null, null) }])).toEqual([{ taskId: "t1", state: "failed", reason: "tests en échec (code 1)" }]);
    expect(evaluateAcceptance([TASK], [{ ok: false, display: tests(1, 3, 2) }])).toEqual([{ taskId: "t1", state: "failed", reason: "tests en échec (2 échec(s), code 1)" }]);
    expect(evaluateAcceptance([TASK], [{ ok: true, display: tests(0, 4, 0) }])).toEqual([{ taskId: "t1", state: "verified", reason: "tests verts (4 réussis)" }]);
  });
});

describe("evaluateAcceptance — only what NOVA really ran counts (A4)", () => {
  const command = (argv: string[], exitCode: number): ToolDisplay => ({
    kind: "command", argv, cwd: "", exitCode, signal: null, durationMs: 1, outputTail: "", outputArtifactId: null, isolationLevel: "L0",
  });
  const BUILD: MissionTask = { ...TASK, id: "b", acceptance: { kind: "command_succeeds", detail: "`pnpm build`" } };

  it("does not verify a command criterion with another command that merely contains it", () => {
    expect(evaluateAcceptance([BUILD], [{ ok: true, display: command(["echo", "pnpm", "build"], 0) }])).toMatchObject([{ state: "todo" }]);
    expect(evaluateAcceptance([BUILD], [{ ok: true, display: command(["sh", "-c", "pnpm build || true"], 0) }])).toMatchObject([{ state: "todo" }]);
    expect(evaluateAcceptance([BUILD], [{ ok: true, display: command(["pnpm", "build"], 0) }])).toMatchObject([{ state: "verified" }]);
    expect(evaluateAcceptance([BUILD], [{ ok: false, display: command(["pnpm", "build"], 2) }])).toMatchObject([{ state: "failed" }]);
  });

  it("leaves a command criterion without a command to the user instead of accepting any command", () => {
    const empty: MissionTask = { ...BUILD, acceptance: { kind: "command_succeeds", detail: " " } };
    expect(evaluateAcceptance([empty], [{ ok: true, display: command(["ls"], 0) }])).toEqual([{ taskId: "b", state: "todo", reason: "à confirmer par toi" }]);
  });

  it("does not count a test run that executed no test as green", () => {
    expect(evaluateAcceptance([TASK], [{ ok: true, display: tests(0, 0, 0) }])).toEqual([{ taskId: "t1", state: "failed", reason: "aucun test exécuté" }]);
  });
});
