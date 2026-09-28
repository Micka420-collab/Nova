// Skill repo invariants the L3 runtime relies on (harness.test.ts covers replace + basic uninstall).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createSkillRepo, type SkillRepo } from "./skills";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let skills: SkillRepo;
let first: string;
let second: string;
let clock = 0;
const now = (): number => (clock += 1);

const install = (name: string, contentHash = "a".repeat(64)) =>
  skills.upsertInstalled({
    name,
    description: `${name} description`,
    version: null,
    declared: { tools: ["read_file", "Bash"], hosts: ["api.example.com"], scripts: ["scripts/run.sh"] },
    contentHash,
    fileCount: 3,
    totalBytes: 120,
    installDir: name,
  });

beforeEach(() => {
  clock = 0;
  store = openNovaStore(":memory:");
  const workspaces = createWorkspaceRepo(store.db, now);
  first = workspaces.upsertByRootPath({ rootPath: "/one", name: "one" }).id;
  second = workspaces.upsertByRootPath({ rootPath: "/two", name: "two" }).id;
  skills = createSkillRepo(store.db, now);
});
afterEach(() => store.close());

describe("skill repo (L3)", () => {
  it("round-trips the declared permissions and lists installs by name", () => {
    install("zeta");
    install("alpha");
    expect(skills.listInstalled().map((row) => row.name)).toEqual(["alpha", "zeta"]);
    expect(skills.getInstalled("alpha")?.declared).toEqual({ tools: ["read_file", "Bash"], hosts: ["api.example.com"], scripts: ["scripts/run.sh"] });
  });

  it("uninstall removes the enablements of that user skill in every project, and only those", () => {
    install("deploy");
    install("deploy-docs");
    skills.setEnabled(first, "user:deploy", true, "a".repeat(64));
    skills.setEnabled(second, "user:deploy", true, "a".repeat(64));
    skills.setEnabled(first, "user:deploy-docs", true, "a".repeat(64));
    skills.setEnabled(first, "project:deploy", true, "b".repeat(64));
    skills.setEnabled(first, "builtin:comprendre-un-depot", true, "c".repeat(64));

    expect(skills.uninstall("deploy")).toBe(true);
    expect(skills.listEnablements(first).map((row) => row.ref)).toEqual(["builtin:comprendre-un-depot", "project:deploy", "user:deploy-docs"]);
    expect(skills.listEnablements(second)).toEqual([]);
  });

  it("keeps the hash the user saw, and clears it when disabled", () => {
    install("notes");
    expect(skills.setEnabled(first, "user:notes", true, "d".repeat(64))).toMatchObject({ enabled: true, contentHash: "d".repeat(64) });
    expect(skills.setEnabled(first, "user:notes", false, null)).toMatchObject({ enabled: false, contentHash: null });
    expect(skills.enablement(first, "user:notes")).toMatchObject({ enabled: false, contentHash: null });
    expect(skills.enablement(second, "user:notes")).toBeNull();
  });
});
