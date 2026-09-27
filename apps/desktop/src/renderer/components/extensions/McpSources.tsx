// Extensions › MCP: where servers come from besides the manual form (M3/M4).
// - The recommended catalog is versioned in @nova/mcp (checked at each release, packages pinned);
//   adding one shows its exact command and asks for its values; secrets go to main's vault.
// - A project's `.mcp.json` is read by main (never expanded) into drafts added DISABLED, to review.
import { useId, useState } from "react";
import { Button, Callout, useToast } from "@nova/ui";
import { MCP_CATALOG, catalogServerInput, type McpCatalogEntry } from "@nova/mcp/catalog";
import type { McpImportDraft, McpServerView, Workspace } from "@nova/shared";
import { fr } from "../../copy/fr";
import { errorToast } from "../../lib/errors";
import { useClient } from "../../state/context";

const t = fr.extensions;

function commandOf(entry: McpCatalogEntry): string {
  return entry.transport.type === "stdio" ? `${entry.transport.command} ${entry.transport.args.join(" ")}` : entry.transport.url;
}

function CatalogEntry({ entry, onAdded }: { entry: McpCatalogEntry; onAdded: (view: McpServerView) => void }) {
  const client = useClient();
  const toast = useToast();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function add() {
    const built = catalogServerInput(entry, values, { scope: "global", workspaceId: null });
    if (!built.ok) {
      setMissing(built.missing);
      return;
    }
    setSaving(true);
    try {
      const view = await client.mcp.add(built.input);
      onAdded(view);
      setOpen(false);
      setValues({});
      toast.show({ title: t.catalogAdded(entry.name), tone: "success" });
    } catch (error) {
      toast.show(errorToast(error, t.saveFailed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="nova-mcp-source">
      <div className="nova-mcp-source__head">
        <strong>{entry.name}</strong>
        <span className="nova-note">
          {entry.publisher} · {t.catalogLicense(entry.license)}
          {entry.forTesting ? ` · ${t.catalogForTesting}` : ""}
        </span>
      </div>
      <p className="nova-note">{entry.description}</p>
      {open ? (
        <form
          className="nova-mcp-source__form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <p className="nova-note">
            {t.catalogCommand} : <code>{commandOf(entry)}</code>
          </p>
          {entry.inputs.map((input) => (
            <label key={input.name} className="nv-field" htmlFor={`${id}-${input.name}`}>
              <span className="nv-field__label">
                {input.label}
                {input.required ? " *" : ""}
              </span>
              <input
                id={`${id}-${input.name}`}
                className="nv-field__control"
                type={input.secret ? "password" : "text"}
                autoComplete="off"
                value={values[input.name] ?? ""}
                onChange={(event) => setValues({ ...values, [input.name]: event.target.value })}
              />
            </label>
          ))}
          {missing.length > 0 ? <p className="nova-note">{t.catalogMissing(missing.join(", "))}</p> : null}
          <div className="nova-actions">
            <Button type="submit" size="sm" variant="primary" loading={saving}>
              {t.catalogAdd(entry.name)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {fr.atelierSettings.common.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {t.catalogAdd(entry.name)}
        </Button>
      )}
    </li>
  );
}

function ProjectImport({ workspace, onAdded }: { workspace: Workspace; onAdded: (view: McpServerView) => void }) {
  const client = useClient();
  const toast = useToast();
  const [drafts, setDrafts] = useState<McpImportDraft[] | null>(null);
  const [reading, setReading] = useState(false);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());

  async function read() {
    setReading(true);
    try {
      setDrafts(await client.mcp.importProject({ workspaceId: workspace.id }));
    } catch (error) {
      toast.show(errorToast(error, t.importFailed));
    } finally {
      setReading(false);
    }
  }

  async function add(draft: McpImportDraft) {
    if (!draft.input) return;
    try {
      onAdded(await client.mcp.add(draft.input));
      setAdded(new Set([...added, draft.name]));
    } catch (error) {
      toast.show(errorToast(error, t.saveFailed));
    }
  }

  return (
    <section className="nova-mcp-sources__block" aria-labelledby="mcp-import">
      <h2 id="mcp-import" className="nova-mcp-subheading">
        {t.importTitle}
      </h2>
      <p className="nova-note">{t.importIntro}</p>
      <Button size="sm" variant="secondary" loading={reading} onClick={() => void read()}>
        {t.importAction}
      </Button>
      {drafts && drafts.length === 0 ? <p className="nova-note">{t.importNone}</p> : null}
      {drafts && drafts.length > 0 ? (
        <ul className="nova-mcp-sources__list">
          {drafts.map((draft) => (
            <li key={draft.name} className="nova-mcp-source">
              <strong>{draft.name}</strong>
              {draft.warnings.length > 0 ? (
                <Callout tone="warning">{draft.warnings.map((warning) => t.importWarnings[warning]).join(" · ")}</Callout>
              ) : null}
              {draft.needsValue.length > 0 ? <p className="nova-note">{t.importNeeds(draft.needsValue.join(", "))}</p> : null}
              {draft.input && !added.has(draft.name) ? (
                <Button size="sm" variant="secondary" onClick={() => void add(draft)}>
                  {t.importAdd}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function McpSources({ workspace, onAdded }: { workspace: Workspace | null; onAdded: (view: McpServerView) => void }) {
  return (
    <div className="nova-mcp-sources">
      <section className="nova-mcp-sources__block" aria-labelledby="mcp-catalog">
        <h2 id="mcp-catalog" className="nova-mcp-subheading">
          {t.catalogTitle}
        </h2>
        <p className="nova-note">{t.catalogIntro}</p>
        <ul className="nova-mcp-sources__list">
          {MCP_CATALOG.map((entry) => (
            <CatalogEntry key={entry.id} entry={entry} onAdded={onAdded} />
          ))}
        </ul>
      </section>
      {workspace ? <ProjectImport workspace={workspace} onAdded={onAdded} /> : null}
    </div>
  );
}
