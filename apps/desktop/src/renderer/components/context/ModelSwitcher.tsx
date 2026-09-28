// L2 (A15) — « Changer de modèle » during a mission: the choice comes from the catalog (models that
// accept tools, other than the current one), the consequence is explained before confirming.
import { useId, useState } from "react";
import { Button } from "@nova/ui";
import type { ModelInfo } from "@nova/shared";
import { contextCopy } from "../../copy/fr-context";
// Side-effect import: the stylesheet ships with the component (emitted as a file, CSP-safe).
// oxlint-disable-next-line import/no-unassigned-import
import "./context.css";

const copy = contextCopy.switcher;

/** Catalog models a running mission can switch to (tool support not refused), sorted by name. */
export function switchCandidates(models: readonly ModelInfo[], currentModelId: string | null): ModelInfo[] {
  return models
    .filter((model) => model.id !== currentModelId && model.supportsTools !== false)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

export interface ModelSwitcherProps {
  models: readonly ModelInfo[];
  currentModelId: string | null;
  /** Resolves once the dossier exists; rejects with the IPC error (the caller shows it). */
  onSwitch(modelId: string): Promise<void>;
  busy?: boolean;
}

export function ModelSwitcher({ models, currentModelId, onSwitch, busy = false }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const candidates = switchCandidates(models, currentModelId);
  const [choice, setChoice] = useState<string>("");
  const selectId = useId();
  const selected = candidates.some((model) => model.id === choice) ? choice : (candidates[0]?.id ?? "");
  if (!open) {
    return (
      <span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {copy.open}
        </Button>
      </span>
    );
  }
  return (
    <div className="nova-context-switcher">
      <p className="nova-note">{copy.explain}</p>
      {candidates.length === 0 ? (
        <p className="nova-note">{copy.none}</p>
      ) : (
        <>
          <label htmlFor={selectId}>{copy.label}</label>
          <select id={selectId} value={selected} onChange={(event) => setChoice(event.target.value)}>
            {candidates.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="nova-context-switcher__actions">
        {candidates.length > 0 ? (
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={() => {
              void onSwitch(selected).then(
                () => setOpen(false),
                () => undefined,
              );
            }}
          >
            {copy.confirm}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          {copy.cancel}
        </Button>
      </div>
    </div>
  );
}
