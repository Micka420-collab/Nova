// P5: report on a watched command from its REAL output and exit code. Counts are only given when
// the output matches a known test-runner summary; otherwise "Commande terminée, code N".
import { NOMI_COPY } from "./copy";
import { baseName } from "./format";

export interface TestCounts {
  passed: number;
  failed: number;
  /** First failing test file, when the runner prints one. */
  firstFailure: string | null;
}

export interface ProcessExitFact {
  exitCode: number | null;
  signal: string | null;
  /** Last lines of combined output (the caller redacts and caps it). */
  outputTail: string;
}

export interface WatchReport {
  text: string;
  ok: boolean;
  tests: TestCounts | null;
}

function count(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

// Terminal colors would break the patterns.
// oxlint-disable-next-line no-control-regex -- ANSI escape sequences are control characters by definition
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Vitest, Jest, pytest and node:test summaries; null for any other format. */
export function parseTestCounts(output: string): TestCounts | null {
  const text = output.replace(ANSI, "");
  let passed: number | null = null;
  let failed: number | null = null;
  const vitest = /^\s*Tests\s+(.+)$/m.exec(text);
  const jest = /^\s*Tests:\s+(.+)$/m.exec(text);
  const summary = jest?.[1] ?? vitest?.[1] ?? null;
  if (summary !== null && /\bpassed\b|\bfailed\b/.test(summary)) {
    passed = count(summary, /(\d+)\s+passed/) ?? 0;
    failed = count(summary, /(\d+)\s+failed/) ?? 0;
  } else {
    const pytest = /^=+\s*(.*\b(?:passed|failed)\b.*?)\s+in\s+[\d.]+s/m.exec(text);
    if (pytest?.[1]) {
      passed = count(pytest[1], /(\d+)\s+passed/) ?? 0;
      failed = count(pytest[1], /(\d+)\s+failed/) ?? 0;
    } else {
      const nodePass = count(text, /^#\s*pass\s+(\d+)/m);
      const nodeFail = count(text, /^#\s*fail\s+(\d+)/m);
      if (nodePass !== null && nodeFail !== null) {
        passed = nodePass;
        failed = nodeFail;
      }
    }
  }
  if (passed === null || failed === null) return null;
  const failure = /^\s*(?:FAIL|×|✗)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)/m.exec(text) ?? /^FAILED\s+(\S+?\.py)/m.exec(text);
  return { passed, failed, firstFailure: failure?.[1] ? baseName(failure[1]) : null };
}

/** The bubble / notification text for a finished watched command. */
export function summarizeProcessExit(exit: ProcessExitFact): WatchReport {
  if (exit.exitCode === null && exit.signal) {
    return { text: NOMI_COPY.watch.interrupted(exit.signal), ok: false, tests: null };
  }
  const tests = parseTestCounts(exit.outputTail);
  const ok = exit.exitCode === 0;
  // Counts come from the output, success only from the exit code: a summary claiming 0 failures
  // with a non-zero exit is still reported as a failed command by `ok`.
  if (tests) return { text: NOMI_COPY.watch.testsDone(tests.passed, tests.failed, tests.firstFailure), ok, tests };
  return { text: NOMI_COPY.watch.commandDone(exit.exitCode), ok, tests: null };
}
