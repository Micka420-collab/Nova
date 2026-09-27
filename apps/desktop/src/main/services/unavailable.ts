// Placeholder implementations for the J2-A IPC groups whose service is not wired yet.
// Every call is refused with the typed `unavailable` code (never a fake success): the renderer shows
// the capability as unavailable instead of pretending it worked. Feature work replaces a group by
// passing its real implementation in `MainApiDeps.atelier` (see ../api.ts).
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";

export const ATELIER_GROUPS = [
  "workspace",
  "files",
  "search",
  "terminal",
  "missions",
  "approvals",
  "permissions",
  "git",
  "mcp",
  "web",
  "companion",
  "checkpoints",
] as const;

export type AtelierGroup = (typeof ATELIER_GROUPS)[number];
export type AtelierApi = Pick<MainApi, AtelierGroup>;

const METHODS = {
  workspace: ["open", "recent", "facts", "close", "setInstructionConsent"],
  files: ["list", "read", "write", "create", "move", "trash"],
  search: ["text", "files"],
  terminal: ["create", "list", "attach", "resize", "kill"],
  missions: ["plan", "start", "pause", "resume", "stop", "list", "get", "review"],
  approvals: ["list", "decide"],
  permissions: ["getProfile", "setProfile"],
  git: ["status", "diff"],
  mcp: ["list", "add", "update", "remove", "test", "tools", "setToolPermission"],
  web: ["getPolicy", "setPolicy"],
  companion: ["state", "act"],
  checkpoints: ["list", "restoreFile", "restoreAll"],
} as const satisfies { [G in AtelierGroup]: readonly (keyof AtelierApi[G])[] };

/** Compile-time proof that METHODS lists every method of every group. */
type Unlisted = { [G in AtelierGroup]: Exclude<keyof AtelierApi[G], (typeof METHODS)[G][number]> }[AtelierGroup];
const everyMethodListed: [Unlisted] extends [never] ? true : false = true;
void everyMethodListed;

function unavailableGroup<G extends AtelierGroup>(group: G): AtelierApi[G] {
  const entries = METHODS[group].map((method) => [
    method,
    () => Promise.reject(new ServiceError("unavailable", `${group}.${method} is not available yet`)),
  ]);
  // Every method of the group is present (checked above) and has the `() => Promise<never>` shape,
  // assignable to any of the group's async methods.
  return Object.fromEntries(entries) as AtelierApi[G];
}

export function unavailableAtelierApi(): AtelierApi {
  return {
    workspace: unavailableGroup("workspace"),
    files: unavailableGroup("files"),
    search: unavailableGroup("search"),
    terminal: unavailableGroup("terminal"),
    missions: unavailableGroup("missions"),
    approvals: unavailableGroup("approvals"),
    permissions: unavailableGroup("permissions"),
    git: unavailableGroup("git"),
    mcp: unavailableGroup("mcp"),
    web: unavailableGroup("web"),
    companion: unavailableGroup("companion"),
    checkpoints: unavailableGroup("checkpoints"),
  };
}
