# Décisions

Registre des décisions d'architecture (ADR) de NOVA. Une décision n'est jamais effacée : si elle change, une nouvelle ADR la remplace et l'ancienne passe au statut « remplacée par ADR-xxx ».

Format : contexte → décision → alternatives considérées → conséquences. Toute nouvelle dépendance est justifiée ici (règle de `AGENTS.md`).

| ADR | Sujet | Statut | Date |
| --- | --- | --- | --- |
| [ADR-001](#adr-001--electron-plutôt-que-tauri-pour-la-v1) | Electron plutôt que Tauri pour la v1 | Acceptée | 2026-09-27 |
| [ADR-002](#adr-002--monorepo-pnpm-paquets-consommés-en-source) | Monorepo pnpm, paquets consommés en source | Acceptée ; « aucun module natif » révisé par ADR-012 | 2026-09-27 |
| [ADR-003](#adr-003--sqlite-via-nodesqlite) | SQLite via `node:sqlite` | Acceptée | 2026-09-27 |
| [ADR-004](#adr-004--secrets-via-safestorage-et-niveau-de-coffre-affiché) | Secrets via `safeStorage`, niveau de coffre affiché | Acceptée | 2026-09-27 |
| [ADR-005](#adr-005--renderer-isolé-protocole-nova-ipc-validé) | Renderer isolé, protocole `nova://`, IPC validé | Acceptée | 2026-09-27 |
| [ADR-006](#adr-006--openrouter-en-premier) | OpenRouter en premier | Acceptée | 2026-09-27 |
| [ADR-007](#adr-007--plateforme-de-référence-linux-x64) | Plateforme de référence Linux x64 | Acceptée | 2026-09-27 |
| [ADR-008](#adr-008--raisonnement-des-modèles--signalé-jamais-conservé) | Raisonnement des modèles : signalé, jamais conservé | Acceptée | 2026-09-27 |
| [ADR-009](#adr-009--chaîne-dapprovisionnement) | Chaîne d'approvisionnement | Acceptée ; scripts d'installation étendus à `node-pty` par ADR-012 | 2026-09-27 |
| [ADR-010](#adr-010--polices-et-icônes-embarquées) | Polices et icônes embarquées | Acceptée | 2026-09-27 |
| [ADR-011](#adr-011--fins-de-génération-sans-succès-coût-inconnu-relance) | Fins de génération sans succès, coût inconnu, relance | Acceptée, implémentée | 2026-09-27 |
| [ADR-012](#adr-012--modules-natifs-et-binaires--node-pty-et-ripgrep-d1) | Modules natifs et binaires : `node-pty` et ripgrep (D1) ; révise ADR-002 et ADR-009 | Acceptée, implémentée (socle) | 2026-09-27 |
| [ADR-013](#adr-013--codemirror-6-et-nonce-de-style-dans-la-csp-d13) | CodeMirror 6 et nonce de style dans la CSP (D13) | Acceptée, implémentée (socle) | 2026-09-27 |
| [ADR-014](#adr-014--processus-utilitaires-sans-secrets-et-relais-de-messageport) | Processus utilitaires sans secrets et relais de `MessagePort` | Acceptée, implémentée (socle) | 2026-09-27 |
| [ADR-015](#adr-015--profil-autonome-permis-au-niveau-disolation-l0-avec-bandeau-d2) | Profil Autonome permis au niveau d'isolation L0, avec bandeau (D2) | Acceptée | 2026-09-27 |
| [ADR-016](#adr-016--recherche-web-par-le-plugin-openrouter-sous-contrat-d3) | Recherche web par le plugin OpenRouter, sous contrat (D3) | Acceptée | 2026-09-27 |
| [ADR-017](#adr-017--fichiers-dinstructions-dun-projet-lus-après-accord-d10) | Fichiers d'instructions d'un projet lus après accord (D10) | Acceptée | 2026-09-27 |
| [ADR-018](#adr-018--budgets-par-défaut-050--par-mission-5--par-jour-d11) | Budgets par défaut : 0,50 $ par mission, 5 $ par jour (D11) | Acceptée | 2026-09-27 |

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

- **Date** : 2026-09-27 · **Statut** : acceptée ; le point « aucun module natif, pas de `node_modules` dans l'application empaquetée » est **révisé par [ADR-012](#adr-012--modules-natifs-et-binaires--node-pty-et-ripgrep-d1)** ; les paquets de J2-A sont créés au démarrage de J2-A (socle, phase 0)

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
- Tests du niveau `os` sous Linux : le chargeur Electron de Playwright force `--password-store=basic`, donc les E2E Playwright n'exercent sous Linux que le coffre faible ou la clé de session. Le niveau `os` est vérifié par `apps/desktop/e2e/vault-smoke.mjs`, qui lance l'application réelle hors Playwright : avec le trousseau gnome-keyring privé et déverrouillé (`dbus-run-session -- bash e2e/run-with-keyring.sh …`), il constate le niveau `os` (backend `gnome_libsecret`) ; sans trousseau, le niveau `weak` (`basic_text`). La CI lance les deux cas sous Linux et `--expect os` sous Windows et macOS.
- Non couvert à ce jour : chiffrement au coffre `os`, redémarrage et relecture de la clé sous Linux, de bout en bout (aucun test versionné).

## ADR-005 — Renderer isolé, protocole `nova://`, IPC validé

- **Date** : 2026-09-27 · **Statut** : acceptée

**Contexte.** Le renderer affiche du contenu non fiable (réponses des modèles en Markdown, plus tard contenu de fichiers et d'outils). Une injection dans l'interface ne doit donner accès ni au système, ni au réseau, ni aux secrets.

**Décision.**

- `contextIsolation`, `sandbox`, pas de `nodeIntegration`. Le preload expose une API fixe (`window.novaBridge`, type `NovaBridge`) et rien d'autre.
- Protocole privilégié `nova://` qui sert uniquement les fichiers construits du renderer, avec une CSP stricte. Pas de `file://`.
- IPC typé : chaque requête est validée par un schéma zod dans le main (`packages/shared/src/ipc.ts`) et l'origine de l'émetteur est vérifiée. Le main renvoie toujours une enveloppe `IpcResult` (jamais d'exception brute).
- Demandes de permission du navigateur (micro, caméra, notifications, lecture du presse-papiers…) refusées. Seule exception : `clipboard-sanitized-write` (écriture de texte dans le presse-papiers), accordée uniquement à l'origine de l'application (`nova://app`, ou le serveur de développement en `pnpm dev`), pour les boutons « Copier » ; sans elle, `navigator.clipboard.writeText` échoue sous Electron 44 (`apps/desktop/src/main/security.ts`).
- Navigation verrouillée, ouverture de fenêtres refusée. Liens externes : `https` uniquement, domaines en liste d'autorisation, ouverts dans le navigateur du système.
- Fuses Electron configurés à la mise en paquet (désactivation de `RunAsNode` et des options d'inspection Node, chargement depuis l'archive uniquement, intégrité de l'archive). L'intégrité de l'archive n'est appliquée par Electron que sous macOS et Windows : sous Linux, une archive `app.asar` modifiée n'est pas détectée (limite connue, suivie dans `STATUS.md`).

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

- **Date** : 2026-09-27 · **Statut** : acceptée ; la liste des scripts d'installation autorisés est **étendue à `node-pty` par [ADR-012](#adr-012--modules-natifs-et-binaires--node-pty-et-ripgrep-d1)**

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

## ADR-011 — Fins de génération sans succès, coût inconnu, relance

- **Date** : 2026-09-27 · **Statut** : acceptée ; implémentée et testée (correctifs de revue)

**Contexte.** Un flux OpenRouter peut se terminer « normalement » sans donner une réponse complète : limite de jetons de sortie atteinte, filtre de contenu du fournisseur, ou aucun texte. Le coût d'une génération peut aussi manquer. Enfin, une relance qui efface la réponse précédente avant d'obtenir la nouvelle laisse l'utilisateur sans rien si elle échoue.

**Décision.**

- Trois codes d'erreur fournisseur s'ajoutent (`ProviderErrorCode`) : `truncated` (fin sur `finish_reason: "length"`, texte partiel conservé), `filtered` (fin sur `finish_reason: "content_filter"`), `empty_response` (flux terminé sans texte de réponse). Ces fins ne sont jamais présentées comme une réponse complète.
- Coût inconnu : l'usage est quand même enregistré dans `usage_records`, avec `cost` à `NULL`. Les jetons restent comptés ; le total de coût est présenté comme une borne basse (« au moins »).
- Relance : la réponse précédente reste affichée et stockée jusqu'à ce que la nouvelle commence ; un échec avant ce point ne fait rien perdre.

**Alternatives considérées.** Traiter ces fins comme un succès (fausse réussite affichée) ; ignorer les générations sans coût (jetons facturés invisibles) ; supprimer la réponse dès la relance (perte en cas d'échec).

**Conséquences.** Chaque nouveau code a son message dans la microcopie du renderer ; les totaux d'usage comptent à part les générations au coût inconnu (`messagesWithUnknownCost`).

## ADR-012 — Modules natifs et binaires : `node-pty` et ripgrep (D1)

- **Date** : 2026-09-27 · **Statut** : acceptée (décision D1 du propriétaire) ; socle implémenté et vérifié (phase 0 de J2-A). Révise ADR-002 et ADR-009.

**Contexte.** Un vrai terminal interactif (E13 : programmes plein écran, couleurs, saisie, Ctrl+C) exige un pseudo-terminal ; la recherche projet (E4) exige ripgrep. ADR-002 interdisait tout module natif et tout `node_modules` dans l'application empaquetée ; ADR-009 limitait les scripts d'installation à `electron` et `esbuild`.

**Décision.**

- `node-pty` 1.1.0 (MIT) et `@vscode/ripgrep` 1.18.0 (MIT ; binaire ripgrep sous licence MIT/Unlicense) sont des **`dependencies`** réelles de `apps/desktop`. Ils restent **externes** aux bundles (`electron.vite.config.ts`, `NATIVE_EXTERNALS`), electron-builder les copie dans `node_modules` et les **désarchive** de l'asar (`asarUnpack` dans `electron-builder.yml`).
- `node-pty` est un module **N-API** : le binaire construit à l'installation (Linux : `node-gyp` depuis les sources ; macOS et Windows : prébuilds inclus dans l'archive npm) est valable pour l'ABI d'Electron. **Aucune reconstruction** (`@electron/rebuild`) n'est nécessaire ; `npmRebuild: false` est conservé. Prouvé : `node-pty` chargé par Electron 44.4.5 (Node 24.21, ABI 149, N-API 10) lance `echo nova-pty-ok` et relit la sortie, dans le processus main, dans le `utilityProcess` « pty-host » du build `out/`, et dans le build empaqueté (fuses actifs, `app.asar.unpacked`).
- ripgrep : le chemin donné par `@vscode/ripgrep` est converti vers `app.asar.unpacked` (`native-deps.ts`, `unpackedPath`) et transmis au fs-worker (`NOVA_RG_PATH`).
- `pnpm-workspace.yaml` : `allowBuilds.node-pty: true` (script `install` : `node scripts/prebuild.js || node-gyp rebuild` ; `postinstall` : nettoyage). Les paquets de plateforme de ripgrep n'ont aucun script.
- Vérification permanente : `nova --nova-selftest=workers` (démarre chaque worker, ping, pty, ripgrep ; JSON sur la sortie standard ; code 0 si tout passe) — utilisé par l'E2E `atelier-foundations.spec.ts` et à rejouer sur chaque build empaqueté (trois OS en CI).

**Alternatives considérées.** Terminal sans TTY (`child_process.spawn`) : insuffisant pour un terminal utilisateur ; recherche en JavaScript pur : trop lente pour 100 000 fichiers ; `@electron/rebuild` systématique : inutile pour un module N-API.

**Conséquences.**

- L'installation sous Linux demande une chaîne de compilation (`python3`, `make`, `g++`) — présente en CI et sur la machine de référence.
- L'application empaquetée contient ~8 Mo dans `app.asar.unpacked` (dont les prébuilds des autres plateformes de `node-pty`) ; élagage par plateforme : suivi.
- Les workers lancent le binaire d'Electron lui-même : leur environnement épuré garde `LD_LIBRARY_PATH` (sinon code 127 quand les bibliothèques ne sont pas dans les chemins standards, cas d'AppImage).

## ADR-013 — CodeMirror 6 et nonce de style dans la CSP (D13)

- **Date** : 2026-09-27 · **Statut** : acceptée (décision D13 et choix de CodeMirror 6) ; socle implémenté et vérifié.

**Contexte.** L'éditeur (E2) injecte ses styles par `<style>` ; la CSP servie par `nova://` n'autorise que `style-src 'self'`. Monaco exigerait `style-src 'unsafe-inline'` et un chargeur de workers ; CodeMirror 6 accepte un nonce (`EditorView.cspNonce`).

**Décision.**

- Éditeur : **CodeMirror 6** (`@codemirror/*`, `@lezer/highlight`), pas Monaco (raisons dans `FEATURES.md` §2.a et `POWER_UX.md` §3).
- CSP de chaque chargement de `index.html` : `style-src 'self' 'nonce-<nonce>'`, nonce de 128 bits tiré à **chaque chargement** par le gestionnaire `nova://` (`renderer-assets.ts` : `createStyleNonce`, `rendererCspWithNonce`) et injecté dans la page par `<meta name="nova-style-nonce">` (`injectStyleNonce`). Le renderer le lit une fois (`renderer/lib/csp-nonce.ts`, `styleNonce()`) et le passe à `EditorView.cspNonce.of(nonce)` ; un `<style>` créé par NOVA porte `style.nonce = nonce`.
- `script-src 'self'` **inchangé** ; les autres ressources gardent la CSP sans nonce ; le serveur de développement Vite garde sa CSP propre (styles en ligne permis, aucun nonce).
- **Repli documenté**, à n'activer que si une bibliothèque (par exemple xterm.js) injecte des `<style>` sans nonce et qu'aucun contournement propre n'existe : `'unsafe-inline'` pour les styles seulement, par une nouvelle ADR qui cite la mesure.

**Vérification.** E2E : un `<style>` avec le nonce s'applique, le même sans nonce est bloqué ; un rechargement change le nonce. Tests unitaires du gestionnaire (nonce différent par chargement, `script-src` strict, aucune occurrence de `unsafe`).

**Conséquences.** Le nonce n'est pas un secret vis-à-vis de la page (il est son propre jeton de politique) ; il empêche seulement un contenu injecté de créer des styles, et aucun script injecté ne peut s'exécuter. xterm.js doit être vérifié contre cette CSP lors de son intégration (styles posés par CSSOM : autorisés).

## ADR-014 — Processus utilitaires sans secrets et relais de `MessagePort`

- **Date** : 2026-09-27 · **Statut** : acceptée ; socle implémenté et vérifié.

**Décision.**

- Quatre `utilityProcess` (`pty-host`, `fs-worker`, `agent-runtime`, `mcp-host`), construits par electron-vite à côté du main (`out/main/workers/<nom>.js`), lancés **à la première utilisation** par `WorkerPool` (`apps/desktop/src/main/workers.ts`) : requête/réponse typée (`apps/desktop/src/workers/protocol.ts`), file d'attente jusqu'à `ready`, délais, **redémarrage** après plantage avec backoff (3 fois par minute, puis état `failed` jusqu'à un nouveau `start`), requêtes en cours rejetées en `unavailable`.
- **Environnement épuré** (`scrubEnv`) : liste blanche de noms (PATH, HOME, locale, TMP, affichage, variables système Windows, `LD_LIBRARY_PATH`), refus de tout nom évoquant un secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`…) et de `NOVA_*`, `ELECTRON_*`, `NODE_OPTIONS` ; aucune clé n'atteint un worker (la génération passera par un proxy fournisseur dans le main).
- Données à haut débit (terminal, puis LSP) : `MessageChannelMain` ; un port au worker, l'autre à la fenêtre par `webContents.postMessage("nova:port:transfer", { kind, id }, [port])` ; le preload le relaie par `window.postMessage({ type: "nova:port", kind, id }, "*", [port])` (motif documenté d'Electron : `contextBridge` ne transporte pas de ports) ; la page le récupère par `createNovaPortRegistry` (`packages/shared/src/ports.ts`), qui met en attente les ports arrivés avant la réponse IPC qui annonce leur identifiant.
- Tous les groupes IPC de J2-A sont servis par leur service réel (câblage dans `apps/desktop/src/main/index.ts`, intégration J2-A) ; le module de réponses `unavailable` de la phase 0 a été supprimé. `WorkerPool.instance(nom)` permet de s'abonner aux événements d'un worker sans le démarrer.

**Vérification.** Tests unitaires (`workers.test.ts` : file d'attente, plantage, abandon, arrêt, environnement) ; E2E (`atelier-foundations.spec.ts` : quatre workers répondent, pty et ripgrep dans les workers, port relayé main → preload → page avec aller-retour).

## ADR-015 — Profil Autonome permis au niveau d'isolation L0, avec bandeau (D2)

- **Date** : 2026-09-27 · **Statut** : acceptée (décision D2 du propriétaire).

**Décision.** Le profil `autonomous` est permis même quand seul le niveau d'isolation **L0** est disponible (processus séparé, environnement épuré, `cwd` confiné, délais et plafonds ; toujours le cas sous Windows en v2). L'interface affiche alors un **bandeau explicite** (`PermissionProfileState.showIsolationBanner`) ; les catégories « dangereuse » et le réseau hors contrat restent en `ask`, les effets irréversibles ne sont jamais mémorisables. Réévaluation après mesure des incidents.

**Alternatives considérées.** Autonome exigeant L1 (Linux/macOS seulement) ; conteneur obligatoire.

## ADR-016 — Recherche web par le plugin OpenRouter, sous contrat (D3)

- **Date** : 2026-09-27 · **Statut** : acceptée (décision D3 du propriétaire).

**Décision.** Recherche web par le **plugin `web` d'OpenRouter** (citations uniquement issues des annotations `url_citation`, coût enregistré avec `usage_records.kind = 'web_search'`). Dans une **mission d'agent**, permise quand le contrat l'indique (`MissionContract.webSearch`). En mode **Discuter**, jamais automatique : seulement via le bouton « Web » de la zone de saisie. La requête part chez OpenRouter puis chez le moteur ; l'inspecteur de contexte l'indique.

## ADR-017 — Fichiers d'instructions d'un projet lus après accord (D10)

- **Date** : 2026-09-27 · **Statut** : acceptée (décision D10 du propriétaire).

**Décision.** `AGENTS.md`, `CLAUDE.md` et `.cursorrules` d'un projet sont des instructions **non fiables** d'un dépôt tiers : NOVA ne les lit qu'après avoir **demandé la première fois par projet** ; la réponse est mémorisée (`workspaces.instruction_files_consent` : `NULL` = pas encore demandé, `allowed`, `denied` ; IPC `workspace.setInstructionConsent`). Leur présence seule est détectée sans lecture (`WorkspaceFacts.instructionFiles`). Leur contenu, une fois accepté, reste de la donnée : il n'accorde aucune permission.

## ADR-018 — Budgets par défaut : 0,50 $ par mission, 5 $ par jour (D11)

- **Date** : 2026-09-27 · **Statut** : acceptée (décision D11 du propriétaire).

**Décision.** Budget par défaut d'une mission : **0,50 $** ; plafond quotidien : **5 $** (`DEFAULT_MISSION_BUDGET_USD`, `DEFAULT_DAILY_BUDGET_USD` dans `packages/shared/src/missions.ts`), affichés dès le premier contrat et modifiables. Réservation avant chaque appel payant (`cost_reservations`) ; au plafond, la mission passe en `suspended` (raison `budget` ou `daily_budget`) avec « Augmenter / Arrêter ». Un coût inconnu n'est jamais compté comme nul : le total dépensé est alors une borne basse (`MissionBudget.unknownCostCalls`).

---

## ADR-019 — Une seule définition des fichiers et secrets sensibles (C8)

- **Date** : 2026-09-27 · **Statut** : acceptée ; implémentée (intégration J2-A).

**Décision.** `packages/shared/src/sensitive.ts` est la **seule** source de vérité de C8 : `SENSITIVE_PATH_PATTERNS` (syntaxe gitignore, modèles `.env.example`/`.sample`/`.template` et clés publiques `*.pub` ré-autorisés, `.git/` et `node_modules/` exclus), `isSensitivePath` (évaluateur sans dépendance), `SECRET_PATTERNS` et `scanForSecrets`. Tous les consommateurs l'utilisent : le moteur de permissions (`createExcludedPathMatcher`), l'API fichiers de l'agent, la recherche et la surveillance (`createIgnoreMatcher().isExcluded`), le garde anti-exfiltration web (`inspectOutgoing`), le contexte joint aux messages et `redactSecrets` (qui masque désormais aussi les formes C8 : AWS, GitHub, JWT, chaînes de connexion, Slack, Google, Stripe, blocs PEM entiers). `.novaignore` ne peut qu'ajouter des exclusions. La liste est visible dans Réglages › Permissions.

**Pourquoi.** Trois listes divergentes existaient (moteur, espace de travail, web) : `.env.example` refusé ici et permis là, `.git/` et `*.tfstate` oubliés par l'une. Une écriture de l'agent dans `.git/` est maintenant refusée (C8) avant même la règle « demander pour les internes de Git », conservée en défense en profondeur.

## ADR-020 — Mentions et « Web » en mode Discuter, pour un seul message (C6, W1)

- **Date** : 2026-09-27 · **Statut** : acceptée ; implémentée (intégration J2-A).

**Décision.** `chat.send` accepte `workspaceId`, `attachments` (fichier, dossier, URL mentionnés par `@`) et `webSearch`. Le main résout le contexte **pour ce message uniquement** (`services/chat-context.ts`, `ChatRunnerDeps.prepareTurn`) : fichiers lus par l'API fichiers de l'agent (confinement, exclusions C8) puis analysés : un secret **bloque** l'envoi ; un `@mot` qui n'est pas un fichier est signalé « introuvable », pas fatal ; une URL passe par le service web (SSRF, politique de domaines ; la mention approuve son propre hôte une fois, une règle `deny` l'emporte). Le contexte est envoyé comme message système juste avant la question et **n'est jamais stocké** avec le message (aucun contenu de projet en base). « Web » devient le plugin OpenRouter avec les filtres de domaines de la politique ; les sources réellement citées (`url_citation`) sont ajoutées à la réponse enregistrée, jamais inventées.

**Limites.** Une relance (« Relancer ») repart sans les pièces jointes du message d'origine ; l'inspecteur de contexte reste une estimation côté renderer (pas de `chat.previewContext`).

## ADR-021 — `turndown` regroupé depuis sa version CommonJS

- **Date** : 2026-09-27 · **Statut** : acceptée.

**Décision.** Dans le bundle du main, `turndown` est aliasé vers sa version CommonJS (`electron.vite.config.ts`). Sa version ES appelle un `require("@mixmark-io/domino")` nu que Rollup laisse à l'exécution, où la disposition stricte de pnpm (et l'application empaquetée) ne le résout pas : le main plantait au chargement. Avec la version CommonJS, domino est regroupé. Aucune dépendance ajoutée.

**Autres choix d'intégration.** `@nova/missions` n'a pas besoin de déclarer `zod` : il n'importe que le `z` réexporté par `@nova/tools` (aucun `import "zod"` direct), donc aucun `pnpm add`. Le catalogue MCP recommandé est importé tel quel par le renderer (`@nova/mcp/catalog`, sans le SDK) plutôt que servi par une IPC.

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
| `@axe-core/playwright` | desktop (développement) | Audit d'accessibilité automatisé dans les E2E (scénario 15 : aucune violation grave ou critique). Licence MPL-2.0 ; dépendance de test uniquement, absente de l'application distribuée. |
| `oxlint`, `typescript`, `@types/node`, `@types/react`, `@types/react-dom` | racine, desktop, ui | Lint et vérification de types. |
| `@resvg/resvg-js` | racine | Rendu des icônes SVG en PNG (`pnpm icons`). |
| `@codemirror/state`, `view`, `commands`, `language`, `autocomplete`, `lint`, `search`, `merge`, `language-data`, `lang-javascript`, `lang-html`, `lang-css`, `lang-json`, `lang-markdown`, `lang-python`, `lang-yaml`, `lang-sql`, `lang-rust`, `lang-go`, `@lezer/highlight` | desktop (renderer, regroupé) | Éditeur de code (E2–E4, E11, relecture A11 avec `merge`). MIT. ADR-013. |
| `@xterm/xterm`, `@xterm/addon-fit`, `addon-search`, `addon-web-links`, `addon-webgl` | desktop (renderer, regroupé) | Affichage du terminal intégré (E13). MIT. |
| `node-pty` | desktop (`dependencies`, externe, désarchivé) | Pseudo-terminal du pty-host (E13). MIT, module natif N-API. ADR-012. |
| `@vscode/ripgrep` | desktop (`dependencies`, externe, désarchivé) | Binaire ripgrep pour la recherche projet et l'outil `search_text` (E4, A2). MIT. ADR-012. |
| `chokidar` | workspace | Surveillance des fichiers de l'espace (E1), sans module natif. MIT. |
| `ignore` | workspace | Règles `.gitignore`/`.novaignore` (E1, C8). MIT. |
| `diff` (jsdiff) | workspace | Diff, application inverse de blocs et fusion à trois voies (A10, A11, E2). BSD-3-Clause. |
| `jsonrepair` | tools | Réparation des arguments JSON d'appels d'outils avant validation zod (A1). ISC. |
| `@modelcontextprotocol/sdk` | mcp | Client MCP stdio et Streamable HTTP (M1) ; jamais de protocole réimplémenté. MIT. |
| `@mozilla/readability`, `linkedom`, `turndown` (+ `@types/turndown` en développement) | web | Lecture de pages : extraction lisible, DOM léger sans jsdom, conversion Markdown (W2). Apache-2.0, ISC, MIT. |

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
