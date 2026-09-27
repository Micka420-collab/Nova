// Project text search (E4, A2 `search_text`) with ripgrep `--json`, run without a shell.
// ripgrep reports byte offsets; they are converted to UTF-16 offsets of the (truncated) line text.
// Results stream through `onMatches` while ripgrep runs; the process is killed as soon as more than
// `maxResults` matches were seen (`truncated`) or the signal aborts (`cancelled` error).
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isCanonicalRelativePath, type RelativePath, type SearchMatch, type SearchQuery, type SearchResult } from "@nova/shared";
import { WorkspaceError } from "./errors";

export const SEARCH_LINE_MAX_CHARS = 500;

export interface TextSearchOptions {
  /** Absolute path of the ripgrep executable. */
  rgPath: string;
  signal?: AbortSignal;
  /** Called with new matches while the search runs (UI streaming). */
  onMatches?: (matches: SearchMatch[]) => void;
  /** Drops matches in these paths (C8 exclusions for agent searches). */
  isExcluded?: (path: RelativePath) => boolean;
}

type SearchParams = Pick<SearchQuery, "pattern" | "isRegex" | "caseSensitive" | "wholeWord" | "include" | "exclude" | "maxResults">;

export async function ripgrepArgs(root: string, query: SearchParams): Promise<string[]> {
  const args = ["--json", "--no-config", "--hidden", "--no-require-git", "--max-filesize", "5M", "--glob", "!.git"];
  const hasNovaIgnore = await access(join(root, ".novaignore")).then(
    () => true,
    () => false,
  );
  if (hasNovaIgnore) args.push("--ignore-file", join(root, ".novaignore"));
  args.push(query.caseSensitive ? "--case-sensitive" : "--ignore-case");
  if (!query.isRegex) args.push("--fixed-strings");
  if (query.wholeWord) args.push("--word-regexp");
  for (const glob of query.include) args.push("--glob", glob);
  for (const glob of query.exclude) args.push("--glob", `!${glob}`);
  // `-e` keeps a pattern starting with "-" from being read as a flag; "." avoids reading stdin.
  args.push("-e", query.pattern, "--", ".");
  return args;
}

interface RgText {
  text?: string;
}
interface RgMatchData {
  path?: RgText;
  lines?: RgText;
  line_number?: number;
  submatches?: { start: number; end: number }[];
}

function utf16Offset(bytes: Buffer, byteOffset: number): number {
  return bytes.subarray(0, byteOffset).toString("utf8").length;
}

/** Converts one ripgrep `match` record; null for non-UTF-8 paths or lines (reported as bytes). */
export function toSearchMatch(data: RgMatchData): SearchMatch | null {
  const rawPath = data.path?.text;
  const rawLine = data.lines?.text;
  if (rawPath === undefined || rawLine === undefined || typeof data.line_number !== "number") return null;
  const path = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  const normalized = path.split("\\").join("/");
  if (!isCanonicalRelativePath(normalized) || normalized === "") return null;
  const line = rawLine.replace(/\r?\n$/, "");
  const bytes = Buffer.from(line, "utf8");
  const lineText = line.length > SEARCH_LINE_MAX_CHARS ? line.slice(0, SEARCH_LINE_MAX_CHARS) : line;
  const ranges = (data.submatches ?? [])
    .map((sub) => ({
      start: Math.min(utf16Offset(bytes, sub.start), lineText.length),
      end: Math.min(utf16Offset(bytes, sub.end), lineText.length),
    }))
    .filter((range) => range.end > range.start);
  return { path: normalized, line: data.line_number, lineText, ranges };
}

export function searchText(root: string, query: SearchParams, options: TextSearchOptions): Promise<SearchResult> {
  const started = performance.now();
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(new WorkspaceError("cancelled", "search cancelled"));

  return ripgrepArgs(root, query).then(
    (args) =>
      new Promise<SearchResult>((resolve, reject) => {
        const child = spawn(options.rgPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const matches: SearchMatch[] = [];
        let batch: SearchMatch[] = [];
        let truncated = false;
        let finished = false;
        let stderr = "";

        const flushBatch = (): void => {
          if (batch.length > 0 && options.onMatches) options.onMatches(batch);
          batch = [];
        };
        const finish = (outcome: { error: WorkspaceError } | { result: SearchResult }): void => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", onAbort);
          if ("error" in outcome) reject(outcome.error);
          else resolve(outcome.result);
        };
        const onAbort = (): void => {
          child.kill();
          finish({ error: new WorkspaceError("cancelled", "search cancelled") });
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const lines = createInterface({ input: child.stdout });
        lines.on("line", (text) => {
          if (truncated || finished) return;
          let record: { type?: string; data?: RgMatchData };
          try {
            record = JSON.parse(text) as { type?: string; data?: RgMatchData };
          } catch {
            return;
          }
          if (record.type !== "match" || !record.data) return;
          const match = toSearchMatch(record.data);
          if (!match || options.isExcluded?.(match.path)) return;
          if (matches.length >= query.maxResults) {
            truncated = true;
            child.kill();
            return;
          }
          matches.push(match);
          batch.push(match);
          if (batch.length >= 50) flushBatch();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 2_000) stderr += chunk.toString("utf8");
        });
        child.on("error", () => finish({ error: new WorkspaceError("unavailable", "ripgrep could not start") }));
        // "close" fires after stdout ended, so every line was parsed.
        child.on("close", (code) => {
          flushBatch();
          // 0 = matches, 1 = none, 2 = some files unreadable (partial results are still valid).
          if (!truncated && code !== 0 && code !== 1 && !(code === 2 && matches.length > 0)) {
            const regexError = /regex|parse error/i.test(stderr);
            finish({
              error: new WorkspaceError(regexError ? "invalid_argument" : "failed", regexError ? "invalid regular expression" : "ripgrep failed"),
            });
            return;
          }
          finish({ result: { matches, truncated, durationMs: Math.round(performance.now() - started) } });
        });
      }),
  );
}
