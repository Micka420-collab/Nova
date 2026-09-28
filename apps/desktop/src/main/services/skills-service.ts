// skills.* in main (M8, lane L3): the @nova/skills runtime behind the IPC group, the `skill` tool
// (`ToolDeps.skills`) and the mission skill index (`MissionControllerDeps.skillIndex`).
//
// - The only absolute path involved (a folder picked in the native dialog) never leaves main: the
//   renderer asks for `{ kind: "picker" }` and gets a preview back, or null when cancelled.
// - Project skills are read through the workspace registry (canonical root) and the workspace C8
//   matcher (`.novaignore` + sensitive defaults), reloaded when `.novaignore` changes.
// - Runtime refusals become IPC errors with a stable message prefix for the renderer copy:
//   `skill_invalid:<reason>[:<subject>]` for an invalid folder, `skill_preview_required` when a
//   project skill must be previewed (again) before enabling it.
import type { RuntimeLogger } from "@nova/agent-runtime";
import type { SkillRef } from "@nova/shared";
import { SkillError, createSkillsRuntime, type SkillIndex, type SkillsRepoPort, type SkillsRuntime } from "@nova/skills";
import type { SkillsApi } from "@nova/tools";
import { createIgnoreMatcher, type IgnoreMatcher } from "@nova/workspace";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";

export interface SkillsServiceDeps {
  /** `<dataDir>/skills`. */
  skillsDir: string;
  /** `createSkillRepo(store.db)` (@nova/storage). */
  repo: SkillsRepoPort;
  /** Canonical root of a known workspace (workspace registry); throws when unknown. */
  rootOf(workspaceId: string): Promise<string>;
  /** Native folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>;
  logger?: RuntimeLogger;
  /** Tests inject a runtime; default: the @nova/skills runtime over the deps above. */
  runtime?: SkillsRuntime;
}

export interface SkillsService {
  api: MainApi["skills"];
  /** `ToolDeps.skills` of every workspace (the runtime takes the workspace id per call). */
  tools: SkillsApi;
  /** `MissionControllerDeps.skillIndex`: null when no skill is enabled or on failure (logged). */
  skillIndex(workspaceId: string): Promise<SkillIndex | null>;
  /** Startup repair of the skills folder (crash leftovers, orphans). Never throws. */
  init(): Promise<void>;
}

const SILENT: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Runtime refusals → IPC errors (messages are English, secret-free, never file content). */
export function toSkillServiceError(error: unknown): unknown {
  if (!(error instanceof SkillError)) return error;
  switch (error.code) {
    case "invalid_skill": {
      const subject = error.subject ? `:${error.subject.slice(0, 120)}` : "";
      return new ServiceError("invalid_request", `skill_invalid:${error.reason ?? "unknown"}${subject}`);
    }
    case "not_found":
      return new ServiceError("not_found", error.message);
    case "conflict":
      return new ServiceError("conflict", error.message.startsWith("preview_required") ? "skill_preview_required" : "skill_preview_expired");
    case "excluded_path":
      return new ServiceError("invalid_request", "skill_excluded");
    case "invalid_request":
    case "outside_skill":
    case "binary":
      return new ServiceError("invalid_request", error.message);
  }
}

export function createSkillsService(deps: SkillsServiceDeps): SkillsService {
  const logger = deps.logger ?? SILENT;
  const matchers = new Map<string, { root: string; matcher: IgnoreMatcher }>();
  const runtime =
    deps.runtime ??
    createSkillsRuntime({
      skillsDir: deps.skillsDir,
      repo: deps.repo,
      projects: {
        root: (workspaceId) => deps.rootOf(workspaceId),
        async isExcluded(workspaceId, path) {
          const root = await deps.rootOf(workspaceId);
          let cached = matchers.get(workspaceId);
          if (cached?.root !== root) {
            cached = { root, matcher: createIgnoreMatcher(root) };
            matchers.set(workspaceId, cached);
          }
          // `load("")` rereads `.novaignore` when it changed on disk: exclusions are never stale.
          await cached.matcher.load("");
          return cached.matcher.isExcluded(path);
        },
      },
      onRepair: (what) => logger.info("skills folder repaired", { kind: what.kind }),
    });

  const call = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw toSkillServiceError(error);
    }
  };

  return {
    api: {
      list: (req) => call(() => runtime.list(req)),
      get: (req) => call(() => runtime.get(req.ref, req.workspaceId)),
      preview: (req) =>
        call(async () => {
          if (req.source.kind === "project") return runtime.preview(req.source);
          const folder = await deps.pickFolder();
          if (folder === null) return null;
          return runtime.preview({ kind: "folder", absolutePath: folder });
        }),
      install: (req) =>
        call(async () => {
          const meta = await runtime.install(req.previewId);
          logger.info("skill installed", { ref: meta.ref, files: meta.fileCount });
          return meta;
        }),
      uninstall: (req) =>
        call(async () => {
          await runtime.uninstall(req.ref);
          logger.info("skill uninstalled", { ref: req.ref });
        }),
      setEnabled: (req) => call(() => runtime.setEnabled(req.workspaceId, req.ref, req.enabled)),
    },
    tools: {
      enabled: (workspaceId) => runtime.enabled(workspaceId),
      load: (workspaceId, ref: SkillRef, path) => runtime.load(workspaceId, ref, path),
    },
    async skillIndex(workspaceId) {
      try {
        return await runtime.skillIndex(workspaceId);
      } catch (error) {
        logger.warn("skill index unavailable", { code: error instanceof SkillError ? error.code : "internal" });
        return null;
      }
    },
    async init() {
      await runtime.init().catch((error: unknown) => {
        logger.warn("skills folder repair failed", { code: error instanceof SkillError ? error.code : "internal" });
      });
    },
  };
}
