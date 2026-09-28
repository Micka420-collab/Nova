// Environment given to child processes that run project or repository code (run_command, git):
// an allowlist of ordinary system variables, never anything credential-shaped. Tokens in NOVA's own
// environment (GITHUB_TOKEN, AWS_*), NODE_OPTIONS and ELECTRON_* must not reach code NOVA did not
// write: a repository's git hook or filter is such code.

const CHILD_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TMPDIR", "TMP", "TEMP", "TZ",
  "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "USERPROFILE", "USERNAME",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
]);
const CHILD_ENV_PREFIX_ALLOWLIST = ["LC_"];

/** Names that look like a credential; refused even when allowlisted or explicitly requested. */
export const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

/**
 * The allowlisted, credential-free subset of `env`. `alsoAllow`: exact extra names a specific child
 * needs, vouched for by its caller (kept even when their name looks credential-shaped, e.g. an
 * agent socket path).
 */
export function scrubChildEnv(
  env: Readonly<Record<string, string | undefined>>,
  alsoAllow: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const allowed = CHILD_ENV_ALLOWLIST.has(name) || CHILD_ENV_PREFIX_ALLOWLIST.some((prefix) => name.startsWith(prefix));
    if ((allowed && !SECRET_ENV_NAME.test(name)) || alsoAllow.includes(name)) result[name] = value;
  }
  return result;
}
