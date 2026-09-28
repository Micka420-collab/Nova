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
