// Réglages › Internet (W4): domain policy per scope (all projects or the open one), presets, rules.
// Saving is explicit. Private/loopback ranges are refused by main whatever these rules say.
import { useState } from "react";
import { Button, Callout, IconButton, SegmentedControl, TextField, useToast } from "@nova/ui";
import {
  HostPatternSchema,
  WEB_POLICY_PRESETS,
  type WebPolicy,
  type WebPolicyPreset,
  type WebRuleAction,
} from "@nova/shared";
import { fr } from "../../copy/fr";
import { WEB_ACTION_LABELS, WEB_PRESET_COPY } from "../../copy/fr-settings-atelier";
import { errorToast } from "../../lib/errors";
import { useApp, useClient } from "../../state/context";
import { TrashIcon } from "../icons";
import { SectionError, SectionLoading, useLoaded } from "./section-states";

const copy = fr.atelierSettings.internet;
const ACTIONS: readonly WebRuleAction[] = ["allow", "ask", "deny"];

interface RuleDraft {
  key: number;
  pattern: string;
  action: WebRuleAction;
  preset: WebPolicyPreset | null;
}

/** Error of one pattern, or null when valid. Exported for tests. */
export function hostPatternError(pattern: string): string | null {
  const value = pattern.trim();
  if (value === "") return copy.empty;
  return HostPatternSchema.safeParse(value).success ? null : copy.invalid(value);
}

function ActionSelect({ label, value, onChange }: { label: string; value: WebRuleAction; onChange: (value: WebRuleAction) => void }) {
  return (
    <select
      aria-label={label}
      className="nv-field__control nova-aset-select"
      value={value}
      onChange={(event) => onChange(event.target.value as WebRuleAction)}
    >
      {ACTIONS.map((action) => (
        <option key={action} value={action}>
          {WEB_ACTION_LABELS[action]}
        </option>
      ))}
    </select>
  );
}

function PolicyEditor({ policy, onSaved }: { policy: WebPolicy; onSaved: (next: WebPolicy) => void }) {
  const client = useClient();
  const toast = useToast();
  const [defaultAction, setDefaultAction] = useState<WebRuleAction>(policy.defaultAction);
  const [nextKey, setNextKey] = useState(policy.rules.length);
  const [rules, setRules] = useState<RuleDraft[]>(() =>
    policy.rules.map((rule, index) => ({ key: index, pattern: rule.pattern, action: rule.action, preset: rule.preset })),
  );
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState<"save" | WebPolicyPreset | null>(null);
  const errors = rules.map((rule) => hostPatternError(rule.pattern));
  const invalid = errors.some((error) => error !== null);

  const patch = (key: number, change: Partial<RuleDraft>) =>
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...change, preset: null } : rule)));

  async function submit(preset: WebPolicyPreset | null) {
    if (preset === null && invalid) {
      setShowErrors(true);
      return;
    }
    setSaving(preset ?? "save");
    try {
      // A preset replaces preset-created rules in main; the user's own (valid) rules are sent along.
      const own = rules.filter((rule, index) => errors[index] === null && (preset === null || rule.preset === null));
      const next = await client.web.setPolicy({
        workspaceId: policy.workspaceId,
        defaultAction,
        rules: own.map((rule) => ({ pattern: rule.pattern.trim(), action: rule.action })),
        preset,
      });
      onSaved(next);
      toast.show({
        title: preset ? copy.presetApplied(WEB_PRESET_COPY[preset].label) : fr.atelierSettings.common.saved,
        tone: "success",
      });
    } catch (error) {
      toast.show(errorToast(error, fr.atelierSettings.common.saveFailed));
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <div className="nova-setting">
        <p className="nv-field__label">{copy.defaultAction}</p>
        <SegmentedControl<WebRuleAction>
          label={copy.defaultAction}
          value={defaultAction}
          onChange={setDefaultAction}
          options={ACTIONS.map((action) => ({ value: action, label: WEB_ACTION_LABELS[action] }))}
        />
      </div>

      <h3 className="nova-subheading">{copy.presetsTitle}</h3>
      <ul className="nova-aset-presets">
        {WEB_POLICY_PRESETS.map((preset) => (
          <li key={preset}>
            <Button variant="secondary" size="sm" loading={saving === preset} disabled={saving !== null} onClick={() => void submit(preset)}>
              {WEB_PRESET_COPY[preset].label}
            </Button>
            <span className="nova-note">{WEB_PRESET_COPY[preset].hint}</span>
          </li>
        ))}
      </ul>
      <p className="nova-note">{copy.presetHint}</p>

      <h3 className="nova-subheading">{copy.rulesTitle}</h3>
      {rules.length === 0 ? <p className="nova-aset-empty">{copy.rulesEmpty}</p> : null}
      <ol className="nova-aset-rules">
        {rules.map((rule, index) => (
          <li key={rule.key} className="nova-aset-rule">
            <TextField
              label={copy.pattern(index + 1)}
              hideLabel
              value={rule.pattern}
              placeholder="exemple.com"
              error={showErrors ? errors[index] : undefined}
              onChange={(event) => patch(rule.key, { pattern: event.target.value })}
            />
            <ActionSelect label={copy.action(index + 1)} value={rule.action} onChange={(action) => patch(rule.key, { action })} />
            {rule.preset ? <span className="nova-aset-tag">{copy.fromPreset}</span> : null}
            <IconButton
              aria-label={copy.remove(index + 1)}
              icon={<TrashIcon size={14} />}
              size="sm"
              onClick={() => setRules((current) => current.filter((item) => item.key !== rule.key))}
            />
          </li>
        ))}
      </ol>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setRules((current) => [...current, { key: nextKey, pattern: "", action: "allow", preset: null }]);
          setNextKey((key) => key + 1);
        }}
      >
        {copy.add}
      </Button>

      <Callout tone="info">{copy.always}</Callout>
      <div className="nova-actions">
        <Button variant="primary" loading={saving === "save"} disabled={saving !== null} onClick={() => void submit(null)}>
          {fr.atelierSettings.common.save}
        </Button>
      </div>
    </>
  );
}

export function InternetSection() {
  const workspace = useApp((state) => state.workspace.current);
  const client = useClient();
  const [scope, setScope] = useState<"global" | "workspace">("global");
  const workspaceId = scope === "workspace" && workspace ? workspace.id : null;
  const [loaded, retry, replace] = useLoaded<WebPolicy>(workspaceId ?? "global", () => client.web.getPolicy({ workspaceId }));

  return (
    <div className="nova-aset">
      {workspace ? (
        <div className="nova-setting">
          <p className="nv-field__label">{copy.scopeLabel}</p>
          <SegmentedControl<"global" | "workspace">
            label={copy.scopeLabel}
            value={scope}
            onChange={setScope}
            options={[
              { value: "global", label: copy.scopeGlobal },
              { value: "workspace", label: copy.scopeWorkspace(workspace.name) },
            ]}
          />
        </div>
      ) : null}
      {loaded.status === "loading" ? <SectionLoading /> : null}
      {loaded.status === "error" ? <SectionError error={loaded.error} onRetry={retry} /> : null}
      {loaded.status === "ready" ? (
        // Keyed by the saved policy: a save or a scope change resets the draft to main's answer.
        <PolicyEditor key={`${workspaceId ?? "global"}:${JSON.stringify(loaded.data)}`} policy={loaded.data} onSaved={replace} />
      ) : null}
    </div>
  );
}
