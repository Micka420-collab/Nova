// The user's shell: $SHELL on POSIX (absolute and existing), else bash, else sh; on Windows pwsh,
// else Windows PowerShell, else %ComSpec% (cmd.exe). Detection only reads the environment and the
// filesystem; nothing is executed.
import { accessSync, constants } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";

export interface ShellChoice {
  file: string;
  args: string[];
  /** Display name without directory or extension (`zsh`, `pwsh`, `cmd`). */
  name: string;
}

export type IsExecutable = (path: string) => boolean;

export const isExecutable: IsExecutable = (path) => {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function shellName(file: string): string {
  return basename(file).replace(/\.(exe|cmd|bat)$/i, "");
}

function onPath(env: Readonly<Record<string, string | undefined>>, exe: string, exists: IsExecutable): string | null {
  const path = env["PATH"] ?? env["Path"] ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function detectUserShell(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  exists: IsExecutable = isExecutable,
): ShellChoice {
  if (platform === "win32") {
    const pwsh = onPath(env, "pwsh.exe", exists);
    if (pwsh) return { file: pwsh, args: ["-NoLogo"], name: "pwsh" };
    const powershell = onPath(env, "powershell.exe", exists);
    if (powershell) return { file: powershell, args: ["-NoLogo"], name: "powershell" };
    const comspec = env["ComSpec"] ?? "cmd.exe";
    return { file: comspec, args: [], name: shellName(comspec) };
  }
  const declared = env["SHELL"];
  if (declared && isAbsolute(declared) && exists(declared)) return { file: declared, args: [], name: shellName(declared) };
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"]) {
    if (exists(candidate)) return { file: candidate, args: [], name: shellName(candidate) };
  }
  return { file: "/bin/sh", args: [], name: "sh" };
}
