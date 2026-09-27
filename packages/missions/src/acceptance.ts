// A4/A9: acceptance criteria are checked against what NOVA actually ran (tool results), never
// against what the model says. Only evidence produced after the last file change counts for
// tests and commands (a pass before an edit proves nothing about the edited code).
import type { MissionTask, MissionTaskState, ToolDisplay } from "@nova/shared";

/** One executed tool result, in execution order. */
export interface AcceptanceEvidence {
  ok: boolean;
  display: ToolDisplay;
}

export interface AcceptanceVerdict {
  taskId: string;
  /** `todo` = not verified yet; manual criteria always stay `todo` ("à confirmer par toi"). */
  state: Extract<MissionTaskState, "todo" | "verified" | "failed">;
  reason: string;
}

function normalizePath(value: string): string {
  return value.trim().replace(/^\.\/+/, "").replace(/^`|`$/g, "");
}

export function evaluateAcceptance(tasks: readonly MissionTask[], evidence: readonly AcceptanceEvidence[]): AcceptanceVerdict[] {
  let lastChange = -1;
  evidence.forEach((item, index) => {
    if (item.ok && item.display.kind === "file_change") lastChange = index;
  });
  const after = evidence.slice(lastChange + 1);

  return tasks.map((task): AcceptanceVerdict => {
    const detail = task.acceptance.detail.trim();
    switch (task.acceptance.kind) {
      case "manual":
        return { taskId: task.id, state: "todo", reason: "à confirmer par toi" };
      case "test_passes": {
        const runs = after.filter((item) => item.display.kind === "tests");
        const last = runs.at(-1);
        if (!last || last.display.kind !== "tests") return { taskId: task.id, state: "todo", reason: "tests non lancés depuis la dernière modification" };
        const passed = last.ok && last.display.exitCode === 0 && (last.display.failed ?? 0) === 0;
        return passed
          ? { taskId: task.id, state: "verified", reason: `tests verts (${String(last.display.passed ?? "?")} réussis)` }
          : { taskId: task.id, state: "failed", reason: `tests en échec (${String(last.display.failed ?? "?")} échec(s), code ${String(last.display.exitCode)})` };
      }
      case "command_succeeds": {
        const matching = after.filter(
          (item) =>
            item.display.kind === "command" &&
            item.display.exitCode !== null &&
            (detail === "" || item.display.argv.join(" ").includes(detail.replace(/^`|`$/g, ""))),
        );
        const last = matching.at(-1);
        if (!last || last.display.kind !== "command") return { taskId: task.id, state: "todo", reason: "commande non lancée depuis la dernière modification" };
        return last.display.exitCode === 0
          ? { taskId: task.id, state: "verified", reason: `\`${last.display.argv.join(" ")}\` a réussi` }
          : { taskId: task.id, state: "failed", reason: `\`${last.display.argv.join(" ")}\` a échoué (code ${String(last.display.exitCode)})` };
      }
      case "file_exists": {
        const path = normalizePath(detail);
        let exists: boolean | null = null;
        for (const item of evidence) {
          if (!item.ok) continue;
          const display = item.display;
          if (display.kind === "file_change" && display.path === path) exists = display.change !== "deleted";
          else if (display.kind === "file_change" && display.change === "moved" && display.fromPath === path) exists = false;
          else if (display.kind === "file_read" && display.path === path) exists = true;
        }
        if (exists === true) return { taskId: task.id, state: "verified", reason: `${path} existe` };
        if (exists === false) return { taskId: task.id, state: "failed", reason: `${path} n'existe plus` };
        return { taskId: task.id, state: "todo", reason: `${path} non vérifié` };
      }
    }
  });
}
