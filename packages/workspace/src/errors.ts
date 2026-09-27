// Typed refusals of the workspace layer. Messages are developer-facing and never contain absolute
// paths (only workspace-relative ones), so they can cross IPC or reach a model as-is.

export type WorkspaceErrorCode =
  /** The path resolves outside the workspace root (S2), e.g. through a symlink or a `..`. */
  | "outside_workspace"
  /** The path is not canonical (see @nova/shared paths). */
  | "invalid_path"
  /** A malformed argument (search regex ripgrep cannot parse, empty commit message…). */
  | "invalid_argument"
  | "not_found"
  | "already_exists"
  | "not_a_directory"
  | "not_a_file"
  /** Excluded by C8 (secrets, keys, .novaignore): never read nor written for the agent. */
  | "excluded_path"
  | "too_large"
  | "binary"
  | "conflict"
  /** A required external program (ripgrep, git) is missing or failed to start. */
  | "unavailable"
  | "cancelled"
  | "failed";

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function isWorkspaceError(error: unknown, code?: WorkspaceErrorCode): error is WorkspaceError {
  return error instanceof WorkspaceError && (code === undefined || error.code === code);
}

/** `ENOENT`-style Node errors. */
export function errnoCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = error.code;
    return typeof code === "string" ? code : null;
  }
  return null;
}
