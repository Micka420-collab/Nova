import { useState, type JSX } from "react";
import {
  Button,
  Callout,
  ComponentGallery,
  Kbd,
  SegmentedControl,
  StatusPill,
  Switch,
  useToast,
  type BadgeTone,
} from "@nova/ui";
import type { ConnectionState, MotionPreference, SettingsPatch, ThemePreference } from "@nova/shared";
import { CONNECTION_STATE_LABELS, fr, KEY_STORAGE_LABELS, VAULT_LEVEL_COPY } from "../../copy/fr";
import { describeProviderError, errorToast } from "../../lib/errors";
import { formatRelative } from "../../lib/format";
import { OPENROUTER_KEYS_URL } from "../../lib/links";
import { MOD_KEY } from "../../lib/platform";
import { useNow } from "../../lib/hooks";
import { useApp, useClient } from "../../state/context";
import type { SettingsSection } from "../../state/store";
import { ExternalIcon } from "../icons";
import { ConfirmDialog } from "../layout/ConversationDialogs";
import { ModelBrowser } from "../models/ModelBrowser";
import { findModel } from "../models/filter";
import { KeyCheckSummary, KeySetup } from "../setup/KeySetup";
import { AuditSection, BudgetSection, InternetSection, PermissionsSection } from "./AtelierSections";

const SECTIONS: readonly SettingsSection[] = [
  "providers",
  "models",
  "budget",
  "permissions",
  "internet",
  "audit",
  "privacy",
  "appearance",
  "companion",
  "shortcuts",
  "diagnostics",
];

const STATE_TONES: Record<ConnectionState, BadgeTone> = {
  absent: "neutral",
  unverified: "amber",
  valid: "jade",
  invalid: "danger",
  error: "amber",
};

function useSaveSetting(): (patch: SettingsPatch) => void {
  const updateSettings = useApp((state) => state.updateSettings);
  const toast = useToast();
  return (patch) => {
    updateSettings(patch).catch((error: unknown) => toast.show(errorToast(error, fr.settings.saveFailed)));
  };
}

function ProvidersSection() {
  const client = useClient();
  const connection = useApp((state) => state.connection);
  const testKey = useApp((state) => state.testKey);
  const removeKey = useApp((state) => state.removeKey);
  const toast = useToast();
  const now = useNow(30_000);
  const [replacing, setReplacing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const openKeys = () =>
    client.app.openExternal({ url: OPENROUTER_KEYS_URL }).catch((error: unknown) => {
      toast.show(errorToast(error, fr.providers.manageKeys));
    });

  async function test() {
    setTesting(true);
    try {
      const result = await testKey();
      toast.show({ title: fr.providers.tested, description: CONNECTION_STATE_LABELS[result.state], tone: "info" });
    } catch (error) {
      toast.show(errorToast(error, fr.providers.test));
    } finally {
      setTesting(false);
    }
  }

  if (!connection || connection.state === "absent") {
    return <KeySetup />;
  }
  return (
    <>
      <dl className="nova-facts">
        <dt>{fr.providers.status}</dt>
        <dd>
          <StatusPill tone={STATE_TONES[connection.state]}>{CONNECTION_STATE_LABELS[connection.state]}</StatusPill>
        </dd>
        <dt>{fr.providers.storage}</dt>
        <dd>{connection.storage ? KEY_STORAGE_LABELS[connection.storage] : fr.app.unknown}</dd>
        <dt>{fr.providers.keyHint}</dt>
        <dd>
          <code>{connection.keyHint ? fr.providers.keyHintValue(connection.keyHint) : fr.app.unknown}</code>
        </dd>
        <dt>{fr.providers.lastChecked}</dt>
        <dd>{connection.lastCheckedAt ? formatRelative(connection.lastCheckedAt, now) : fr.providers.never}</dd>
      </dl>
      {connection.check ? <KeyCheckSummary check={connection.check} /> : null}
      {connection.lastError ? (
        <Callout tone={connection.state === "invalid" ? "danger" : "warning"} title={fr.providers.lastError}>
          <p>{describeProviderError(connection.lastError).title}</p>
        </Callout>
      ) : null}
      <div className="nova-actions">
        <Button variant="secondary" loading={testing} onClick={() => void test()}>
          {fr.providers.test}
        </Button>
        <Button variant="secondary" onClick={() => setReplacing((value) => !value)} aria-expanded={replacing}>
          {replacing ? fr.providers.cancelReplace : fr.providers.replace}
        </Button>
        <Button variant="danger" onClick={() => setConfirmRemove(true)}>
          {fr.providers.remove}
        </Button>
      </div>
      <p className="nova-note">{fr.providers.revokeNote}</p>
      <Button variant="ghost" size="sm" icon={<ExternalIcon size={14} />} onClick={() => void openKeys()}>
        {fr.providers.manageKeys}
      </Button>
      {replacing ? <KeySetup onSaved={() => setReplacing(false)} /> : null}
      {confirmRemove ? (
        <ConfirmDialog
          title={fr.providers.removeTitle}
          description={fr.providers.removeDescription}
          confirmLabel={fr.providers.remove}
          onClose={() => setConfirmRemove(false)}
          onConfirm={async () => {
            try {
              await removeKey();
              toast.show({ title: fr.providers.removed, tone: "success" });
            } catch (error) {
              toast.show(errorToast(error, fr.providers.remove));
              throw error;
            }
          }}
        />
      ) : null}
    </>
  );
}

function ModelsSection() {
  const defaultModelId = useApp((state) => state.settings?.defaultModelId ?? null);
  const models = useApp((state) => state.catalog.data?.models);
  const chooseModel = useApp((state) => state.chooseModel);
  const toast = useToast();
  const current = findModel(models, defaultModelId);
  return (
    <>
      <dl className="nova-facts">
        <dt>{fr.models.defaultModel}</dt>
        <dd>
          {defaultModelId ? (current?.name ?? defaultModelId) : fr.models.noneSelected}
          {defaultModelId && models && !current ? ` (${fr.models.notInCatalog})` : null}
        </dd>
      </dl>
      <p className="nova-note">{fr.models.defaultModelHint}</p>
      <ModelBrowser
        selectedId={defaultModelId}
        preferQuickAuthor={defaultModelId === null}
        onSelect={(model) => {
          chooseModel(model.id, "default")
            .then(() => toast.show({ title: fr.models.defaultSaved, description: model.name, tone: "success" }))
            .catch((error: unknown) => toast.show(errorToast(error, fr.settings.saveFailed)));
        }}
      />
    </>
  );
}

function PrivacySection() {
  const collection = useApp((state) => state.settings?.privacy.providerDataCollection ?? "deny");
  const save = useSaveSetting();
  return (
    <>
      <Switch
        checked={collection === "allow"}
        onCheckedChange={(checked) => save({ privacy: { providerDataCollection: checked ? "allow" : "deny" } })}
        label={fr.settings.privacySwitch}
        description={fr.settings.privacySwitchDescription}
      />
      <h3 className="nova-subheading">{fr.settings.leavesTitle}</h3>
      <ul className="nova-bullets">
        {fr.settings.leaves.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h3 className="nova-subheading">{fr.settings.staysTitle}</h3>
      <ul className="nova-bullets">
        {fr.settings.stays.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}

function AppearanceSection() {
  const theme = useApp((state) => state.settings?.theme ?? "system");
  const save = useSaveSetting();
  return (
    <SegmentedControl<ThemePreference>
      label={fr.settings.themeLabel}
      value={theme}
      onChange={(value) => save({ theme: value })}
      options={[
        { value: "system", label: fr.settings.themeSystem },
        { value: "dark", label: fr.settings.themeDark },
        { value: "light", label: fr.settings.themeLight },
      ]}
    />
  );
}

function CompanionSection() {
  const companion = useApp((state) => state.settings?.companion ?? null);
  const save = useSaveSetting();
  if (!companion) return null;
  return (
    <>
      <Switch
        checked={companion.visible}
        onCheckedChange={(visible) => save({ companion: { visible } })}
        label={fr.settings.companionVisible}
        description={fr.settings.companionVisibleDescription}
      />
      <div className="nova-setting">
        <p className="nv-field__label">{fr.settings.motionLabel}</p>
        <SegmentedControl<MotionPreference>
          label={fr.settings.motionLabel}
          value={companion.motion}
          onChange={(motion) => save({ companion: { motion } })}
          options={[
            { value: "system", label: fr.settings.motionSystem },
            { value: "reduce", label: fr.settings.motionReduce },
            { value: "full", label: fr.settings.motionFull },
          ]}
        />
        <p className="nova-note">{fr.settings.motionDescription}</p>
      </div>
    </>
  );
}

function ShortcutsSection() {
  return (
    <>
      <p className="nova-note">{fr.settings.shortcutsIntro}</p>
      <dl className="nova-shortcuts">
        {fr.settings.shortcuts.map((shortcut) => (
          <div key={shortcut.label} className="nova-shortcuts__row">
            <dt>{shortcut.label}</dt>
            <dd>
              {shortcut.keys.map((key) => (
                <Kbd key={key}>{key === "Ctrl" ? MOD_KEY : key}</Kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function DiagnosticsSection() {
  const info = useApp((state) => state.appInfo);
  const [gallery, setGallery] = useState(false);
  const d = fr.settings.diagnostics;
  if (!info) return <p className="nova-note">{d.loading}</p>;
  const vault = VAULT_LEVEL_COPY[info.vault.level];
  return (
    <>
      <dl className="nova-facts">
        <dt>{d.version}</dt>
        <dd>{info.version}</dd>
        <dt>{d.electron}</dt>
        <dd>{info.electronVersion}</dd>
        <dt>{d.platform}</dt>
        <dd>
          {info.platform} · {info.arch}
        </dd>
        <dt>{d.packaged}</dt>
        <dd>{info.isPackaged ? d.yes : d.no}</dd>
        <dt>{d.vault}</dt>
        <dd>
          <span>
            {vault.label} ({d.vaultBackend(info.vault.backend)})
          </span>
          <span className="nova-note">{vault.detail}</span>
        </dd>
        <dt>{d.dataDir}</dt>
        <dd>
          <code>{info.dataDir}</code>
        </dd>
        <dt>{d.logDir}</dt>
        <dd>
          <code>{info.logDir}</code>
        </dd>
      </dl>
      <h3 className="nova-subheading">{d.gallery}</h3>
      <Button variant="secondary" aria-expanded={gallery} onClick={() => setGallery((value) => !value)}>
        {gallery ? d.galleryHide : d.galleryShow}
      </Button>
      {gallery ? (
        <div className="nova-gallery">
          <ComponentGallery />
        </div>
      ) : null}
    </>
  );
}

const SECTION_VIEWS: Record<SettingsSection, () => JSX.Element | null> = {
  providers: ProvidersSection,
  models: ModelsSection,
  budget: BudgetSection,
  permissions: PermissionsSection,
  internet: InternetSection,
  audit: AuditSection,
  privacy: PrivacySection,
  appearance: AppearanceSection,
  companion: CompanionSection,
  shortcuts: ShortcutsSection,
  diagnostics: DiagnosticsSection,
};

export function SettingsView() {
  const section = useApp((state) => state.ui.settingsSection);
  const openSettings = useApp((state) => state.openSettings);
  const Section = SECTION_VIEWS[section];
  return (
    <div className="nova-settings">
      <h1 className="nova-settings__title">{fr.settings.title}</h1>
      <div className="nova-settings__layout">
        <nav className="nova-settings__nav" aria-label={fr.settings.sectionsLabel}>
          <ul>
            {SECTIONS.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  className="nova-settings__tab"
                  aria-current={item === section ? "page" : undefined}
                  onClick={() => openSettings(item)}
                >
                  {fr.settings.sections[item]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <section className="nova-settings__content" aria-labelledby="settings-section-title">
          <h2 id="settings-section-title" className="nova-settings__section-title">
            {fr.settings.sections[section]}
          </h2>
          {section === "providers" ? <p className="nova-note">{fr.providers.description}</p> : null}
          <Section />
        </section>
      </div>
    </div>
  );
}
