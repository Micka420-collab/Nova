# Décisions

Registre des décisions d'architecture (ADR) de NOVA. Une décision n'est jamais effacée : si elle change, une nouvelle ADR la remplace et l'ancienne passe au statut « remplacée par ADR-xxx ».

Format : contexte → décision → alternatives considérées → conséquences. Toute nouvelle dépendance est justifiée ici (règle de `AGENTS.md`).

| ADR | Sujet | Statut | Date |
| --- | --- | --- | --- |
| [ADR-001](#adr-001--electron-plutôt-que-tauri-pour-la-v1) | Electron plutôt que Tauri pour la v1 | Acceptée | 2026-09-27 |
| [ADR-002](#adr-002--monorepo-pnpm-paquets-consommés-en-source) | Monorepo pnpm, paquets consommés en source | Acceptée | 2026-09-27 |
| [ADR-003](#adr-003--sqlite-via-nodesqlite) | SQLite via `node:sqlite` | Acceptée | 2026-09-27 |
| [ADR-004](#adr-004--secrets-via-safestorage-et-niveau-de-coffre-affiché) | Secrets via `safeStorage`, niveau de coffre affiché | Acceptée | 2026-09-27 |
| [ADR-005](#adr-005--renderer-isolé-protocole-nova-ipc-validé) | Renderer isolé, protocole `nova://`, IPC validé | Acceptée | 2026-09-27 |
| [ADR-006](#adr-006--openrouter-en-premier) | OpenRouter en premier | Acceptée | 2026-09-27 |
| [ADR-007](#adr-007--plateforme-de-référence-linux-x64) | Plateforme de référence Linux x64 | Acceptée | 2026-09-27 |
| [ADR-008](#adr-008--raisonnement-des-modèles--signalé-jamais-conservé) | Raisonnement des modèles : signalé, jamais conservé | Acceptée | 2026-09-27 |
| [ADR-009](#adr-009--chaîne-dapprovisionnement) | Chaîne d'approvisionnement | Acceptée | 2026-09-27 |
| [ADR-010](#adr-010--polices-et-icônes-embarquées) | Polices et icônes embarquées | Acceptée | 2026-09-27 |

---

## ADR-001 — Electron plutôt que Tauri pour la v1

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** NOVA doit piloter un terminal fiable (pseudo-terminal, prévu avec `node-pty` en J2), capter et jouer de l'audio (J4), lancer et superviser des processus locaux (outils, serveurs MCP locaux, aperçu web), et être testé de bout en bout sur le binaire réel. L'équipe travaille en TypeScript de bout en bout.

**Décision.** Electron 44.4.5 (Chromium 152, Node 24.21) pour la version desktop v1.

**Alternatives considérées.**

| Option | Pourquoi pas maintenant |
| --- | --- |
| Tauri 2 | WebView du système (WebKitGTK, WKWebView, WebView2) : comportements audio et API web différents selon l'OS ; cœur en Rust (deuxième pile) ; outillage E2E moins uniforme (pas de pilote WebDriver pour WKWebView sous macOS). |
| Web/PWA seule | Pas de processus locaux, pas de terminal, accès fichiers limité. Prévue plus tard (J5), avec un modèle d'exécution distinct. |

**Conséquences.**

- Même moteur de rendu sur les trois OS ; Node disponible dans le main (`node:sqlite`, processus enfants, `utilityProcess`) ; tests E2E avec Playwright `_electron`.
- Binaire et mémoire plus lourds. **À mesurer** sur la machine de référence (taille de l'installeur, RAM au repos, CPU du compagnon au repos) ; les budgets sont fixés après la première mesure et consignés dans `STATUS.md`. Si les budgets ne sont pas tenus, cette décision est réexaminée.
- Obligation de suivre les versions de sécurité d'Electron (seules les trois dernières versions majeures sont maintenues).

## ADR-002 — Monorepo pnpm, paquets consommés en source

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** Le main, le preload, le renderer et le runtime partagent un même contrat (types, schémas IPC). Une étape de compilation par paquet ralentirait tout et multiplierait les sources de décalage.

**Décision.**

- Espace de travail pnpm : `apps/desktop`, `packages/shared`, `packages/providers`, `packages/storage`, `packages/agent-runtime`, `packages/ui`.
- Chaque paquet exporte directement son source TypeScript (`"exports": { ".": "./src/index.ts" }`). electron-vite 5 (Vite 7) regroupe tout dans `out/main`, `out/preload`, `out/renderer`.
- Aucun module natif. L'application empaquetée ne contient pas de `node_modules`.
- Les paquets prévus (`tools`, `mcp`, `skills`, `voice`, `pets`, `apps/web`, `apps/server`) ne sont créés qu'au démarrage de leur jalon. Pas de dossier vide « pour plus tard ».

**Alternatives considérées.** Dépôts séparés (contrat dupliqué) ; compilation `tsc` de chaque paquet vers `dist/` (étape de plus, cartes de source) ; Nx ou Turborepo (inutile à cette taille).

**Conséquences.**

- Une seule vérification de types à la racine (`tsconfig.json`) et une seule configuration Vitest avec deux projets (`node`, `dom`).
- Le code des paquets doit rester compatible avec le bundler (imports sans extension, `moduleResolution: bundler`).
- Le preload sandboxé n'importe que `@nova/shared/channels` (noms de canaux, sans dépendance) pour rester minimal.

## ADR-003 — SQLite via `node:sqlite`

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** L'état produit local (réglages, connexions, conversations, usage) exige transactions, requêtes et migrations. `better-sqlite3` est un module natif à recompiler pour chaque ABI d'Electron et chaque OS.

**Décision.** Module intégré `node:sqlite`, vérifié fonctionnel dans le main d'Electron 44 (SQLite 3.53.4). API synchrone acceptée pour de petites requêtes locales. Migrations versionnées via `PRAGMA user_version`. Accès uniquement à travers l'interface `NovaStore` (`packages/storage/src/types.ts`).

**Alternatives considérées.**

| Option | Raison du rejet |
| --- | --- |
| `better-sqlite3` | Module natif : recompilation par version d'Electron et par OS. |
| sql.js (WASM) | Base en mémoire, persistance par export complet du fichier. |
| Fichiers JSON | Ni transactions ni requêtes ; corruption en cas de coupure. |
| IndexedDB dans le renderer | Données dans le processus non fiable ; contraire à l'isolation du renderer. |

**Conséquences.**

- Les appels bloquent le thread du main : requêtes courtes et indexées uniquement. Les traitements lourds iront dans un `utilityProcess` (J2+).
- Risque : `node:sqlite` est au niveau de stabilité « release candidate » dans Node 24. Atténuation : interface `NovaStore` mince et testée, remplaçable sans toucher au reste.
- Chaque mise à jour d'Electron revérifie `node:sqlite` et consigne la version de SQLite dans `STATUS.md`.

## ADR-004 — Secrets via `safeStorage` et niveau de coffre affiché

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** La clé OpenRouter de l'utilisateur donne accès à son crédit. Elle ne doit apparaître en clair ni sur disque, ni dans les journaux, ni dans le renderer, ni dans un export.

**Décision.**

- Chiffrement par l'API asynchrone de `safeStorage` d'Electron (DPAPI sous Windows, Keychain sous macOS, libsecret ou kwallet sous Linux).
- Le texte chiffré est stocké dans SQLite (table des secrets) et référencé par identifiant ; la connexion fournisseur ne contient que cette référence et les 4 derniers caractères.
- Trois niveaux affichés à l'utilisateur (`VaultLevel`) : `os`, `weak`, `unavailable`.
- Linux sans trousseau : Electron utilise le backend `basic_text`, dont la clé est codée en dur — c'est de l'**obfuscation**, pas du chiffrement. NOVA affiche ce niveau réel, propose par défaut une clé **de session** (en mémoire du main, perdue à la fermeture) et n'enregistre en coffre faible qu'après consentement explicite (`storage: "weak-vault"`).
- Coffre indisponible : clé de session uniquement.
- La clé n'est jamais renvoyée au renderer ; les clés ne font jamais partie d'un export.

**Alternatives considérées.** `keytar` (module natif, dépôt archivé) ; chiffrement maison avec mot de passe maître (friction à chaque lancement, option possible plus tard) ; fichier de configuration en clair (refusé) ; variable d'environnement seule (hors de portée du public visé).

**Conséquences.**

- Sous Linux sans trousseau, l'utilisateur ressaisit sa clé à chaque session, sauf consentement au coffre faible.
- Le texte chiffré dépend du compte et de la machine : il n'est pas transférable.
- La CI Linux exécute les E2E avec un trousseau gnome-keyring privé et déverrouillé (`apps/desktop/e2e/run-with-keyring.sh`) pour couvrir le niveau `os`.

## ADR-005 — Renderer isolé, protocole `nova://`, IPC validé

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** Le renderer affiche du contenu non fiable (réponses des modèles en Markdown, plus tard contenu de fichiers et d'outils). Une injection dans l'interface ne doit donner accès ni au système, ni au réseau, ni aux secrets.

**Décision.**

- `contextIsolation`, `sandbox`, pas de `nodeIntegration`. Le preload expose une API fixe (`window.novaBridge`, type `NovaBridge`) et rien d'autre.
- Protocole privilégié `nova://` qui sert uniquement les fichiers construits du renderer, avec une CSP stricte. Pas de `file://`.
- IPC typé : chaque requête est validée par un schéma zod dans le main (`packages/shared/src/ipc.ts`) et l'origine de l'émetteur est vérifiée. Le main renvoie toujours une enveloppe `IpcResult` (jamais d'exception brute).
- Demandes de permission du navigateur (micro, caméra, notifications…) refusées par défaut.
- Navigation verrouillée, ouverture de fenêtres refusée. Liens externes : `https` uniquement, domaines en liste d'autorisation, ouverts dans le navigateur du système.
- Fuses Electron configurés à la mise en paquet (désactivation de `RunAsNode` et des options d'inspection Node, intégrité de l'archive).

**Alternatives considérées.** `file://` (origine large partagée par tous les fichiers locaux) ; serveur HTTP local (port accessible aux autres processus de la machine) ; interface chargée depuis un site distant (dépendance réseau, surface d'attaque).

**Conséquences.**

- Toute fonction passe par l'IPC : chaque nouveau canal exige un schéma, une vérification d'origine et un test.
- En mode `pnpm dev`, le renderer est servi par le serveur de développement de Vite ; la référence de sécurité est le build (`pnpm build`), celui qu'utilisent les E2E.

## ADR-006 — OpenRouter en premier

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** Le public visé doit obtenir un premier résultat avec une seule clé, et choisir parmi de nombreux modèles (dont les modèles DeepSeek disponibles au moment de la construction) sans compte par fournisseur.

**Décision.**

- Clé standard fournie par l'utilisateur (BYOK). Aucune clé de gestion demandée.
- Catalogue en direct (`GET /api/v1/models`), mis en cache localement. Aucun identifiant de modèle codé en dur ; toute donnée absente est affichée « inconnu ».
- Vérification de clé par `GET /api/v1/key` (libellé, limite, reste, usage).
- Streaming SSE (`POST /api/v1/chat/completions`) ; l'usage (jetons, coût) est lu dans le dernier fragment, où OpenRouter l'inclut toujours.
- Annulation par abandon du flux HTTP.
- En-têtes d'attribution `HTTP-Referer` et `X-OpenRouter-Title`.
- `provider.data_collection = "deny"` par défaut : seuls les fournisseurs qui ne conservent pas et n'entraînent pas sur les requêtes sont utilisés. Si cela ne laisse aucun fournisseur pour le modèle choisi, NOVA affiche une erreur claire et le réglage correspondant.
- Aucune relance automatique d'une requête payante : la relance est une action de l'utilisateur.
- Délais : 30 s pour recevoir les en-têtes, 120 s de silence maximal entre deux fragments (`DEFAULT_TIMEOUTS`).

**Alternatives considérées.** Fournisseurs directs d'abord (plusieurs clés et API, prévus ensuite) ; modèles locaux Ollama d'abord (qualité dépendante du matériel, prévus ensuite) ; clé de gestion (droits excessifs : elle crée et supprime des clés) ; liste de modèles figée (périmée en quelques semaines).

**Conséquences.**

- Dépendance à la disponibilité et aux règles d'OpenRouter.
- `deny` peut réduire le choix de fournisseurs, voire de modèles ; c'est assumé et visible (question ouverte Q5).
- Le coût affiché est celui rapporté par OpenRouter (crédits en USD). Quand il manque, il reste inconnu et les totaux sont présentés comme une borne basse.
- L'arrêt coupe la facturation seulement lorsque le fournisseur amont gère l'annulation ; sinon la génération peut être facturée en entier.

## ADR-007 — Plateforme de référence Linux x64

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** Le parcours complet doit être exécuté réellement, pas supposé. L'environnement de développement disponible est Linux.

**Décision.**

- Plateforme de référence : Linux x64 (Ubuntu 26.04), parcours exécuté sans écran via Xvfb.
- Windows et macOS : construits et testés en E2E dans GitHub Actions (`.github/workflows/ci.yml`, matrice `ubuntu-latest`, `windows-latest`, `macos-latest`).
- La matrice de support est publiée dans `STATUS.md`. Pas encore de signature de code : les paquets de CI sont non signés.

**Alternatives considérées.** macOS comme référence (non disponible ici) ; déclarer les trois OS pris en charge d'emblée (affirmation non vérifiée).

**Conséquences.**

- Une plateforme n'est déclarée prise en charge que si `STATUS.md` indique : construite, testée en E2E, installable.
- Sans signature, Windows SmartScreen et macOS Gatekeeper avertissent ou bloquent : pas de distribution au public avant la décision Q3.

## ADR-008 — Raisonnement des modèles : signalé, jamais conservé

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** Certains modèles émettent des jetons de raisonnement, parfois avec leur contenu. Les afficher ou les stocker pose des problèmes de confidentialité, de volume et de lisibilité, et leur format varie selon les fournisseurs.

**Décision.** Le fournisseur signale seulement que le modèle raisonne (`{ type: "reasoning" }`). Le runtime publie la phase `reasoning` ; Nomi passe à l'état « réfléchit ». Le contenu du raisonnement n'est ni stocké ni affiché. Le nombre de jetons de raisonnement est conservé dans l'usage (`reasoningTokens`), car il est facturé.

**Alternatives considérées.** Affichage replié du raisonnement ; stockage pour diagnostic.

**Conséquences.** Pas de diagnostic à partir du raisonnement. Une longue phase de réflexion reste visible comme telle, sans contenu.

## ADR-009 — Chaîne d'approvisionnement

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** Une dépendance compromise s'exécuterait avec les droits de l'utilisateur et pourrait lire ses clés.

**Décision** (`pnpm-workspace.yaml`).

- `minimumReleaseAge: 4320` : une version publiée depuis moins de 3 jours est ignorée.
- Exceptions explicites, relues le 2026-09-27 : `vitest@5.0.2`, `@vitest/mocker@5.0.2`, `@vitest/spy@5.0.2`, `react-resizable-panels@4.14.0`.
- Scripts d'installation autorisés uniquement pour `electron` (téléchargement du binaire) et `esbuild`. `electron-winstaller` est explicitement refusé (cible NSIS, Squirrel inutilisé).
- Fichier de verrouillage versionné ; la CI installe avec `--frozen-lockfile`.

**Alternatives considérées.** Pas de délai (exposition maximale aux publications malveillantes) ; copie locale des dépendances (maintenance lourde) ; audit seul (détection après coup).

**Conséquences.** Une nouvelle version n'est adoptée qu'après 3 jours, sauf exception relue et consignée ici avec sa raison (correctif de sécurité urgent, par exemple).

## ADR-010 — Polices et icônes embarquées

- **Date** : 2026-09-27 · **Statut** : acceptée

**Décision.** Manrope (interface) et JetBrains Mono (code, identifiants, valeurs), toutes deux sous licence SIL OFL 1.1, embarquées localement via `@fontsource-variable/manrope` et `@fontsource-variable/jetbrains-mono`. Icônes `lucide-react` (licence ISC).

**Alternatives considérées.** Polices servies par un CDN (le renderer n'a pas de réseau, et ce serait une fuite d'usage) ; polices système (rendu inégal selon l'OS).

**Conséquences.** Les avis de licence (OFL, ISC) doivent accompagner l'application distribuée — à vérifier dans le paquet avant toute distribution.

---

## Dépendances et justification

Dépendances déclarées au 2026-09-27 (voir les `package.json`).

| Dépendance | Où | Pourquoi |
| --- | --- | --- |
| `zod` | shared, desktop | Validation des requêtes IPC dans le main. |
| `eventsource-parser` | providers | Analyse du flux SSE d'OpenRouter (commentaires de maintien inclus). |
| `electron`, `electron-vite`, `vite`, `@vitejs/plugin-react` | desktop | Application, regroupement du main, du preload et du renderer. |
| `electron-builder` | desktop | Paquets par OS (Linux, NSIS sous Windows, macOS). |
| `react`, `react-dom` | desktop, ui | Interface. |
| `zustand` | desktop | État du renderer. |
| `react-resizable-panels` | desktop | Les trois zones redimensionnables. |
| `cmdk` | desktop | Barre de commande universelle. |
| `react-markdown`, `remark-gfm` | desktop | Rendu des réponses en Markdown (sans HTML brut). |
| `lucide-react` | ui | Icônes (ISC). |
| `@fontsource-variable/manrope`, `@fontsource-variable/jetbrains-mono` | ui | Polices embarquées (OFL 1.1). |
| `vitest`, `jsdom`, `@testing-library/react` | racine, desktop, ui | Tests unitaires et de composants. |
| `@playwright/test` | desktop | E2E de l'application Electron construite. |
| `oxlint`, `typescript`, `@types/node`, `@types/react`, `@types/react-dom` | racine, desktop, ui | Lint et vérification de types. |
| `@resvg/resvg-js` | racine | Rendu des icônes SVG en PNG (`pnpm icons`). |

Toute nouvelle dépendance ajoute une ligne à ce tableau, dans le même changement.

---

## Questions ouvertes pour le propriétaire

| # | Question | Pourquoi elle compte | Options | À trancher avant |
| --- | --- | --- | --- | --- |
| Q1 | Nom définitif du produit (NOVA) et du compagnon (Nomi) : marques, domaine, noms de paquets | Aucune vérification de disponibilité n'a été faite (registres de marques des marchés visés, domaine, identifiants d'applications). | Garder après vérification ; renommer. | Toute distribution publique |
| Q2 | Licence de ce dépôt public | Sans licence, le code est visible mais pas réutilisable, et le statut des contributions externes est flou. | Permissive (MIT, Apache-2.0) ; MPL-2.0 ; AGPL-3.0 (pertinente si un serveur hébergé arrive) ; code source consultable sans licence libre. | Première contribution externe |
| Q3 | Certificats de signature de code | Sans signature, installation bloquée ou dissuasive ; pas de mises à jour signées possibles. | Apple Developer ID + notarisation ; certificat Windows (OV/EV ou service de signature en ligne) ; signature des paquets Linux. | Toute distribution publique |
| Q4 | Politique de télémétrie | Les métriques de succès (`PRODUCT.md`) ne sont mesurables hors de la machine de développement qu'avec une télémétrie. | Aucune ; opt-in explicite avec liste publique des champs et durée de conservation ; rapports de plantage opt-in séparés. | Premiers utilisateurs externes |
| Q5 | Confirmer `data_collection = deny` par défaut | Plus de confidentialité, mais moins de fournisseurs et parfois des prix plus élevés ou des modèles indisponibles. | `deny` par défaut (actuel) ; `allow` avec avertissement clair. | Fin de J1 |
| Q6 | Placement des fonctions non datées par le brief | Mémoire, profils de modèles, fournisseurs directs et Ollama n'ont pas de jalon attribué. | Proposition dans `ROADMAP.md`, à valider. | Début de J2 |
| Q7 | Forme d'adresse de l'interface (tu ou vous) | Une seule forme dans tout le produit ; elle fixe le ton de Nomi. | Vouvoiement ; tutoiement. | Fin de J1 |
| Q8 | Contact pour signaler une vulnérabilité | `SECURITY.md` ne peut pas encore indiquer de canal. | Adresse dédiée ; signalement privé GitHub. | Dépôt public annoncé |
