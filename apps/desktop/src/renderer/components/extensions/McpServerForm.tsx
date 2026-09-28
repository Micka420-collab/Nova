import { useId, useState, type FormEvent } from "react";
import { Button, Dialog, IconButton, SegmentedControl, Switch, TextArea, TextField, useToast } from "@nova/ui";
import type { McpServerView, Workspace } from "@nova/shared";
import { fr } from "../../copy/fr";
import { errorToast } from "../../lib/errors";
import { useClient } from "../../state/context";
import { TrashIcon } from "../icons";
import { emptyForm, formFromConfig, formToInput, newRow, type FormErrors, type KeyValueRow, type McpFormState } from "./mcp-form";

const t = fr.extensions;

function RowsEditor({
  heading,
  addLabel,
  rows,
  errors,
  onChange,
}: {
  heading: string;
  addLabel: string;
  rows: KeyValueRow[];
  errors: FormErrors;
  onChange: (rows: KeyValueRow[]) => void;
}) {
  const patch = (key: string, next: Partial<KeyValueRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...next } : row)));
  return (
    <fieldset className="nova-mcp-rows">
      <legend className="nova-mcp-rows__legend">{heading}</legend>
      {rows.map((row) => (
        <div key={row.key} className="nova-mcp-rows__row">
          <TextField
            label={t.rowName}
            value={row.name}
            autoComplete="off"
            spellCheck={false}
            error={errors[`${row.key}:name`]}
            onChange={(event) => patch(row.key, { name: event.target.value })}
          />
          <TextField
            label={t.rowValue}
            type={row.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={row.value}
            placeholder={row.secret && row.secretRef && row.hint ? `••••${row.hint}` : undefined}
            hint={row.secret && row.secretRef && row.hint && row.value === "" ? t.secretKept(row.hint) : undefined}
            error={errors[`${row.key}:value`]}
            onChange={(event) => patch(row.key, { value: event.target.value })}
          />
          <Switch
            label={t.rowSecret}
            checked={row.secret}
            // Turning a secret back to plain drops the vault reference: the value must be retyped.
            onCheckedChange={(secret) => patch(row.key, secret ? { secret } : { secret, secretRef: null, hint: null })}
          />
          <IconButton
            aria-label={t.rowRemove(row.name)}
            icon={<TrashIcon size={14} />}
            size="sm"
            variant="ghost"
            onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
          />
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => onChange([...rows, newRow()])}>
        {addLabel}
      </Button>
    </fieldset>
  );
}

export function McpServerForm({
  server,
  workspace,
  onClose,
  onSaved,
}: {
  /** null = add a new server. */
  server: McpServerView | null;
  workspace: Workspace | null;
  onClose: () => void;
  onSaved: (view: McpServerView) => void;
}) {
  const client = useClient();
  const toast = useToast();
  const formId = useId();
  const [form, setForm] = useState<McpFormState>(() =>
    server ? formFromConfig(server.config) : { ...emptyForm(), scope: workspace ? "workspace" : "global" },
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<McpFormState>) => setForm((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = formToInput(form, server ? server.config.workspaceId : (workspace?.id ?? null));
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const saved = server
        ? await client.mcp.update({
            serverId: server.config.id,
            name: result.input.name,
            transport: result.input.transport,
            enabled: result.input.enabled,
          })
        : await client.mcp.add(result.input);
      toast.show({ title: t.saved, tone: "success" });
      onSaved(saved);
      onClose();
    } catch (error) {
      toast.show(errorToast(error, t.saveFailed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={server ? t.formEditTitle(server.config.name) : t.formAddTitle}
      description={t.formIntro}
      size="lg"
      className="nova-mcp-form-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>
            {t.save}
          </Button>
        </>
      }
    >
      <form id={formId} className="nova-mcp-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField
          label={t.name}
          value={form.name}
          maxLength={100}
          error={errors.name}
          onChange={(event) => set({ name: event.target.value })}
        />
        {!server && workspace ? (
          <SegmentedControl
            label={t.scope}
            size="sm"
            value={form.scope}
            onChange={(scope) => set({ scope })}
            options={[
              { value: "global", label: t.scopeGlobal },
              { value: "workspace", label: t.scopeWorkspace },
            ]}
          />
        ) : null}
        <SegmentedControl
          label={t.transportLabel}
          size="sm"
          value={form.transport}
          onChange={(transport) => set({ transport })}
          options={[
            { value: "stdio", label: t.transportStdioLabel },
            { value: "http", label: t.transportHttpLabel },
          ]}
        />
        {form.transport === "stdio" ? (
          <>
            <TextField
              label={t.commandLabel}
              hint={t.commandHint}
              value={form.command}
              spellCheck={false}
              error={errors.command}
              onChange={(event) => set({ command: event.target.value })}
            />
            <TextArea
              label={t.argsLabel}
              hint={t.argsHint}
              rows={3}
              spellCheck={false}
              value={form.args}
              onChange={(event) => set({ args: event.target.value })}
            />
            <RowsEditor heading={t.envHeading} addLabel={t.addEnv} rows={form.env} errors={errors} onChange={(env) => set({ env })} />
          </>
        ) : (
          <>
            <TextField
              label={t.urlLabel}
              type="url"
              spellCheck={false}
              placeholder="https://"
              value={form.url}
              error={errors.url}
              onChange={(event) => set({ url: event.target.value })}
            />
            <RowsEditor
              heading={t.headersHeading}
              addLabel={t.addHeader}
              rows={form.headers}
              errors={errors}
              onChange={(headers) => set({ headers })}
            />
          </>
        )}
        <Switch label={t.enabled} checked={form.enabled} onCheckedChange={(enabled) => set({ enabled })} />
        {errors.form ? (
          <p className="nova-mcp-form__error" role="alert">
            {errors.form}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
