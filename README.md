# NOVA

> Une idée. Un compagnon. Du concret.

NOVA est un atelier personnel d'IA pour discuter, comprendre, créer des applications et automatiser son travail. Il s'adresse aux personnes qui savent expliquer ce qu'elles veulent sans maîtriser le code. Desktop d'abord (Electron), Web/PWA ensuite.

**Statut : Jalon 1 en cours — non prêt pour la production.** La tranche verticale (clé, catalogue, conversation en continu, historique) fonctionne sur Linux x64 contre un faux serveur OpenRouter ; elle n'a pas encore été essayée avec une vraie clé, ni sur Windows et macOS. Ce qui fonctionne réellement, et comment cela a été vérifié, est consigné dans [`docs/STATUS.md`](docs/STATUS.md).

## Ce que vise le jalon 1

- Ajouter sa clé OpenRouter, stockée dans le coffre du système, avec le niveau de protection réel affiché.
- Choisir un modèle dans le catalogue OpenRouter en direct (aucun modèle codé en dur, valeurs absentes affichées « inconnu »).
- Discuter en continu, arrêter une réponse, obtenir des erreurs compréhensibles.
- Retrouver ses conversations après redémarrage, avec l'usage et le coût rapportés par le fournisseur.

Missions de code, extensions, voix et version Web viennent ensuite : voir [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Prérequis

- Node ≥ 24.10 et pnpm 12 (version fixée par `packageManager`, par exemple via Corepack).
- Linux : pour les E2E sans écran, `xvfb`, `dbus` et `gnome-keyring`. Sans trousseau, NOVA fonctionne avec une clé de session ou un coffre faible, explicitement signalé.
- Windows et macOS : pas de vérification locale. La CI GitHub Actions (`.github/workflows/ci.yml`) y construit l'application, lance les E2E Playwright, `vault-smoke` et un paquet non signé ; lint, vérification de types et tests unitaires ne tournent que sous Linux. Aucun run n'est encore consigné : consultez la matrice de [`docs/STATUS.md`](docs/STATUS.md) avant de considérer une plateforme comme prise en charge.
- Une clé OpenRouter standard (pas de clé de gestion) avec du crédit pour un usage réel.

## Démarrage rapide

```bash
pnpm install        # respecte le délai de 3 jours sur les nouvelles versions (ADR-009)
pnpm dev            # lance l'application en développement
```

Vérifications :

```bash
pnpm lint           # oxlint
pnpm typecheck      # TypeScript, tous les paquets
pnpm test           # Vitest, projets node et dom
pnpm check          # les trois à la suite
```

Tests de bout en bout (Playwright sur l'application construite, avec un faux serveur OpenRouter local, sans coût) :

```bash
pnpm test:e2e                     # Windows, macOS, ou Linux avec écran
xvfb-run -a pnpm test:e2e         # Linux sans écran
```

Playwright force `--password-store=basic` au lancement d'Electron : sous Linux, les E2E n'exercent que le coffre faible ou la clé de session. Le niveau du coffre du système se vérifie sur l'application réelle, hors Playwright :

```bash
# dans apps/desktop, après electron-vite build
dbus-run-session -- bash e2e/run-with-keyring.sh xvfb-run -a node e2e/vault-smoke.mjs --expect os   # trousseau privé
xvfb-run -a node e2e/vault-smoke.mjs --expect weak                                                   # sans trousseau
```

Sous Windows et macOS, la CI lance `node e2e/vault-smoke.mjs --expect os`.

Paquets :

```bash
pnpm --filter @nova/desktop package:dir   # dossier non installé, pour vérifier localement
pnpm package                              # installeurs de la plateforme courante (non signés)
```

## Clés et données

Règles de conception du jalon 1 ; leur vérification est suivie dans [`docs/STATUS.md`](docs/STATUS.md).

- La clé est collée une fois dans l'interface, puis gérée uniquement par le processus principal : jamais renvoyée à l'interface, jamais journalisée, jamais exportée. Seuls ses 4 derniers caractères sont affichés.
- Stockage : coffre du système (DPAPI, Keychain, libsecret, kwallet). Sous Linux sans trousseau, le coffre « faible » d'Electron n'est qu'une obfuscation : NOVA le dit, propose une clé de session par défaut et demande un consentement explicite.
- Les conversations restent sur la machine, en SQLite (`nova.sqlite` dans le dossier de données). Elles ne partent que vers OpenRouter, au moment de l'envoi, avec `data_collection: deny` par défaut.
- Aucune télémétrie. Une éventuelle politique opt-in reste à décider (question Q4 de [`docs/DECISIONS.md`](docs/DECISIONS.md)).

Détails : [`docs/SECURITY.md`](docs/SECURITY.md). Merci de ne pas publier de faille dans un ticket public ; le canal de signalement reste à définir.

## Documentation

| Document | Contenu |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | Promesse, personas, parcours, périmètre, non-objectifs, métriques |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Modules, processus, flux d'un message, stockage, contrat IPC, erreurs |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | Identité, microcopie, tokens, orbite, composants, états, accessibilité |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Jalons J0 à J6, dépendances, critères de sortie |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Décisions d'architecture, dépendances, questions ouvertes |
| [`docs/STATUS.md`](docs/STATUS.md) | Ce qui marche, ce qui a été testé, matrice des plateformes |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Modèle de menaces, secrets, isolation, données sortantes |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | Les 18 scénarios d'acceptation |
| [`AGENTS.md`](AGENTS.md) | Règles du dépôt pour les contributeurs humains et IA |

## Direction de marque

- **NOVA**, atelier calme et précis ; **Nomi**, son compagnon, qui reflète l'activité réelle et jamais une activité simulée. Noms provisoires tant que la vérification de marque et de domaine n'est pas faite.
- Marque : un ruban jade en forme de N dont les deux extrémités s'enroulent en orbite, avec une lune.
- Signature visuelle : l'orbite, immobile au repos, qui ne bouge que sur une activité réelle.
- Polices Manrope et JetBrains Mono, icônes Lucide, thèmes sombre et clair.
- Ton : français clair, verbes d'action, « inconnu » plutôt qu'une estimation.

## Structure

```
apps/desktop            application Electron (main, preload, renderer) et E2E
packages/shared         types du domaine, contrat IPC, masquage des secrets
packages/providers      interface ModelProvider, adaptateur OpenRouter
packages/storage        état local SQLite (node:sqlite), migrations
packages/agent-runtime  orchestration des générations
packages/ui             tokens, composants, Nomi, assets de marque
docs/                   mémoire du produit
```

## Licence

Licence : à définir par le propriétaire.
