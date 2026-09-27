import { useEffect, useState } from "react";
import { Badge, Callout, SegmentedControl, Skeleton, StatusPill, useToast } from "@nova/ui";
import type { McpToolInfo, McpToolPermission, UntrustedTextFlag, Workspace } from "@nova/shared";
import { fr } from "../../copy/fr";
import { MCP_PERMISSION_LABELS, UNTRUSTED_FLAG_LABELS } from "../../copy/fr-extensions";
import { describeUiError, errorToast, toUiError } from "../../lib/errors";
import { useClient } from "../../state/context";

const t = fr.extensions;
const PERMISSIONS: readonly McpToolPermission[] = ["allow", "ask", "deny"];

/**
 * Server text shown as data, never as instructions (M5 / W5). The flags come from main's heuristic
 * (`McpToolInfo.descriptionFlags`): a warning only, they never change a permission.
 */
export function UntrustedDescription({ text, flags }: { text: string; flags: readonly UntrustedTextFlag[] }) {
  const flagged = flags.length > 0;
  return (
    <figure className="nova-mcp-untrusted">
      <figcaption className="nova-mcp-untrusted__frame">{t.untrustedFrame}</figcaption>
      <p className="nova-mcp-untrusted__text">
        <span className="nova-mcp-untrusted__prefix">{t.describedBy}</span> {text.trim() || t.noDescription}
      </p>
      {flagged ? (
        <Callout tone="warning" className="nova-mcp-untrusted__warning">
          {t.imperativeWarning} {t.flagsFound(flags.map((flag) => UNTRUSTED_FLAG_LABELS[flag]).join(", "))}
        </Callout>
      ) : null}
    </figure>
  );
}

function hints(tool: McpToolInfo): string[] {
  const list: string[] = [];
  if (tool.annotations.readOnlyHint) list.push(t.hintReadOnly);
  if (tool.annotations.destructiveHint) list.push(t.hintDestructive);
  if (tool.annotations.openWorldHint) list.push(t.hintOpenWorld);
  return list;
}

type Result = { status: "ready"; tools: McpToolInfo[] } | { status: "error"; message: string };

export function McpToolTable({
  serverId,
  workspace,
  refreshKey,
  initialTools,
}: {
  serverId: string;
  workspace: Workspace | null;
  /** Changes when the server was tested or edited: tools are re-read. */
  refreshKey: number;
  /** Tools from a fresh test, shown while the scoped list loads. */
  initialTools: McpToolInfo[] | null;
}) {
  const client = useClient();
  const toast = useToast();
  const [scope, setScope] = useState<"workspace" | "global">(workspace ? "workspace" : "global");
  const scopeId = scope === "workspace" && workspace ? workspace.id : null;
  // Results remember the request they answer: an older key means a read is in flight.
  const requestKey = `${serverId}:${scopeId ?? "global"}:${refreshKey}`;
  const [result, setResult] = useState<{ key: string; value: Result } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const [id, scoped] = requestKey.split(":");
    if (!id) return;
    client.mcp
      .tools({ serverId: id, workspaceId: scoped === "global" ? null : (scoped ?? null) })
      .then((tools) => {
        if (current) setResult({ key: requestKey, value: { status: "ready", tools } });
      })
      .catch((error: unknown) => {
        if (current) setResult({ key: requestKey, value: { status: "error", message: describeUiError(toUiError(error)).title } });
      });
    return () => {
      current = false;
    };
  }, [client, requestKey]);

  const load: Result | { status: "loading" } =
    result === null ? { status: "loading" } : result.key === requestKey ? result.value : result.value.status === "ready" ? result.value : { status: "loading" };

  async function setPermission(tool: McpToolInfo, permission: McpToolPermission) {
    setSaving(tool.name);
    try {
      const updated = await client.mcp.setToolPermission({ serverId, toolName: tool.name, workspaceId: scopeId, permission });
      setResult((previous) =>
        previous?.value.status === "ready"
          ? {
              key: previous.key,
              value: { status: "ready", tools: previous.value.tools.map((item) => (item.name === updated.name ? updated : item)) },
            }
          : previous,
      );
      toast.show({ title: t.permissionSaved, tone: "success" });
    } catch (error) {
      toast.show(errorToast(error, t.permissionFailed));
    } finally {
      setSaving(null);
    }
  }

  const tools = load.status === "ready" ? load.tools : (initialTools ?? null);
  return (
    <section className="nova-mcp-tools" aria-labelledby={`mcp-tools-${serverId}`}>
      <h3 id={`mcp-tools-${serverId}`} className="nova-mcp-subheading">
        {t.toolsHeading}
      </h3>
      {workspace ? (
        <SegmentedControl
          label={t.permissionScope}
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: "workspace", label: t.permissionScopeWorkspace(workspace.name) },
            { value: "global", label: t.permissionScopeGlobal },
          ]}
        />
      ) : (
        <p className="nova-note">{t.permissionScopeGlobal}</p>
      )}
      <p className="nova-note">{t.hintsNote}</p>
      {load.status === "error" ? <Callout tone="danger" title={t.toolsFailed}>{load.message}</Callout> : null}
      {tools === null && load.status === "loading" ? (
        <div aria-busy="true" className="nova-mcp-tools__loading">
          <p className="nv-visually-hidden">{t.toolsLoading}</p>
          <Skeleton height={36} radius={8} />
          <Skeleton height={36} radius={8} />
        </div>
      ) : null}
      {tools && tools.length === 0 ? <p className="nova-note">{t.toolsEmpty}</p> : null}
      {tools && tools.length > 0 ? (
        <ul className="nova-mcp-tools__list">
          {tools.map((tool) => {
            const denied = tool.permission === "deny";
            return (
              <li key={tool.name} className={denied ? "nova-mcp-tool nova-mcp-tool--denied" : "nova-mcp-tool"}>
                <div className="nova-mcp-tool__head">
                  <code className="nova-mcp-tool__name">{tool.name}</code>
                  {denied ? <StatusPill tone="danger">{t.denied}</StatusPill> : null}
                  {hints(tool).map((hint) => (
                    <Badge key={hint} tone="neutral">
                      {hint}
                    </Badge>
                  ))}
                  <SegmentedControl
                    label={t.permissionLabel(tool.name)}
                    size="sm"
                    className="nova-mcp-tool__permission"
                    value={tool.permission}
                    onChange={(permission) => void setPermission(tool, permission)}
                    options={PERMISSIONS.map((value) => ({
                      value,
                      label: MCP_PERMISSION_LABELS[value],
                      disabled: saving === tool.name,
                    }))}
                  />
                </div>
                {tool.qualifiedName ? (
                  <code className="nova-mcp-tool__qualified">{tool.qualifiedName}</code>
                ) : (
                  <p className="nova-mcp-tool__qualified nova-note">{t.notOffered}</p>
                )}
                <UntrustedDescription text={tool.description} flags={tool.descriptionFlags} />
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
