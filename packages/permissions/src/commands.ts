// Command risk classification (UX 5.12), applied by the engine, never by the model.
// - `forbidden`: refused whatever the profile or contract (wipes the system or home, pipes a
//   download into a shell, escalates privileges, writes raw devices).
// - `dangerous`: irreversible or destructive; asked every time, never rememberable (S6), even in
//   the Autonomous profile.
// - `normal`: left to the contract and the profile.
// argv is classified as given; `sh -c "<script>"` style wrappers are split on shell operators and
// every segment is classified, the worst one wins. This is a heuristic guard, not a shell parser:
// the command itself still runs at the isolation level shown to the user (S3).

export type CommandRisk = "normal" | "dangerous" | "forbidden";

export interface CommandClassification {
  risk: CommandRisk;
  /** French description of what makes the command risky; null for `normal`. */
  label: string | null;
}

const NORMAL: CommandClassification = { risk: "normal", label: null };
const RANK: Record<CommandRisk, number> = { normal: 0, dangerous: 1, forbidden: 2 };

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "pwsh", "powershell", "cmd"]);
const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runas"]);
const DOWNLOADERS = new Set(["curl", "wget", "iwr", "invoke-webrequest", "irm", "invoke-restmethod"]);
/** Wrappers whose remaining argv is the real command. */
const PASS_THROUGH = new Set(["env", "nohup", "time", "nice", "xargs", "command", "exec"]);
const SHELL_OPERATORS = /(\|\||&&|;|\||\n)/;
const SYSTEM_TARGETS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "$HOME/", "${HOME}", "..", "../"]);
const WHOLE_PROJECT_TARGETS = new Set([".", "./", "*", "./*"]);

function base(command: string): string {
  const name = command.split(/[/\\]/).pop() ?? command;
  return name.toLowerCase().replace(/\.exe$/, "");
}

function worst(a: CommandClassification, b: CommandClassification): CommandClassification {
  return RANK[b.risk] > RANK[a.risk] ? b : a;
}

function shortFlags(args: readonly string[]): Set<string> {
  const flags = new Set<string>();
  for (const arg of args) {
    if (/^-[a-zA-Z]+$/.test(arg)) for (const flag of arg.slice(1)) flags.add(flag);
  }
  return flags;
}

function classifyRm(args: readonly string[]): CommandClassification {
  const flags = shortFlags(args);
  const recursive = flags.has("r") || flags.has("R") || args.includes("--recursive");
  const targets = args.filter((arg) => !arg.startsWith("-"));
  const systemTarget = targets.some(
    (target) => SYSTEM_TARGETS.has(target) || /^\/[^/]*$/.test(target) || target.startsWith("~") || target.startsWith("$HOME"),
  );
  if (recursive && systemTarget) return { risk: "forbidden", label: "supprime le système ou le dossier personnel" };
  if (targets.some((target) => WHOLE_PROJECT_TARGETS.has(target))) return { risk: "dangerous", label: "supprime tout le projet" };
  if (recursive || targets.length > 1) return { risk: "dangerous", label: "supprime des fichiers" };
  return NORMAL;
}

function classifyGit(args: readonly string[]): CommandClassification {
  const sub = args.find((arg) => !arg.startsWith("-"));
  const rest = sub ? args.slice(args.indexOf(sub) + 1) : [];
  const flags = shortFlags(rest);
  switch (sub) {
    case "push": {
      const forced =
        flags.has("f") || rest.some((arg) => arg === "--force" || arg.startsWith("--force-with-lease") || arg === "--mirror" || arg.startsWith("+"));
      if (forced) return { risk: "dangerous", label: "réécrit l'historique distant (push forcé)" };
      if (rest.includes("--delete") || flags.has("d")) return { risk: "dangerous", label: "supprime une branche distante" };
      return { risk: "dangerous", label: "envoie des commits vers un dépôt distant" };
    }
    case "reset":
      return rest.includes("--hard") ? { risk: "dangerous", label: "efface les modifications non enregistrées (reset --hard)" } : NORMAL;
    case "clean":
      return flags.has("f") || rest.includes("--force")
        ? { risk: "dangerous", label: "supprime les fichiers non suivis (git clean)" }
        : NORMAL;
    case "checkout":
    case "restore":
      return rest.includes(".") || rest.includes("--") ? { risk: "dangerous", label: "écrase des modifications locales" } : NORMAL;
    case "branch":
      return flags.has("D") || (flags.has("d") && flags.has("f")) ? { risk: "dangerous", label: "supprime une branche" } : NORMAL;
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? { risk: "dangerous", label: "supprime des modifications mises de côté" } : NORMAL;
    case "filter-branch":
    case "filter-repo":
      return { risk: "dangerous", label: "réécrit l'historique" };
    default:
      return NORMAL;
  }
}

function classifySimple(argv: readonly string[]): CommandClassification {
  let index = 0;
  while (index < argv.length && PASS_THROUGH.has(base(argv[index] ?? ""))) {
    index += 1;
    // `env A=1 B=2 cmd`: skip assignments and options of the wrapper.
    while (index < argv.length && /^(-|[A-Za-z_][A-Za-z0-9_]*=)/.test(argv[index] ?? "")) index += 1;
  }
  const command = argv[index];
  if (command === undefined) return NORMAL;
  const name = base(command);
  const args = argv.slice(index + 1);

  if (PRIVILEGE.has(name)) return { risk: "forbidden", label: "demande des droits administrateur" };
  if (name === "mkfs" || name.startsWith("mkfs.") || name === "fdisk" || name === "diskpart" || name === "format")
    return { risk: "forbidden", label: "formate un disque" };
  if (name === "dd" && args.some((arg) => /^of=\/dev\//.test(arg))) return { risk: "forbidden", label: "écrit directement sur un périphérique" };
  if ((name === "chmod" || name === "chown") && args.some((arg) => arg === "/" || arg === "~")) {
    return { risk: "forbidden", label: "change les droits du système" };
  }
  if (name === "shutdown" || name === "reboot" || name === "halt" || name === "poweroff") {
    return { risk: "forbidden", label: "éteint ou redémarre la machine" };
  }
  if (SHELLS.has(name)) {
    const scriptIndex = args.findIndex((arg) => arg === "-c" || arg === "/c" || arg === "-Command" || arg === "-command");
    const script = scriptIndex === -1 ? undefined : args[scriptIndex + 1];
    return script === undefined ? NORMAL : classifyScript(script);
  }
  if (name === "rm" || name === "rmdir" || name === "del" || name === "rd" || name === "remove-item") return classifyRm(args);
  if (name === "git") return classifyGit(args);
  if ((name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") && args[0] === "publish") {
    return { risk: "dangerous", label: "publie un paquet" };
  }
  if (name === "cargo" && args[0] === "publish") return { risk: "dangerous", label: "publie un paquet" };
  if (name === "twine" && args[0] === "upload") return { risk: "dangerous", label: "publie un paquet" };
  if (name === "docker" && (args[0] === "push" || (args[0] === "system" && args[1] === "prune"))) {
    return { risk: "dangerous", label: args[0] === "push" ? "publie une image" : "supprime des données Docker" };
  }
  return NORMAL;
}

/** Splits a shell script on operators; detects `curl … | sh` before splitting. */
function classifyScript(script: string): CommandClassification {
  const segments = script.split(SHELL_OPERATORS);
  let result = NORMAL;
  let previousWasDownload = false;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    if (SHELL_OPERATORS.test(segment) && segment.trim() !== "") {
      // Operator token: a pipe right after a download feeding a shell is the curl|sh pattern.
      if (segment === "|" && previousWasDownload) {
        const next = (segments[i + 1] ?? "").trim().split(/\s+/).filter(Boolean);
        const target = next[0] && PRIVILEGE.has(base(next[0])) ? next[1] : next[0];
        if (target && (SHELLS.has(base(target)) || base(target) === "python" || base(target) === "python3" || base(target) === "node" || base(target) === "iex")) {
          return { risk: "forbidden", label: "exécute un script téléchargé sans le montrer (curl | sh)" };
        }
      }
      continue;
    }
    const argv = segment.trim().split(/\s+/).filter(Boolean).map((token) => token.replace(/^["']|["']$/g, ""));
    if (argv.length === 0) continue;
    previousWasDownload = DOWNLOADERS.has(base(argv[0] ?? ""));
    result = worst(result, classifySimple(argv));
  }
  return result;
}

export function classifyCommand(argv: readonly string[]): CommandClassification {
  if (argv.length === 0) return NORMAL;
  // An argv whose tokens contain a pipe into a shell (`["curl", "x", "|", "sh"]`) only means
  // something through a shell, but the intent is the same: classify it as a script too.
  const direct = classifySimple(argv);
  const joined = argv.some((arg) => SHELL_OPERATORS.test(arg)) ? classifyScript(argv.join(" ")) : NORMAL;
  return worst(direct, joined);
}

/** True when `argv` is one of the project's detected commands (tests, build), extra args allowed. */
export function isKnownCommand(argv: readonly string[], known: readonly (readonly string[])[]): boolean {
  if (argv.some((arg) => SHELL_OPERATORS.test(arg))) return false;
  return known.some((command) => command.length > 0 && command.length <= argv.length && command.every((token, i) => argv[i] === token));
}
