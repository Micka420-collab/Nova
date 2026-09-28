// Environment of a terminal session. The pty-host already runs with main's scrubbed worker
// environment (main/workers.ts `scrubEnv`); the shell gets a still narrower allowlist, plus the
// terminal identity. Never credentials, never NOVA_*, ELECTRON_* or NODE_OPTIONS.

/** Names a shell needs to behave like the user's own terminal (exact, case-sensitive on POSIX). */
const PTY_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TMPDIR",
  "TZ",
  // GUI programs started from the terminal (xdg-open, editors) need the display.
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  // AppImage and non-standard installs: programs must find the same shared libraries.
  "LD_LIBRARY_PATH",
  // Windows: shells do not start without these.
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "TEMP",
  "TMP",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
]);

const PTY_ENV_PREFIXES = ["LC_"];

/** Same rule as main's scrubEnv: an allowlisted-looking name that smells like a credential is dropped. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

export function buildPtyEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const allowed = PTY_ENV_ALLOWLIST.has(name) || PTY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (allowed && !SECRET_NAME.test(name)) env[name] = value;
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  env["TERM_PROGRAM"] = "NOVA";
  return env;
}
