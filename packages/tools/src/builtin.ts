// Built-in executors (A2 files, A3 commands, A4 tests, A5 git, W1/W2 web). Thin adapters over the
// injected APIs; each returns what the model needs next plus a UI card.
import { z } from "zod";
import {
  FILE_EDIT_MAX_BYTES,
  TOOL_LIMITS,
  type BuiltinToolName,
  type FileEntry,
  type JsonSchemaObject,
  type OperationClass,
  type RelativePath,
  type ToolDisplay,
} from "@nova/shared";
import type { FileChangeOutcome, ToolDeps } from "./apis";
import { ToolFailure, capText, makeResult, provenance, tail } from "./content";
import type { ExecutedToolResult, OwnerPolicy, ToolExecutionContext, ToolExecutor, ToolPermissionFacts } from "./index";
import { parseTestOutput, testInvocation } from "./test-report";

/** Accepts `./a`, `a/` and `.` from models; anything else must already be canonical (S2 in main). */
function normalizeModelPath(value: string): string {
  let path = value.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (path === ".") path = "";
  return path;
}

const RELATIVE_HINT = "workspace-relative path with '/' separators (no leading '/', no '..')";
// Only the shape is checked here: `..`, absolute or otherwise non-canonical paths reach the
// permission engine as path facts, which refuses them (`outside_workspace`, audited and shown)
// before any executor runs. Rejecting them as bad arguments would hide the refusal and its reason.
const entryPath = z.string().max(4096).describe(RELATIVE_HINT).transform(normalizeModelPath).refine((path) => path !== "", "chemin vide");
const anyPath = z.string().max(4096).describe(`${RELATIVE_HINT}; "" is the root`).transform(normalizeModelPath);

function inputSchema(schema: z.ZodType): JsonSchemaObject {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json["$schema"];
  return json as unknown as JsonSchemaObject;
}

interface BuiltinSpec<S extends z.ZodType> {
  name: BuiltinToolName;
  operation: OperationClass;
  description: string;
  schema: S;
  facts(args: z.output<S>): ToolPermissionFacts[] | Promise<ToolPermissionFacts[]>;
  ownerPolicy?(args: z.output<S>, context: { workspaceId: string; missionHosts: readonly string[] | null }): Promise<OwnerPolicy | null>;
  checkpointPaths?(args: z.output<S>): RelativePath[];
  run(args: z.output<S>, context: ToolExecutionContext, started: number): Promise<ExecutedToolResult>;
}

function builtin<S extends z.ZodType>(spec: BuiltinSpec<S>): ToolExecutor<z.output<S>> {
  const executor: ToolExecutor<z.output<S>> = {
    name: spec.name,
    operation: spec.operation,
    definition: { name: spec.name, description: spec.description, inputSchema: inputSchema(spec.schema), operation: spec.operation },
    argsSchema: spec.schema as unknown as z.ZodType<z.output<S>>,
    permissionFacts: (args) => spec.facts(args),
    checkpointPaths: (args) => spec.checkpointPaths?.(args) ?? [],
    execute: (args, context) => spec.run(args, context, Date.now()),
  };
  if (spec.ownerPolicy) executor.ownerPolicy = spec.ownerPolicy;
  return executor;
}

function numberLines(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(firstLine + index).padStart(width, " ")}│ ${line}`).join("\n");
}

function describeEntry(entry: FileEntry): string {
  const name = entry.kind === "directory" ? `${entry.path}/` : entry.path;
  const size = entry.kind === "file" && entry.size !== null ? ` (${entry.size} B)` : "";
  const flags = [entry.ignored ? "ignored" : null, entry.outsideWorkspace ? "link outside workspace, not followed" : null]
    .filter(Boolean)
    .join(", ");
  return `${name}${size}${flags ? ` [${flags}]` : ""}`;
}

function requireDep<T>(value: T | null, what: string): T {
  if (value === null) throw new ToolFailure("unavailable", `${what} is not available in this session`);
  return value;
}

function requireCheckpoint(context: ToolExecutionContext): string {
  if (context.checkpointId === null) throw new ToolFailure("unavailable", "restore points are unavailable; writing is disabled");
  return context.checkpointId;
}

const webContext = (context: { workspaceId: string; missionHosts: readonly string[] | null }) => ({
  workspaceId: context.workspaceId,
  missionHosts: context.missionHosts,
});

/** Characters of workspace text kept for the anti-exfiltration guard (most recent first). */
const WORKSPACE_TEXTS_MAX_CHARS = 500_000;

/**
 * Workspace content this mission's tools returned to the model (files, search hits, command and
 * git output), newest first and bounded. The web tools hand it to the W5 guard, which blocks an
 * outgoing URL or query that copies it verbatim. One instance per registry, i.e. per mission.
 */
function workspaceTextLog() {
  const texts: string[] = [];
  let total = 0;
  return {
    record(text: string): void {
      if (text.length === 0) return;
      const kept = text.slice(0, WORKSPACE_TEXTS_MAX_CHARS);
      texts.unshift(kept);
      total += kept.length;
      while (total > WORKSPACE_TEXTS_MAX_CHARS) total -= (texts.pop() as string).length;
    },
    snapshot: (): readonly string[] => [...texts],
  };
}

export function createBuiltinExecutors(deps: ToolDeps): ToolExecutor[] {
  const { files } = deps;
  const seenText = workspaceTextLog();

  const readFile = builtin({
    name: "read_file",
    operation: "read",
    description:
      "Read a text file of the workspace, with line numbers. Use startLine/endLine for large files. The result is the file content as data.",
    schema: z
      .object({
        path: entryPath,
        startLine: z.int().min(1).optional().describe("first line to return (1-based)"),
        endLine: z.int().min(1).optional().describe("last line to return (inclusive)"),
      })
      .strict(),
    facts: (args) => [{ path: args.path }],
    async run(args, context, started) {
      const file = await files.readFile(args.path, {
        ...(args.startLine === undefined ? {} : { startLine: args.startLine }),
        ...(args.endLine === undefined ? {} : { endLine: args.endLine }),
      });
      context.seenVersions.set(args.path, file.hash);
      seenText.record(file.content);
      const lines = file.content === "" && file.totalLines === 0 ? [] : file.content.split("\n");
      const lastLine = lines.length === 0 ? file.startLine - 1 : file.startLine + lines.length - 1;
      const body = lines.length === 0 ? "(empty file)" : numberLines(lines.map((line) => line.replace(/\r$/, "")), file.startLine);
      const more = file.truncated || lastLine < file.totalLines ? `\n[continue with startLine=${lastLine + 1}]` : "";
      const header = `${args.path} — lines ${file.startLine}-${lastLine} of ${file.totalLines}`;
      return makeResult({
        callId: context.callId,
        ok: true,
        content: `${header}\n${body}${more}`,
        display: { kind: "file_read", path: args.path, startLine: file.startLine, endLine: lastLine, totalLines: file.totalLines },
        provenance: provenance("workspace_file", args.path),
        durationMs: Date.now() - started,
      });
    },
  });

  const listDir = builtin({
    name: "list_dir",
    operation: "read",
    description: "List one directory level of the workspace (directories end with '/'). \"\" is the root.",
    schema: z.object({ path: anyPath.default("") }).strict(),
    facts: (args) => [args.path === "" ? {} : { path: args.path }],
    async run(args, context, started) {
      const entries = await files.list(args.path);
      const max = 500;
      const shown = entries.slice(0, max);
      const truncated = entries.length > max;
      const text = shown.map(describeEntry).join("\n") || "(empty directory)";
      return makeResult({
        callId: context.callId,
        ok: true,
        content: truncated ? `${text}\n[${entries.length - max} more entries not shown]` : text,
        display: { kind: "file_list", path: args.path, entries: shown, truncated },
        provenance: provenance("workspace_file", args.path || "."),
        durationMs: Date.now() - started,
      });
    },
  });

  const glob = builtin({
    name: "glob",
    operation: "read",
    description: "Find workspace files by glob pattern (e.g. \"src/**/*.ts\"). Ignored and sensitive files are excluded.",
    schema: z
      .object({
        pattern: z.string().min(1).max(500),
        limit: z.int().min(1).max(1_000).default(200),
      })
      .strict(),
    facts: () => [{}],
    async run(args, context, started) {
      const result = await files.glob(args.pattern, args.limit);
      const text = result.paths.join("\n") || "(no match)";
      const entries: FileEntry[] = result.paths.map((path) => ({
        path,
        name: path.split("/").pop() ?? path,
        kind: "file",
        size: null,
        mtimeMs: null,
        ignored: false,
        outsideWorkspace: false,
      }));
      return makeResult({
        callId: context.callId,
        ok: true,
        content: result.truncated ? `${text}\n[more matches may exist: narrow the pattern]` : text,
        display: { kind: "file_list", path: "", entries, truncated: result.truncated },
        provenance: provenance("workspace_file", args.pattern),
        durationMs: Date.now() - started,
      });
    },
  });

  const searchText = builtin({
    name: "search_text",
    operation: "read",
    description: "Search text in the workspace files (ripgrep). Returns matching lines with their path and line number.",
    schema: z
      .object({
        pattern: z.string().min(1).max(1_000),
        isRegex: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        include: z.array(z.string().min(1).max(500)).max(50).default([]).describe("glob filters, e.g. [\"src/**\"]"),
        exclude: z.array(z.string().min(1).max(500)).max(50).default([]),
        maxResults: z.int().min(1).max(500).default(100),
      })
      .strict(),
    facts: () => [{}],
    async run(args, context, started) {
      const result = await files.searchText({ wholeWord: false, ...args }, context.signal);
      seenText.record(result.matches.map((match) => match.lineText).join("\n"));
      const text = result.matches.map((match) => `${match.path}:${match.line}: ${match.lineText}`).join("\n") || "(no match)";
      return makeResult({
        callId: context.callId,
        ok: true,
        content: result.truncated ? `${text}\n[more matches: refine the pattern or add include filters]` : text,
        display: { kind: "search", pattern: args.pattern, matches: result.matches, truncated: result.truncated },
        provenance: provenance("workspace_file", args.pattern),
        durationMs: Date.now() - started,
      });
    },
  });

  function changeResult(
    context: ToolExecutionContext,
    started: number,
    change: Extract<ToolDisplay, { kind: "file_change" }>,
    content: string,
  ): ExecutedToolResult {
    return makeResult({
      callId: context.callId,
      ok: true,
      content,
      display: change,
      provenance: provenance("nova", change.path),
      durationMs: Date.now() - started,
    });
  }

  /** Written outcome, or the conflict explained to the model (nothing was written). */
  function written(outcome: FileChangeOutcome, conflict: string): Extract<FileChangeOutcome, { status: "written" }> {
    if (outcome.status === "conflict") throw new ToolFailure("conflict", conflict);
    return outcome;
  }

  function excerptOf(outcome: Extract<FileChangeOutcome, { status: "written" }>): string {
    if (!outcome.excerpt) return "";
    const lines = outcome.excerpt.text.split("\n").map((line) => line.replace(/\r$/, ""));
    return `\nAround the change:\n${numberLines(lines, outcome.excerpt.startLine)}`;
  }

  const writeFile = builtin({
    name: "write_file",
    operation: "write",
    description:
      "Create a file, or replace a whole file you have read in this mission. Prefer edit_file for changes to existing files.",
    schema: z.object({ path: entryPath, content: z.string().max(FILE_EDIT_MAX_BYTES) }).strict(),
    facts: (args) => [{ path: args.path }],
    checkpointPaths: (args) => [args.path],
    async run(args, context, started) {
      const expectedHash = context.seenVersions.get(args.path) ?? null;
      const outcome = written(
        await files.writeFile(args.path, args.content, { expectedHash, checkpointId: requireCheckpoint(context) }),
        expectedHash === null
          ? `${args.path} already exists: read it first, then use edit_file (or write_file to replace it)`
          : `${args.path} changed since you last read it (probably edited by the user): read it again before changing it`,
      );
      context.seenVersions.set(args.path, outcome.hash);
      return changeResult(
        context,
        started,
        {
          kind: "file_change",
          change: outcome.created ? "created" : "modified",
          path: args.path,
          fromPath: null,
          additions: outcome.additions,
          deletions: outcome.deletions,
          checkpointId: outcome.checkpointId,
        },
        `${outcome.created ? "Created" : "Replaced"} ${args.path} (+${outcome.additions} −${outcome.deletions} lines, ${outcome.size} bytes).`,
      );
    },
  });

  const editFile = builtin({
    name: "edit_file",
    operation: "write",
    description:
      "Edit an existing file by exact text replacement. Each oldText must match exactly once (whitespace included; add surrounding lines to make it unique); all edits apply atomically or none.",
    schema: z
      .object({
        path: entryPath,
        edits: z
          .array(z.object({ oldText: z.string().min(1).max(FILE_EDIT_MAX_BYTES), newText: z.string().max(FILE_EDIT_MAX_BYTES) }).strict())
          .min(1)
          .max(50),
      })
      .strict(),
    facts: (args) => [{ path: args.path }],
    checkpointPaths: (args) => [args.path],
    async run(args, context, started) {
      const seen = context.seenVersions.get(args.path);
      const outcome = written(
        await files.editFile(args.path, args.edits, { ...(seen === undefined ? {} : { expectedHash: seen }), checkpointId: requireCheckpoint(context) }),
        `${args.path} changed since you last read it (probably edited by the user): read it again before editing`,
      );
      context.seenVersions.set(args.path, outcome.hash);
      return changeResult(
        context,
        started,
        {
          kind: "file_change",
          change: "modified",
          path: args.path,
          fromPath: null,
          additions: outcome.additions,
          deletions: outcome.deletions,
          checkpointId: outcome.checkpointId,
        },
        `Edited ${args.path} (${args.edits.length} edit(s), +${outcome.additions} −${outcome.deletions} lines).${excerptOf(outcome)}`,
      );
    },
  });

  const movePath = builtin({
    name: "move_path",
    operation: "write",
    description: "Move or rename a file or directory inside the workspace.",
    schema: z.object({ from: entryPath, to: entryPath }).strict(),
    facts: (args) => [{ path: args.from }, { path: args.to }],
    checkpointPaths: (args) => [args.from, args.to],
    async run(args, context, started) {
      await files.move(args.from, args.to, { checkpointId: requireCheckpoint(context) });
      const hash = context.seenVersions.get(args.from);
      context.seenVersions.delete(args.from);
      if (hash) context.seenVersions.set(args.to, hash);
      return changeResult(
        context,
        started,
        { kind: "file_change", change: "moved", path: args.to, fromPath: args.from, additions: 0, deletions: 0, checkpointId: context.checkpointId },
        `Moved ${args.from} to ${args.to}.`,
      );
    },
  });

  const deletePath = builtin({
    name: "delete_path",
    operation: "delete",
    description: "Move a workspace file or directory to the system trash (restorable).",
    schema: z.object({ path: entryPath }).strict(),
    facts: (args) => [{ path: args.path }],
    checkpointPaths: (args) => [args.path],
    async run(args, context, started) {
      await files.trash(args.path, { checkpointId: requireCheckpoint(context) });
      context.seenVersions.delete(args.path);
      return changeResult(
        context,
        started,
        { kind: "file_change", change: "deleted", path: args.path, fromPath: null, additions: 0, deletions: 0, checkpointId: context.checkpointId },
        `Moved ${args.path} to the trash.`,
      );
    },
  });

  const runCommand = builtin({
    name: "run_command",
    operation: "execute",
    description:
      "Run a program in the workspace WITHOUT a shell: argv is the program and its arguments (no pipes, redirections or '&&'). cwd is workspace-relative. Use background for long-running servers.",
    schema: z
      .object({
        argv: z.array(z.string().max(8_000)).min(1).max(200),
        cwd: anyPath.default(""),
        timeoutMs: z.int().min(1_000).max(TOOL_LIMITS.commandTimeoutMaxMs).default(TOOL_LIMITS.commandTimeoutMs),
        background: z.boolean().default(false),
      })
      .strict(),
    facts: (args) => [{ argv: args.argv, ...(args.cwd === "" ? {} : { path: args.cwd }) }],
    async run(args, context, started) {
      const runner = requireDep(deps.commands, "command execution");
      const spec = { workspaceId: context.workspaceId, missionId: context.missionId, argv: args.argv, cwd: args.cwd, timeoutMs: args.timeoutMs };
      if (args.background) {
        const { process, initialOutput, isolationLevel } = await runner.startBackground(spec, context.onOutput);
        const running = process.state === "running";
        seenText.record(initialOutput);
        return {
          ...makeResult({
            callId: context.callId,
            ok: running,
            content: `${running ? "Started in the background" : `Exited immediately (code ${String(process.exitCode)})`}: ${args.argv.join(" ")} [process ${process.id}]\nFirst output:\n${initialOutput || "(none yet)"}`,
            display: {
              kind: "command", argv: args.argv, cwd: args.cwd, exitCode: process.exitCode, signal: null,
              durationMs: Date.now() - started, outputTail: tail(initialOutput, 4_000), outputArtifactId: null, isolationLevel,
            },
            provenance: provenance("command_output", args.argv.join(" ")),
            durationMs: Date.now() - started,
          }),
          argv: args.argv,
        };
      }
      const outcome = await runner.run(spec, context.signal, context.onOutput);
      if (outcome.cancelled) throw new ToolFailure("cancelled", "the command was stopped");
      seenText.record(outcome.output);
      const status = outcome.timedOut
        ? `Timed out after ${args.timeoutMs} ms (process tree killed)`
        : `Exit code ${String(outcome.exitCode)}${outcome.signal ? ` (signal ${outcome.signal})` : ""}`;
      const output = capText(outcome.output, 20_000).text;
      return {
        ...makeResult({
          callId: context.callId,
          ok: outcome.exitCode === 0 && !outcome.timedOut,
          content: `$ ${args.argv.join(" ")}\n${status}, ${outcome.durationMs} ms.\n${output || "(no output)"}${outcome.truncated ? `\n[only the last part of ${outcome.outputBytes} bytes was kept]` : ""}`,
          display: {
            kind: "command", argv: args.argv, cwd: args.cwd, exitCode: outcome.exitCode, signal: outcome.signal,
            durationMs: outcome.durationMs, outputTail: tail(outcome.output, 4_000), outputArtifactId: null, isolationLevel: outcome.isolationLevel,
          },
          provenance: provenance("command_output", args.argv.join(" ")),
          durationMs: Date.now() - started,
        }),
        argv: args.argv,
      };
    },
  });

  const testArgs = z
    .object({
      filter: z.array(z.string().min(1).max(1_000)).max(20).default([]),
      timeoutMs: z.int().min(1_000).max(TOOL_LIMITS.commandTimeoutMaxMs).default(5 * 60_000),
    })
    .strict();

  const NO_RUNNER = "no test runner was detected in this project; use run_command with the right command";
  /** The project's test command for these arguments; null when no runner was detected. */
  async function invocationFor(filter: string[]) {
    const facts = await deps.facts();
    return facts ? testInvocation(facts, filter) : null;
  }

  const runTests = builtin({
    name: "run_tests",
    operation: "execute",
    description:
      "Run the project's detected test command (Vitest, Jest, pytest, go…) and report passed/failed counts and failures. Optional filter arguments narrow the run (file or test name).",
    schema: testArgs,
    // The engine judges the exact argv that will run (the project's own test command); without a
    // detected runner the call ends as `unavailable` before any permission is asked.
    async facts(args) {
      const invocation = await invocationFor(args.filter);
      if (!invocation) throw new ToolFailure("unavailable", NO_RUNNER);
      return [{ argv: invocation.argv }];
    },
    async run(args, context, started) {
      const runner = requireDep(deps.commands, "command execution");
      const invocation = await invocationFor(args.filter);
      if (!invocation) throw new ToolFailure("unavailable", NO_RUNNER);
      const outcome = await runner.run(
        { workspaceId: context.workspaceId, missionId: context.missionId, argv: invocation.argv, cwd: "", timeoutMs: args.timeoutMs },
        context.signal,
        context.onOutput,
      );
      if (outcome.cancelled) throw new ToolFailure("cancelled", "the tests were stopped");
      seenText.record(outcome.output);
      const report = parseTestOutput(invocation.runner, outcome.output);
      const passedRun = outcome.exitCode === 0 && !outcome.timedOut && (report?.failed ?? 0) === 0;
      const counts = report
        ? `${String(report.passed)} passed, ${String(report.failed)} failed, ${String(report.skipped)} skipped`
        : "counts unknown (report not parsable)";
      const failures = (report?.failures ?? []).map((failure) => `✗ ${failure.name}\n${failure.message}`).join("\n");
      const status = outcome.timedOut ? `timed out after ${args.timeoutMs} ms` : `exit code ${String(outcome.exitCode)}`;
      const rawTail = !report || !passedRun ? `\nOutput (end):\n${tail(outcome.output, 8_000)}` : "";
      return {
        ...makeResult({
          callId: context.callId,
          ok: passedRun,
          content: `$ ${invocation.argv.join(" ")}\nTests ${passedRun ? "PASSED" : "FAILED"} (${status}): ${counts}.${failures ? `\n${failures}` : ""}${rawTail}`,
          display: {
            kind: "tests",
            runner: invocation.runner,
            passed: report?.passed ?? null,
            failed: report?.failed ?? null,
            skipped: report?.skipped ?? null,
            exitCode: outcome.exitCode,
            proofId: null,
          },
          provenance: provenance("command_output", invocation.argv.join(" ")),
          durationMs: Date.now() - started,
        }),
        argv: invocation.argv,
      };
    },
  });

  const gitStatus = builtin({
    name: "git_status",
    operation: "read",
    description: "Show the Git branch and changed files of the workspace.",
    schema: z.object({}).strict(),
    facts: () => [{}],
    async run(_args, context, started) {
      const status = await requireDep(deps.git, "git").status({ workspaceId: context.workspaceId });
      const text = !status.available
        ? "This workspace is not a Git repository (or git is not installed)."
        : [
            `Branch: ${status.branch ?? "(detached HEAD)"}${status.upstream ? ` → ${status.upstream}` : ""}`,
            ...status.entries.map((entry) => `${entry.index}/${entry.worktree} ${entry.origPath ? `${entry.origPath} → ` : ""}${entry.path}`),
            status.entries.length === 0 ? "Working tree clean." : "",
            status.truncated ? "[more entries not shown]" : "",
          ]
            .filter(Boolean)
            .join("\n");
      return makeResult({
        callId: context.callId, ok: true, content: text, display: { kind: "git_status", status },
        provenance: provenance("git", null), durationMs: Date.now() - started,
      });
    },
  });

  const gitDiff = builtin({
    name: "git_diff",
    operation: "read",
    description:
      "Show the unified Git diff of the working tree (or of staged changes), optionally for one path. Excluded sensitive files are listed, never shown.",
    schema: z.object({ path: entryPath.nullable().default(null), staged: z.boolean().default(false) }).strict(),
    facts: (args) => [args.path === null ? {} : { path: args.path }],
    async run(args, context, started) {
      const diff = await requireDep(deps.git, "git").diff({ workspaceId: context.workspaceId, path: args.path, staged: args.staged });
      seenText.record(diff.patch);
      const shown = capText(diff.patch, 100_000);
      const excluded = diff.excluded.length > 0 ? `\n[excluded files not shown (sensitive): ${diff.excluded.join(", ")}]` : "";
      return makeResult({
        callId: context.callId, ok: true, content: `${diff.patch || "(no changes)"}${excluded}`,
        display: { kind: "git_diff", patch: shown.text, truncated: diff.truncated || shown.truncated },
        provenance: provenance("git", args.path), durationMs: Date.now() - started,
      });
    },
  });

  const gitCommit = builtin({
    name: "git_commit",
    operation: "git_mutation",
    description:
      "Commit changes with a clear message: only the given paths when provided, else every change of the workspace INCLUDING new untracked files (pass paths to leave scratch files out). Refused if it would include an excluded sensitive file. Never pushes. The result lists the committed files.",
    schema: z.object({ message: z.string().trim().min(1).max(2_000), paths: z.array(entryPath).max(500).default([]) }).strict(),
    facts: (args) => (args.paths.length > 0 ? args.paths.map((path) => ({ path })) : [{}]),
    async run(args, context, started) {
      const { sha, files: committed } = await requireDep(deps.git, "git").commit(context.workspaceId, {
        message: args.message,
        paths: args.paths.length > 0 ? args.paths : "all",
      });
      const listed = committed.slice(0, 200).join("\n");
      const more = committed.length > 200 ? `\n[${committed.length - 200} more files]` : "";
      return makeResult({
        callId: context.callId, ok: true,
        content: `Committed ${sha.slice(0, 12)}: ${args.message.split("\n")[0] ?? ""}\nFiles (${committed.length}):\n${listed}${more}`,
        display: { kind: "git_commit", sha, message: args.message },
        provenance: provenance("nova", null), durationMs: Date.now() - started,
      });
    },
  });

  const webSearch = builtin({
    name: "web_search",
    operation: "network",
    description: "Search the web (within the project's domain policy). Returns cited results (title, URL, excerpt); cite the URLs you use.",
    schema: z.object({ query: z.string().trim().min(1).max(500), maxResults: z.int().min(1).max(10).default(5) }).strict(),
    facts: () => [{}],
    async run(args, context, started) {
      const { result, content } = await requireDep(deps.web, "web search").webSearch({
        query: args.query,
        maxResults: args.maxResults,
        context: webContext(context),
        usageRef: { conversationId: null, messageId: null, missionId: context.missionId, toolCallId: context.callId },
        workspaceTexts: seenText.snapshot(),
        signal: context.signal,
      });
      return makeResult({
        callId: context.callId,
        ok: true,
        content: result.citations.length > 0 ? content : "No cited result was returned.",
        display: { kind: "web_search", query: result.query, citations: result.citations, costUsd: result.costUsd },
        provenance: provenance("web", args.query),
        durationMs: Date.now() - started,
        prewrapped: result.citations.length > 0,
      });
    },
  });

  const fetchPage = builtin({
    name: "fetch_page",
    operation: "network",
    description: "Read a web page (http/https) as Markdown. Subject to the project's domain policy.",
    schema: z.object({ url: z.url({ protocol: /^https?$/ }).max(2_000) }).strict(),
    facts: (args) => [{ host: new URL(args.url).hostname.toLowerCase() }],
    // W4: the domain policy asks or refuses on top of the permission engine.
    async ownerPolicy(args, context) {
      const web = requireDep(deps.web, "web access");
      const decision = web.decide(args.url, webContext(context));
      if (decision.action === "allow") return null;
      return {
        decision: decision.action,
        reason: "domain_policy",
        detail: decision.action === "deny" ? `the domain policy does not allow ${decision.host}` : `${decision.host} needs the user's approval`,
      };
    },
    async run(args, context, started) {
      const host = new URL(args.url).hostname.toLowerCase();
      // Reaching here means this call was allowed or approved, host included.
      const { page, content } = await requireDep(deps.web, "web access").fetchPage({
        url: args.url,
        context: webContext(context),
        approvedHosts: [host],
        workspaceTexts: seenText.snapshot(),
        signal: context.signal,
      });
      return makeResult({
        callId: context.callId,
        ok: true,
        content,
        display: { kind: "web_page", url: page.finalUrl, title: page.title, truncated: page.truncated },
        provenance: provenance("web", page.finalUrl),
        durationMs: Date.now() - started,
        prewrapped: true,
      });
    },
  });

  return [
    readFile, listDir, glob, searchText, writeFile, editFile, movePath, deletePath,
    runCommand, runTests, gitStatus, gitDiff, gitCommit, webSearch, fetchPage,
  ] as ToolExecutor[];
}
