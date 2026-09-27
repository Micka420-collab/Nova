import { useId, useState, type FormEvent } from "react";
import { Button, Callout, IconButton, useToast } from "@nova/ui";
import type { KeyCheckResult, KeyStorage, ProviderConnectionView, VaultLevel } from "@nova/shared";
import { fr } from "../../copy/fr";
import { describeProviderError, describeUiError, errorToast, toUiError } from "../../lib/errors";
import { formatCost } from "../../lib/format";
import { OPENROUTER_KEYS_URL } from "../../lib/links";
import { useApp, useClient } from "../../state/context";
import { ExternalIcon, EyeIcon, EyeOffIcon } from "../icons";

const STORAGE_OPTIONS: Record<VaultLevel, readonly KeyStorage[]> = {
  os: ["vault", "session"],
  weak: ["session", "weak-vault"],
  unavailable: ["session"],
};

const STORAGE_TEXT: Record<KeyStorage, { label: string; hint: string }> = {
  vault: { label: fr.keySetup.storageVault, hint: fr.keySetup.storageVaultHint },
  session: { label: fr.keySetup.storageSession, hint: fr.keySetup.storageSessionHint },
  "weak-vault": { label: fr.keySetup.storageWeak, hint: fr.keySetup.storageWeakHint },
};

export function KeyCheckSummary({ check }: { check: KeyCheckResult }) {
  const money = (value: number | null) => formatCost(value) ?? fr.app.unknown;
  const tier = check.isFreeTier === null ? fr.app.unknown : check.isFreeTier ? fr.keyCheck.freeTier : fr.keyCheck.paidTier;
  return (
    <dl className="nova-facts">
      <dt>{fr.keyCheck.label}</dt>
      <dd>{check.label ?? fr.keyCheck.noLabel}</dd>
      <dt>{fr.keyCheck.limit}</dt>
      <dd>{check.limit === null ? fr.keyCheck.unlimited : money(check.limit)}</dd>
      <dt>{fr.keyCheck.remaining}</dt>
      <dd>{money(check.limitRemaining)}</dd>
      <dt>{fr.keyCheck.usage}</dt>
      <dd>{money(check.usage)}</dd>
      <dt>{fr.keyCheck.tier}</dt>
      <dd>{tier}</dd>
    </dl>
  );
}

/** Verified outcome of a key: check details, or why it could not be verified. */
export function ConnectionOutcome({ connection }: { connection: ProviderConnectionView }) {
  if (connection.state === "valid" && connection.check) {
    return (
      <Callout tone="success" title={fr.keySetup.verifiedTitle}>
        <KeyCheckSummary check={connection.check} />
      </Callout>
    );
  }
  if (connection.state === "unverified" || connection.state === "error") {
    const reason = connection.lastError ? describeProviderError(connection.lastError).title : null;
    return (
      <Callout tone="warning" title={fr.keySetup.unverifiedTitle}>
        <p>{reason ? `${reason}. ${fr.keySetup.unverifiedBody}` : fr.keySetup.unverifiedBody}</p>
      </Callout>
    );
  }
  return null;
}

export interface KeySetupProps {
  /** Called after the key was stored (verified or not). */
  onSaved?: (connection: ProviderConnectionView) => void;
}

export function KeySetup({ onSaved }: KeySetupProps) {
  const client = useClient();
  const toast = useToast();
  const vault = useApp((state) => state.appInfo?.vault ?? null);
  const setKey = useApp((state) => state.setKey);
  const level: VaultLevel = vault?.level ?? "unavailable";
  const options = STORAGE_OPTIONS[level];
  const inputId = useId();
  const [apiKey, setApiKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [chosen, setStorage] = useState<KeyStorage | null>(null);
  // The first option is the recommended one for this vault level.
  const storage: KeyStorage = chosen && options.includes(chosen) ? chosen : (options[0] ?? "session");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [saved, setSaved] = useState<ProviderConnectionView | null>(null);

  const needsAck = storage === "weak-vault" && !acknowledged;
  const canSubmit = apiKey.trim().length > 0 && !needsAck && !busy && vault !== null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const connection = await setKey({ apiKey: apiKey.trim(), storage });
      // The key never stays in renderer memory longer than the request.
      setApiKey("");
      setSaved(connection);
      onSaved?.(connection);
    } catch (caught) {
      const copy = describeUiError(toUiError(caught));
      setError({ title: copy.title, detail: copy.detail });
    } finally {
      setBusy(false);
    }
  }

  function openKeysPage() {
    client.app.openExternal({ url: OPENROUTER_KEYS_URL }).catch((caught: unknown) => {
      toast.show(errorToast(caught, fr.keySetup.createKey));
    });
  }

  const errorId = `${inputId}-error`;
  return (
    <form className="nova-key-setup" onSubmit={(event) => void submit(event)} aria-label={fr.keySetup.title}>
      <p className="nova-key-setup__explanation">{fr.keySetup.explanation}</p>

      <div className="nova-field-row">
        <div className="nv-field nova-field-row__grow">
          <label htmlFor={inputId} className="nv-field__label">
            {fr.keySetup.fieldLabel}
          </label>
          <input
            id={inputId}
            className="nv-field__control nova-key-setup__input"
            type={visible ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder={fr.keySetup.fieldPlaceholder}
            value={apiKey}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError(null);
            }}
          />
        </div>
        <IconButton
          aria-label={visible ? fr.keySetup.hide : fr.keySetup.show}
          aria-pressed={visible}
          icon={visible ? <EyeOffIcon /> : <EyeIcon />}
          variant="secondary"
          onClick={() => setVisible((value) => !value)}
        />
      </div>

      <Button variant="ghost" size="sm" icon={<ExternalIcon size={14} />} onClick={openKeysPage}>
        {fr.keySetup.createKey}
      </Button>

      {level === "weak" ? <Callout tone="warning">{fr.keySetup.weakExplanation}</Callout> : null}
      {level === "unavailable" && vault ? <Callout tone="warning">{fr.keySetup.unavailableExplanation}</Callout> : null}

      <fieldset className="nova-choices">
        <legend className="nv-field__label">{fr.keySetup.storageLegend}</legend>
        {options.map((option) => (
          <label key={option} className="nova-choice">
            <input
              type="radio"
              name={`${inputId}-storage`}
              value={option}
              checked={storage === option}
              onChange={() => setStorage(option)}
            />
            <span className="nova-choice__label">{STORAGE_TEXT[option].label}</span>
            <span className="nova-choice__hint">{STORAGE_TEXT[option].hint}</span>
          </label>
        ))}
        {storage === "weak-vault" ? (
          <label className="nova-choice nova-choice--ack">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span className="nova-choice__label">{fr.keySetup.weakAcknowledge}</span>
          </label>
        ) : null}
      </fieldset>

      {error ? (
        <div id={errorId}>
          <Callout tone="danger" title={error.title}>
            {error.detail ? <p>{error.detail}</p> : null}
          </Callout>
        </div>
      ) : null}
      {saved ? <ConnectionOutcome connection={saved} /> : null}

      <div className="nova-actions">
        <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
          {fr.keySetup.submit}
        </Button>
      </div>
    </form>
  );
}
