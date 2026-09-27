// A4: how to run the project's tests with a machine-readable report, and how to read it.
// Only what the runner reported counts: an unparsable report keeps counts null (never guessed)
// and the exit code alone decides pass/fail.
import type { TestRunnerName, WorkspaceFacts } from "@nova/shared";

export interface ParsedTestReport {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  /** Failing tests with their first failure message line(s), capped. */
  failures: { name: string; message: string }[];
}

const NPM_LIKE = new Set(["npm"]);

function runnerArgs(runner: TestRunnerName): string[] {
  switch (runner) {
    case "vitest":
      return ["--reporter=json"];
    case "jest":
      return ["--json"];
    case "pytest":
      return ["-q", "-rf"];
    case "go":
      return ["-json"];
    default:
      return [];
  }
}

/**
 * Command for the detected runner: the project's own test command with the reporter flags and
 * the optional filter appended (`npm test -- …` needs the separator; pnpm/yarn/bun pass through).
 */
export function testInvocation(
  facts: WorkspaceFacts,
  filter: string[],
): { runner: TestRunnerName; argv: string[] } | null {
  const detected = facts.testRunner;
  if (!detected || detected.command.length === 0) return null;
  const extra = [...runnerArgs(detected.name), ...filter];
  const program = detected.command[0] ?? "";
  const needsSeparator = NPM_LIKE.has(program) && extra.length > 0 && !detected.command.includes("--");
  const argv = [...detected.command, ...(needsSeparator ? ["--"] : []), ...extra];
  return { runner: detected.name, argv };
}

/** Largest JSON object found in the output (reporters may be surrounded by other logs). */
function findJsonObject(output: string): Record<string, unknown> | null {
  let start = output.indexOf("{");
  while (start !== -1) {
    const end = output.lastIndexOf("}");
    if (end <= start) return null;
    try {
      const value: unknown = JSON.parse(output.slice(start, end + 1));
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Try the next opening brace.
    }
    start = output.indexOf("{", start + 1);
  }
  return null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Jest-compatible JSON (Jest `--json`, Vitest `--reporter=json`). */
function parseJestLike(output: string): ParsedTestReport | null {
  const report = findJsonObject(output);
  if (!report || count(report["numTotalTests"]) === null) return null;
  const failures: { name: string; message: string }[] = [];
  const files = Array.isArray(report["testResults"]) ? report["testResults"] : [];
  for (const file of files) {
    const assertions = typeof file === "object" && file !== null ? (file as Record<string, unknown>)["assertionResults"] : null;
    if (!Array.isArray(assertions)) continue;
    for (const assertion of assertions) {
      if (typeof assertion !== "object" || assertion === null) continue;
      const record = assertion as Record<string, unknown>;
      if (record["status"] !== "failed") continue;
      const messages = Array.isArray(record["failureMessages"]) ? record["failureMessages"] : [];
      const first = typeof messages[0] === "string" ? messages[0] : "";
      failures.push({
        name: typeof record["fullName"] === "string" ? record["fullName"] : String(record["title"] ?? "test"),
        message: first.split("\n").slice(0, 6).join("\n").slice(0, 1_000),
      });
      if (failures.length >= 20) break;
    }
  }
  return {
    passed: count(report["numPassedTests"]),
    failed: count(report["numFailedTests"]),
    skipped: (count(report["numPendingTests"]) ?? 0) + (count(report["numTodoTests"]) ?? 0),
    failures,
  };
}

/** pytest final summary line: `=== 3 failed, 10 passed, 1 skipped in 0.52s ===` or `-q` form. */
function parsePytest(output: string): ParsedTestReport | null {
  const lines = output.trimEnd().split(/\r?\n/).reverse();
  const summary = lines.find((line) => /\b(passed|failed|error|errors|no tests ran)\b.*\bin [\d.]+s\b/.test(line));
  if (!summary) return null;
  const pick = (word: string): number => {
    const match = new RegExp(`(\\d+) ${word}`).exec(summary);
    return match?.[1] ? Number(match[1]) : 0;
  };
  const failures = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FAILED "))
    .slice(0, 20)
    .map((line) => {
      const [name, ...rest] = line.slice("FAILED ".length).split(" - ");
      return { name: name ?? line, message: rest.join(" - ").slice(0, 1_000) };
    });
  return { passed: pick("passed"), failed: pick("failed") + pick("errors?"), skipped: pick("skipped"), failures };
}

/** `go test -json` event stream. */
function parseGoJson(output: string): ParsedTestReport | null {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let seen = false;
  const failures: { name: string; message: string }[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event["Test"] !== "string") continue;
      seen = true;
      if (event["Action"] === "pass") passed += 1;
      else if (event["Action"] === "skip") skipped += 1;
      else if (event["Action"] === "fail") {
        failed += 1;
        if (failures.length < 20) failures.push({ name: event["Test"], message: "" });
      }
    } catch {
      // Not an event line.
    }
  }
  return seen ? { passed, failed, skipped, failures } : null;
}

export function parseTestOutput(runner: TestRunnerName, output: string): ParsedTestReport | null {
  switch (runner) {
    case "vitest":
    case "jest":
      return parseJestLike(output);
    case "pytest":
      return parsePytest(output);
    case "go":
      return parseGoJson(output);
    default:
      return null;
  }
}
