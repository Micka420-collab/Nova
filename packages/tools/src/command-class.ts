// A3: coarse classification of a structured command, input of the permission engine (S1/S6).
// Heuristic by design: it can only make the engine stricter (dangerous → always ask), never
// grant anything by itself.
import type { WorkspaceFacts } from "@nova/shared";

export type CommandClass = "project_script" | "read" | "repo_mutation" | "network" | "dangerous" | "other";

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx"]);
const READ_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "which", "node", "python", "python3", "tsc", "rg", "grep", "find", "tree"]);
const NETWORK_PROGRAMS = new Set(["curl", "wget", "ssh", "scp", "rsync", "nc", "ncat", "telnet", "ftp"]);
const DANGEROUS_PROGRAMS = new Set(["sudo", "su", "doas", "mkfs", "dd", "shutdown", "reboot", "chown", "diskutil", "format"]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "pwsh", "powershell", "cmd", "cmd.exe"]);

function programName(argv0: string): string {
  const base = argv0.split(/[\\/]/).pop() ?? argv0;
  return base.toLowerCase().replace(/\.exe$/, "");
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length >= b.length && b.every((part, index) => a[index] === part);
}

export function classifyCommand(argv: readonly string[], facts: WorkspaceFacts | null = null): CommandClass {
  const [first, ...rest] = argv;
  if (!first) return "other";
  const program = programName(first);
  const flags = new Set(rest);

  if (DANGEROUS_PROGRAMS.has(program) || SHELLS.has(program)) return "dangerous";
  if (program === "rm" && [...flags].some((flag) => /^-[a-zA-Z]*[rR]/.test(flag) || flag === "--recursive")) return "dangerous";
  if (program === "git") {
    const sub = rest.find((part) => !part.startsWith("-")) ?? "";
    if (sub === "push" && (flags.has("--force") || flags.has("-f") || flags.has("--force-with-lease") || flags.has("--mirror"))) return "dangerous";
    if (sub === "reset" && flags.has("--hard")) return "dangerous";
    if (sub === "clean") return "dangerous";
    if (["push", "pull", "fetch", "clone", "remote", "submodule"].includes(sub)) return "network";
    if (["status", "diff", "log", "show", "blame", "rev-parse", "ls-files"].includes(sub)) return "read";
    return "repo_mutation";
  }
  if (NETWORK_PROGRAMS.has(program)) return "network";

  const known = [facts?.testRunner?.command, facts?.buildCommand, facts?.devCommand].filter(
    (command): command is string[] => Array.isArray(command) && command.length > 0,
  );
  if (known.some((command) => sameArgv(argv, command))) return "project_script";
  if (PACKAGE_MANAGERS.has(program)) {
    const sub = rest[0] ?? "";
    if (["install", "i", "add", "update", "upgrade", "publish", "dlx", "create", "exec"].includes(sub) || program.endsWith("x")) return "network";
    if (["test", "run", "build", "lint", "typecheck", "start", "dev"].includes(sub)) return "project_script";
    return "other";
  }
  if (["pip", "pip3", "uv", "poetry", "cargo", "go"].includes(program)) {
    const sub = rest[0] ?? "";
    if (["install", "add", "get", "publish", "sync"].includes(sub)) return "network";
    if (["test", "build", "run", "check", "vet"].includes(sub)) return "project_script";
    return "other";
  }
  if (program === "pytest" || program === "vitest" || program === "jest") return "project_script";
  if (READ_PROGRAMS.has(program)) return "read";
  return "other";
}
