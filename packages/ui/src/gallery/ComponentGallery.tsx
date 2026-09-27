import { useState, type ReactNode } from "react";
import { ArrowUp, Copy, FolderOpen, Paperclip, Plus, Settings, Trash2 } from "lucide-react";
import { LogoMark, Lockup, Wordmark } from "../brand/Brand";
import { Badge, StatusPill } from "../components/Badge";
import { Button, IconButton } from "../components/Button";
import { Callout } from "../components/Callout";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { OrbitIndicator } from "../components/OrbitIndicator";
import { Kbd, Skeleton, VisuallyHidden } from "../components/Primitives";
import { SegmentedControl } from "../components/SegmentedControl";
import { Switch } from "../components/Switch";
import { TextArea, TextField } from "../components/TextField";
import { Toaster, useToast } from "../components/Toast";
import { Tooltip } from "../components/Tooltip";
import { contrastRatio } from "../contrast";
import { Nomi } from "../nomi/Nomi";
import { NOMI_STATES, NOMI_STATE_LABELS } from "../nomi/states";
import { palettes, type Palette, type ThemeName } from "../tokens";

const THEMES: Array<{ theme: ThemeName; title: string }> = [
  { theme: "dark", title: "Nuit minérale" },
  { theme: "light", title: "Papier minéral" },
];

const SWATCHES: Array<keyof Palette> = [
  "bg",
  "panel",
  "raised",
  "field",
  "border",
  "borderStrong",
  "text",
  "textSecondary",
  "accent",
  "accentSoft",
  "amber",
  "amberSoft",
  "danger",
  "dangerSoft",
  "info",
  "infoSoft",
];

/** Every component and every Nomi state in both themes, for design review and screenshots. */
export function ComponentGallery() {
  return (
    <div className="nv-gallery">
      {THEMES.map(({ theme, title }) => (
        <section key={theme} data-theme={theme} className="nv-gallery__theme" aria-label={title}>
          <Toaster className="nv-gallery__toaster">
            <ThemeColumn theme={theme} title={title} />
          </Toaster>
        </section>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="nv-gallery__section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ThemeColumn({ theme, title }: { theme: ThemeName; title: string }) {
  return (
    <>
      <header className="nv-gallery__theme-title">
        <Lockup height={36} />
        <h1>{title}</h1>
      </header>
      <BrandSection />
      <ColorSection theme={theme} />
      <TypeSection />
      <ActionSection />
      <FieldSection />
      <ChoiceSection />
      <StatusSection />
      <FeedbackSection />
      <NomiSection />
    </>
  );
}

function BrandSection() {
  return (
    <Section title="Marque">
      <div className="nv-gallery__row">
        <Lockup height={48} />
        <LogoMark size={48} label="NOVA" />
        <LogoMark size={32} />
        <LogoMark size={16} />
        <LogoMark size={32} tone="current" />
        <Wordmark height={20} />
      </div>
    </Section>
  );
}

function ColorSection({ theme }: { theme: ThemeName }) {
  const palette = palettes[theme];
  return (
    <Section title="Couleurs">
      <div className="nv-gallery__swatches">
        {SWATCHES.map((key) => (
          <div key={key} className="nv-gallery__swatch">
            <span className="nv-gallery__swatch-chip" style={{ background: palette[key] }} />
            <strong>{key}</strong>
            <code>
              {palette[key]} · {contrastRatio(palette[key], palette.bg).toFixed(2)}:1
            </code>
          </div>
        ))}
      </div>
    </Section>
  );
}

function TypeSection() {
  return (
    <Section title="Typographie">
      <div className="nv-gallery__type-sample">
        <p style={{ fontSize: "var(--nv-text-3xl)", fontWeight: 680, lineHeight: 1.15 }}>
          Transformer une intention en résultat
        </p>
        <p style={{ fontSize: "var(--nv-text-xl)", fontWeight: 600 }}>Un atelier calme, vivant et précis</p>
        <p>
          Manrope pour l’interface : lisible, chaleureuse, sans effet. Les accents lumineux restent rares ; le travail
          occupe l’espace.
        </p>
        <p style={{ color: "var(--nv-text-secondary)" }}>Texte secondaire pour le contexte et les métadonnées.</p>
        <p>
          <code>JetBrains Mono · const mission = await nova.plan(intention);</code>
        </p>
      </div>
    </Section>
  );
}

function ActionSection() {
  return (
    <Section title="Actions">
      <div className="nv-gallery__row">
        <Button variant="primary" icon={<ArrowUp size={16} aria-hidden />}>
          Envoyer
        </Button>
        <Button>Annuler</Button>
        <Button variant="ghost" icon={<FolderOpen size={16} aria-hidden />}>
          Ouvrir un dossier
        </Button>
        <Button variant="danger" icon={<Trash2 size={16} aria-hidden />}>
          Supprimer
        </Button>
      </div>
      <div className="nv-gallery__row">
        <Button variant="primary" size="sm">
          Continuer
        </Button>
        <Button size="sm">Secondaire</Button>
        <Button variant="ghost" size="sm">
          Discret
        </Button>
        <Button variant="danger" size="sm">
          Arrêter
        </Button>
      </div>
      <div className="nv-gallery__row">
        <Button variant="primary" loading>
          Génération en cours
        </Button>
        <Button loading size="sm">
          Enregistrement
        </Button>
        <Button variant="primary" disabled>
          Indisponible
        </Button>
        <Button disabled>Désactivé</Button>
      </div>
      <div className="nv-gallery__row">
        <Tooltip content="Nouvelle conversation">
          <IconButton aria-label="Nouvelle conversation" icon={<Plus size={18} aria-hidden />} />
        </Tooltip>
        <Tooltip content="Joindre un fichier" side="bottom">
          <IconButton aria-label="Joindre un fichier" icon={<Paperclip size={18} aria-hidden />} variant="secondary" />
        </Tooltip>
        <IconButton aria-label="Copier" icon={<Copy size={16} aria-hidden />} size="sm" />
        <IconButton aria-label="Réglages" icon={<Settings size={18} aria-hidden />} variant="primary" />
        <span>
          Palette de commandes <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
        </span>
      </div>
    </Section>
  );
}

function FieldSection() {
  const [name, setName] = useState("Mission du lundi");
  return (
    <Section title="Champs">
      <div className="nv-gallery__stack">
        <TextField
          label="Nom de la mission"
          hint="Visible uniquement sur cet appareil."
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label="Clé API"
          type="password"
          defaultValue="sk-exemple"
          error="Cette clé a été refusée par le fournisseur."
        />
        <TextField label="Recherche" hideLabel placeholder="Rechercher une conversation…" />
        <TextField label="Désactivé" disabled defaultValue="Lecture seule" />
        <TextArea label="Consigne" placeholder="Décris le résultat attendu…" rows={3} />
      </div>
    </Section>
  );
}

function ChoiceSection() {
  const [sync, setSync] = useState(true);
  const [sounds, setSounds] = useState(false);
  const [view, setView] = useState<"conversation" | "mission" | "fichiers">("conversation");
  const [density, setDensity] = useState<"compact" | "confort">("confort");
  return (
    <Section title="Choix">
      <div className="nv-gallery__stack">
        <Switch
          label="Afficher Nomi"
          description="Le compagnon reflète l’état réel des générations."
          checked={sync}
          onCheckedChange={setSync}
        />
        <Switch label="Sons discrets" checked={sounds} onCheckedChange={setSounds} />
        <Switch label="Option verrouillée" checked disabled onCheckedChange={() => undefined} />
        <div className="nv-gallery__row">
          <SegmentedControl
            label="Vue"
            value={view}
            onChange={setView}
            options={[
              { value: "conversation", label: "Conversation" },
              { value: "mission", label: "Mission" },
              { value: "fichiers", label: "Fichiers", disabled: true },
            ]}
          />
          <SegmentedControl
            label="Densité"
            size="sm"
            value={density}
            onChange={setDensity}
            options={[
              { value: "compact", label: "Compacte" },
              { value: "confort", label: "Confort" },
            ]}
          />
        </div>
      </div>
    </Section>
  );
}

function StatusSection() {
  return (
    <Section title="États">
      <div className="nv-gallery__row">
        <Badge>Brouillon</Badge>
        <Badge tone="jade">Gratuit</Badge>
        <Badge tone="amber">À valider</Badge>
        <Badge tone="danger">Refusé</Badge>
      </div>
      <div className="nv-gallery__row">
        <StatusPill>Hors ligne</StatusPill>
        <StatusPill tone="jade">Connecté</StatusPill>
        <StatusPill tone="jade" active>
          Génération en cours
        </StatusPill>
        <StatusPill tone="amber">En attente</StatusPill>
        <StatusPill tone="danger">Erreur</StatusPill>
      </div>
      <div className="nv-gallery__row">
        <OrbitIndicator size={16} />
        <OrbitIndicator size={24} label="Au repos" />
        <OrbitIndicator active size={16} />
        <OrbitIndicator active size={24} label="Génération en cours" />
      </div>
      <div className="nv-gallery__card nv-gallery__stack">
        <Skeleton width="60%" height={16} />
        <Skeleton height={12} />
        <Skeleton width="80%" height={12} />
      </div>
    </Section>
  );
}

function FeedbackSection() {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <Section title="Retours">
      <div className="nv-gallery__stack">
        <Callout title="Catalogue actualisé">
          Les prix affichés viennent du fournisseur ; inconnu reste « inconnu ».
        </Callout>
        <Callout tone="success" title="Clé enregistrée">
          Elle est chiffrée dans le coffre du système.
        </Callout>
        <Callout tone="warning" title="Coût élevé">
          Ce modèle facture davantage les longues réponses.
        </Callout>
        <Callout tone="danger" title="Connexion impossible" action={<Button size="sm">Réessayer</Button>}>
          Le fournisseur n’a pas répondu.
        </Callout>
      </div>
      <div className="nv-gallery__row">
        <Button onClick={() => setOpen(true)}>Ouvrir la boîte de dialogue</Button>
        <Button variant="ghost" onClick={() => toast.show({ title: "Conversation exportée", tone: "success" })}>
          Toast succès
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            toast.show({
              title: "Génération interrompue",
              description: "Le fournisseur a coupé la connexion.",
              tone: "danger",
            })
          }
        >
          Toast erreur
        </Button>
      </div>
      <div className="nv-gallery__card">
        <EmptyState
          headingLevel={3}
          icon={<Nomi state="idle" size={72} />}
          title="Aucune conversation"
          description="Pose une première intention : Nomi t’aide à la transformer en résultat."
          action={
            <Button variant="primary" icon={<Plus size={16} aria-hidden />}>
              Nouvelle conversation
            </Button>
          }
        />
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Renommer la conversation"
        description="Le nouveau nom apparaît dans la liste et dans l’export."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Annuler</Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Renommer
            </Button>
          </>
        }
      >
        <TextField label="Nom" defaultValue="Plan de lancement" />
      </Dialog>
    </Section>
  );
}

function NomiSection() {
  return (
    <Section title="Nomi">
      <div className="nv-gallery__nomi-grid">
        {NOMI_STATES.map((state) => (
          <figure key={state} className="nv-gallery__nomi">
            <div className="nv-gallery__nomi-sizes">
              <Nomi state={state} size={32} />
              <Nomi state={state} size={64} />
              <Nomi state={state} size={128} />
            </div>
            <figcaption>
              <strong>{state}</strong>
              <p>{NOMI_STATE_LABELS[state]}</p>
            </figcaption>
          </figure>
        ))}
      </div>
      <h3 className="nv-gallery__subtitle">
        Mouvement réduit <VisuallyHidden>(poses statiques)</VisuallyHidden>
      </h3>
      <div className="nv-gallery__row">
        {NOMI_STATES.map((state) => (
          <Nomi key={state} state={state} size={64} motion="reduced" />
        ))}
      </div>
    </Section>
  );
}
