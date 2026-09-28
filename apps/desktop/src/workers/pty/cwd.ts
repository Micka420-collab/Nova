// Working directory of a session: a canonical workspace-relative path resolved against the realpath
// of the root; the realpath of the result must stay inside the root (symlinks leaving it are
// refused) and be a directory. The shell can `cd` anywhere afterwards: it is the user's shell (E13),
// the confinement guarantees where NOVA starts it, not where the user goes.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isCanonicalRelativePath } from "@nova/shared";

export class CwdError extends Error {
  constructor(
    readonly reason: "invalid" | "outside" | "missing" | "not_a_directory",
    message: string,
  ) {
    super(message);
    this.name = "CwdError";
  }
}

function inside(root: string, absolute: string): boolean {
  if (absolute === root) return true;
  const rel = relative(root, absolute);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function resolveConfinedCwd(root: string, cwd: string): Promise<string> {
  if (!isAbsolute(root)) throw new CwdError("invalid", "workspace root must be absolute");
  if (!isCanonicalRelativePath(cwd)) throw new CwdError("invalid", "invalid relative cwd");
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    real = await realpath(cwd === "" ? realRoot : join(realRoot, ...cwd.split("/")));
  } catch {
    throw new CwdError("missing", "working directory not found");
  }
  if (!inside(realRoot, real)) throw new CwdError("outside", "working directory resolves outside the workspace");
  if (!(await stat(real)).isDirectory()) throw new CwdError("not_a_directory", "working directory is not a folder");
  return real;
}
