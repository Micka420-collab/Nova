// Built-in executors (A2 files, A3 commands, A4 tests, A5 git, W1/W2 web). Thin adapters over the
// injected APIs; each returns what the model needs next plus a UI card.
import { z } from "zod";
import {
  FILE_EDIT_MAX_BYTES,
  RelativeEntryPathSchema,
  RelativePathSchema,
  TOOL_LIMITS,
  type BuiltinToolName,
  type FileEntry,
  type JsonSchemaObject,
  type OperationClass,
  type RelativePath,
  type ToolDisplay,
  type ToolResult,
} from "@nova/shared";
import type { ToolDeps } from "./apis";
import { ToolFailure, capText, makeResult, provenance, tail } from "./content";
import type { ToolExecutionContext, ToolExecutor, ToolPermissionFacts } from "./index";
import { parseTestOutput, testInvocation } from "./test-report";

/** Accepts `./a`, `a/` and `.` from models; anything else must already be canonical (S2 in main). */
function normalizeModelPath(value: string): string {
  let path = value.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (path === ".") path = "";
  return path;
}

const RELATIVE_HINT = "workspace-relative path with '/' separators (no leading '/', no '..')";
const entryPath = z.string().max(4096).describe(RELATIVE_HINT).transform(normalizeModelPath).pipe(RelativeEntryPathSchema);
const anyPath = z.string().max(4096).describe(`${RELATIVE_HINT}; "" is the root`).transform(normalizeModelPath).pipe(RelativePathSchema);

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
  facts(args: z.output<S>): ToolPermissionFacts[];
  checkpointPaths?(args: z.output<S>): RelativePath[];
  run(args: z.output<S>, context: ToolExecutionContext, started: number): Promise<ToolResult>;
}

function builtin<S extends z.ZodType>(spec: BuiltinSpec<S>): ToolExecutor<z.output<S>> {
  return {
    name: spec.name,
    operation: spec.operation,
    definition: { name: spec.name, description: spec.description, inputSchema: inputSchema(spec.schema), operation: spec.operation },
    argsSchema: spec.schema as unknown as z.ZodType<z.output<S>>,
    permissionFacts: (args) => spec.facts(args),
    checkpointPaths: (args) => spec.checkpointPaths?.(args) ?? [],
    execute: (args, context) => spec.run(args, context, Date.now()),
  };
}

function numberLines(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(firstLine + index).padStart(width, " ")}│ ${line}`).join("\n");
}

/** Line additions/deletions by multiset difference (exact for edits, approximate for moves of lines). */
function lineDelta(before: string | null, after: string): { additions: number; deletions: number } {
  const count = new Map<string, number>();
  for (const line of before === null ? [] : before.split("\n")) count.set(line, (count.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of after.split("\n")) {
    const left = count.get(line) ?? 0;
    if (left > 0) count.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of count.values()) deletions += left;
  return { additions, deletions };
}

async function readText(deps: ToolDeps, workspaceId: string, path: RelativePath) {
  const file = await deps.fs.read({ workspaceId, path });
  if (file.binary) throw new ToolFailure("too_large", `${path} is a binary file; it cannot be read as text`);
  if (file.tooLarge || file.content === null) {
    throw new ToolFailure("too_large", `${path} is larger than ${FILE_EDIT_MAX_BYTES} bytes; read a smaller file or search in it`);
  }
  return { ...file, content: file.content };
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

export function createBuiltinExecutors(deps: ToolDeps): ToolExecutor[] {
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
      const file = await readText(deps, context.workspaceId, args.path);
      context.seenVersions.set(args.path, file.hash);
      const lines = file.content.split(/\r?\n/);
      const start = Math.min(args.startLine ?? 1, Math.max(lines.length, 1));
      const end = Math.min(args.endLine ?? lines.length, lines.length);
      let selected = lines.slice(start - 1, Math.max(end, start - 1));
      let body = numberLines(selected, start);
      let lastLine = start + selected.length - 1;
      if (body.length > TOOL_LIMITS.readMaxChars) {
        // Keep whole lines within the cap and tell the model where to continue.
        let size = 0;
        const kept: string[] = [];
        for (const line of selected) {
          size += line.length + 8;
          if (size > TOOL_LIMITS.readMaxChars) break;
          kept.push(line);
        }
        selected = kept;
        lastLine = start + kept.length - 1;
        body = `${numberLines(kept, start)}\n[truncated: continue with startLine=${lastLine + 1}]`;
      }
      const header = `${args.path} — lines ${start}-${lastLine} of ${lines.length}`;
      return makeResult({
        callId: context.callId,
        ok: true,
        content: `${header}\n${body}`,
        display: { kind: "file_read", path: args.path, startLine: start, endLine: lastLine, totalLines: lines.length },
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
      const entries = await deps.fs.list({ workspaceId: context.workspaceId, path: args.path });
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
    description: "Find workspace files by glob pattern (e.g. \"src/**/*.ts\"). Ignored files are excluded.",
    schema: z
      .object({
        pattern: z.string().min(1).max(500),
        limit: z.int().min(1).max(1_000).default(200),
      })
      .strict(),
    facts: () => [{}],
    async run(args, context, started) {
      const result = await deps.fs.glob({ workspaceId: context.workspaceId, pattern: args.pattern, limit: args.limit }, context.signal);
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
        content: result.truncated ? `${text}\n[more matches: narrow the pattern]` : text,
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
      const result = await deps.fs.searchText(
        { workspaceId: context.workspaceId, wholeWord: false, ...args },
        context.signal,
      );
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
  ): ToolResult {
    return makeResult({
      callId: context.callId,
      ok: true,
      content,
      display: change,
      provenance: provenance("nova", change.path),
      durationMs: Date.now() - started,
    });
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
      const before = expectedHash === null ? null : (await readText(deps, context.workspaceId, args.path)).content;
      const result = await deps.fs.write({ workspaceId: context.workspaceId, path: args.path, content: args.content, expectedHash });
      if (result.status === "conflict") {
        throw new ToolFailure(
          "conflict",
          expectedHash === null
            ? `${args.path} already exists: read it first, then use edit_file (or write_file to replace it)`
            : `${args.path} changed since you last read it (probably edited by the user): read it again before changing it`,
        );
      }
      context.seenVersions.set(args.path, result.hash);
      const delta = lineDelta(before, args.content);
      return changeResult(
        context,
        started,
        { kind: "file_change", change: before === null ? "created" : "modified", path: args.path, fromPath: null, ...delta, checkpointId: context.checkpointId },
        `${before === null ? "Created" : "Replaced"} ${args.path} (+${delta.additions} −${delta.deletions} lines, ${result.size} bytes).`,
      );
    },
  });

  const editFile = builtin({
    name: "edit_file",
    operation: "write",
    description:
      "Edit an existing file by exact text replacement. Each oldText must match exactly once (whitespace included) unless replaceAll is true; all edits apply atomically or none.",
    schema: z
      .object({
        path: entryPath,
        edits: z
          .array(
            z
              .object({
                oldText: z.string().min(1).max(FILE_EDIT_MAX_BYTES),
                newText: z.string().max(FILE_EDIT_MAX_BYTES),
                replaceAll: z.boolean().default(false),
              })
              .strict(),
          )
          .min(1)
          .max(50),
      })
      .strict(),
    facts: (args) => [{ path: args.path }],
    checkpointPaths: (args) => [args.path],
    async run(args, context, started) {
      const file = await readText(deps, context.workspaceId, args.path);
      const crlf = file.eol === "crlf";
      let content = file.content;
      const changedAt: number[] = [];
      for (const [index, edit] of args.edits.entries()) {
        let oldText = edit.oldText;
        let newText = edit.newText;
        if (crlf && !content.includes(oldText) && !oldText.includes("\r\n")) {
          oldText = oldText.replace(/\n/g, "\r\n");
          newText = newText.replace(/\r?\n/g, "\r\n");
        }
        const first = content.indexOf(oldText);
        if (first === -1) {
          throw new ToolFailure("not_found", `edit ${index + 1}: oldText was not found in ${args.path}; read the file and copy the text exactly`);
        }
        if (!edit.replaceAll && content.indexOf(oldText, first + 1) !== -1) {
          throw new ToolFailure("conflict", `edit ${index + 1}: oldText matches several places in ${args.path}; include more surrounding lines or set replaceAll`);
        }
        changedAt.push(content.slice(0, first).split("\n").length);
        content = edit.replaceAll ? content.split(oldText).join(newText) : content.slice(0, first) + newText + content.slice(first + oldText.length);
      }
      if (content.length > FILE_EDIT_MAX_BYTES) throw new ToolFailure("too_large", "the edited file would exceed the size limit");
      const result = await deps.fs.write({ workspaceId: context.workspaceId, path: args.path, content, expectedHash: file.hash });
      if (result.status === "conflict") {
        throw new ToolFailure("conflict", `${args.path} changed while editing (probably by the user): read it again`);
      }
      context.seenVersions.set(args.path, result.hash);
      const lines = content.split(/\r?\n/);
      const snippets = [...new Set(changedAt)].slice(0, 5).map((line) => {
        const from = Math.max(1, line - 3);
        return numberLines(lines.slice(from - 1, Math.min(lines.length, line + 6)), from);
      });
      const delta = lineDelta(file.content, content);
      return changeResult(
        context,
        started,
        { kind: "file_change", change: "modified", path: args.path, fromPath: null, ...delta, checkpointId: context.checkpointId },
        `Edited ${args.path} (${args.edits.length} edit(s), +${delta.additions} −${delta.deletions} lines). Around the changes:\n${snippets.join("\n…\n")}`,
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
      await deps.fs.move({ workspaceId: context.workspaceId, from: args.from, to: args.to });
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
      await deps.fs.trash({ workspaceId: context.workspaceId, path: args.path });
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
        return makeResult({
          callId: context.callId,
          ok: running,
          content: `${running ? "Started in the background" : `Exited immediately (code ${String(process.exitCode)})`}: ${args.argv.join(" ")} [process ${process.id}]\nFirst output:\n${initialOutput || "(none yet)"}`,
          display: {
            kind: "command", argv: args.argv, cwd: args.cwd, exitCode: process.exitCode, signal: null,
            durationMs: Date.now() - started, outputTail: tail(initialOutput, 4_000), outputArtifactId: null, isolationLevel,
          },
          provenance: provenance("command_output", args.argv.join(" ")),
          durationMs: Date.now() - started,
        });
      }
      const outcome = await runner.run(spec, context.signal, context.onOutput);
      if (outcome.cancelled) throw new ToolFailure("cancelled", "the command was stopped");
      const status = outcome.timedOut
        ? `Timed out after ${args.timeoutMs} ms (process tree killed)`
        : `Exit code ${String(outcome.exitCode)}${outcome.signal ? ` (signal ${outcome.signal})` : ""}`;
      const output = capText(outcome.output, 20_000).text;
      return makeResult({
        callId: context.callId,
        ok: outcome.exitCode === 0 && !outcome.timedOut,
        content: `$ ${args.argv.join(" ")}\n${status}, ${outcome.durationMs} ms.\n${output || "(no output)"}${outcome.truncated ? `\n[only the last part of ${outcome.outputBytes} bytes was kept]` : ""}`,
        display: {
          kind: "command", argv: args.argv, cwd: args.cwd, exitCode: outcome.exitCode, signal: outcome.signal,
          durationMs: outcome.durationMs, outputTail: tail(outcome.output, 4_000), outputArtifactId: null, isolationLevel: outcome.isolationLevel,
        },
        provenance: provenance("command_output", args.argv.join(" ")),
        durationMs: Date.now() - started,
      });
    },
  });

  const runTests = builtin({
    name: "run_tests",
    operation: "execute",
    description:
      "Run the project's detected test command (Vitest, Jest, pytest, go…) and report passed/failed counts and failures. Optional filter arguments narrow the run (file or test name).",
    schema: z
      .object({
        filter: z.array(z.string().min(1).max(1_000)).max(20).default([]),
        timeoutMs: z.int().min(1_000).max(TOOL_LIMITS.commandTimeoutMaxMs).default(5 * 60_000),
      })
      .strict(),
    // The argv is only known after reading the facts; the engine sees the project's test command.
    facts: () => [{ argv: ["<project test command>"] }],
    async run(args, context, started) {
      const runner = requireDep(deps.commands, "command execution");
      const facts = await deps.fs.facts({ workspaceId: context.workspaceId, refresh: false });
      const invocation = testInvocation(facts, args.filter);
      if (!invocation) throw new ToolFailure("unavailable", "no test runner was detected in this project; use run_command with the right command");
      const outcome = await runner.run(
        { workspaceId: context.workspaceId, missionId: context.missionId, argv: invocation.argv, cwd: "", timeoutMs: args.timeoutMs },
        context.signal,
        context.onOutput,
      );
      if (outcome.cancelled) throw new ToolFailure("cancelled", "the tests were stopped");
      const report = parseTestOutput(invocation.runner, outcome.output);
      const passedRun = outcome.exitCode === 0 && !outcome.timedOut;
      const counts = report
        ? `${String(report.passed)} passed, ${String(report.failed)} failed, ${String(report.skipped)} skipped`
        : "counts unknown (report not parsable)";
      const failures = (report?.failures ?? []).map((failure) => `✗ ${failure.name}\n${failure.message}`).join("\n");
      const status = outcome.timedOut ? `timed out after ${args.timeoutMs} ms` : `exit code ${String(outcome.exitCode)}`;
      const rawTail = !report || !passedRun ? `\nOutput (end):\n${tail(outcome.output, 8_000)}` : "";
      return makeResult({
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
      });
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
    description: "Show the unified Git diff of the working tree (or of staged changes), optionally for one path.",
    schema: z.object({ path: entryPath.nullable().default(null), staged: z.boolean().default(false) }).strict(),
    facts: (args) => [args.path === null ? {} : { path: args.path }],
    async run(args, context, started) {
      const diff = await requireDep(deps.git, "git").diff({ workspaceId: context.workspaceId, path: args.path, staged: args.staged });
      const shown = capText(diff.patch, 100_000);
      return makeResult({
        callId: context.callId, ok: true, content: diff.patch || "(no changes)",
        display: { kind: "git_diff", patch: shown.text, truncated: diff.truncated || shown.truncated },
        provenance: provenance("git", args.path), durationMs: Date.now() - started,
      });
    },
  });

  const gitCommit = builtin({
    name: "git_commit",
    operation: "git_mutation",
    description: "Commit changes with a clear message (only the given paths when provided). Never pushes.",
    schema: z.object({ message: z.string().trim().min(1).max(2_000), paths: z.array(entryPath).max(500).default([]) }).strict(),
    facts: (args) => (args.paths.length > 0 ? args.paths.map((path) => ({ path })) : [{}]),
    async run(args, context, started) {
      const { sha } = await requireDep(deps.git, "git").commit({ workspaceId: context.workspaceId, message: args.message, paths: args.paths });
      return makeResult({
        callId: context.callId, ok: true, content: `Committed ${sha.slice(0, 12)}: ${args.message.split("\n")[0] ?? ""}`,
        display: { kind: "git_commit", sha, message: args.message },
        provenance: provenance("nova", null), durationMs: Date.now() - started,
      });
    },
  });

  const webSearch = builtin({
    name: "web_search",
    operation: "network",
    description: "Search the web. Returns cited results (title, URL, excerpt); cite the URLs you use.",
    schema: z
      .object({
        query: z.string().trim().min(1).max(500),
        maxResults: z.int().min(1).max(10).default(5),
        includeDomains: z.array(z.string().min(1).max(253)).max(20).default([]),
        excludeDomains: z.array(z.string().min(1).max(253)).max(20).default([]),
      })
      .strict(),
    facts: () => [{}],
    async run(args, context, started) {
      const result = await requireDep(deps.web, "web search").search(
        { workspaceId: context.workspaceId, missionId: context.missionId, ...args },
        context.signal,
      );
      const text = result.citations.map((citation, index) => `[${index + 1}] ${citation.title}\n${citation.url}\n${citation.snippet}`).join("\n\n");
      return makeResult({
        callId: context.callId, ok: true, content: text || "No cited result was returned.",
        display: { kind: "web_search", query: args.query, citations: result.citations, costUsd: result.costUsd },
        provenance: provenance("web", args.query), durationMs: Date.now() - started,
      });
    },
  });

  const fetchPage = builtin({
    name: "fetch_page",
    operation: "network",
    description: "Read a web page (http/https) as Markdown. Subject to the project's domain policy.",
    schema: z.object({ url: z.url({ protocol: /^https?$/ }).max(2_000) }).strict(),
    facts: (args) => [{ host: new URL(args.url).hostname.toLowerCase() }],
    async run(args, context, started) {
      const page = await requireDep(deps.web, "web access").fetchPage(
        { workspaceId: context.workspaceId, missionId: context.missionId, url: args.url },
        context.signal,
      );
      return makeResult({
        callId: context.callId, ok: true,
        content: `${page.title ?? page.finalUrl}\n${page.finalUrl}\n\n${page.markdown}${page.truncated ? "\n[page truncated]" : ""}`,
        display: { kind: "web_page", url: page.finalUrl, title: page.title, truncated: page.truncated },
        provenance: provenance("web", page.finalUrl), durationMs: Date.now() - started,
      });
    },
  });

  return [
    readFile, listDir, glob, searchText, writeFile, editFile, movePath, deletePath,
    runCommand, runTests, gitStatus, gitDiff, gitCommit, webSearch, fetchPage,
  ] as ToolExecutor[];
}
