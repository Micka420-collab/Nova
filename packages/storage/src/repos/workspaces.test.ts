import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceFacts } from "@nova/shared";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock = 0;
const now = (): number => (clock += 1);

beforeEach(() => {
  clock = 1000;
  store = openNovaStore(":memory:");
});
afterEach(() => store.close());

describe("workspace repo: consent and facts", () => {
  it("records the D10 consent and returns null for an unknown workspace", () => {
    const repo = createWorkspaceRepo(store.db, now);
    const workspace = repo.upsertByRootPath({ rootPath: "/home/u/app", name: "app" });
    expect(repo.setInstructionFilesConsent(workspace.id, "denied")?.instructionFilesConsent).toBe("denied");
    expect(repo.get(workspace.id)?.instructionFilesConsent).toBe("denied");
    expect(repo.setInstructionFilesConsent("missing", "allowed")).toBeNull();
  });

  it("stores facts per workspace and replaces them on redetection", () => {
    const repo = createWorkspaceRepo(store.db, now);
    const workspace = repo.upsertByRootPath({ rootPath: "/home/u/app", name: "app" });
    expect(repo.getFacts(workspace.id)).toBeNull();
    const facts: WorkspaceFacts = {
      workspaceId: workspace.id,
      detectedAt: 5,
      packageManager: "pnpm",
      languages: ["typescript"],
      frameworks: ["vite", "react"],
      testRunner: { name: "vitest", command: ["pnpm", "run", "test"] },
      devCommand: ["pnpm", "run", "dev"],
      buildCommand: null,
      git: true,
      instructionFiles: ["AGENTS.md"],
    };
    repo.putFacts(facts);
    repo.putFacts({ ...facts, detectedAt: 9, packageManager: null });
    expect(repo.getFacts(workspace.id)).toEqual({ ...facts, detectedAt: 9, packageManager: null });
  });
});
