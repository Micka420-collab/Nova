# Statut

Page de reprise : ce qui marche, ce qui a réellement été testé, ce qui ne l'est pas. Mise à jour à chaque jalon (règle de `AGENTS.md`). Une ligne n'entre dans « Fonctionne » ou « Testé réellement » qu'avec une commande exécutée et son résultat observé.

## État au 2026-09-27

- **Jalons en cours** : J0 (fondations) et J1 (vraie conversation). Voir [`ROADMAP.md`](ROADMAP.md).
- **Verdict** : non prêt pour la production. Aucun scénario d'acceptation n'est encore vérifié.
- **Code** : dernier commit sur `main` au moment de la rédaction : `b48b9e4` (monorepo et contrat partagé). Les modules du jalon 1 sont en cours d'écriture.

## Fonctionne

Au niveau produit : rien n'est encore déclaré fonctionnel de bout en bout.

Au niveau des briques :

- Masquage des secrets (`packages/shared/src/redact.ts`) : tests unitaires verts, voir ci-dessous.

_À compléter par l'intégrateur._

## Testé réellement (commande + résultat)

| Date | Commande | Environnement | Résultat | Par |
| --- | --- | --- | --- | --- |
| 2026-09-27 | `npx vitest run packages/shared/src/redact.test.ts` | Linux x64, Node 24.20.0, Vitest 5.0.2 | 1 fichier, 4 tests réussis | Voie documentation |
| à compléter | `pnpm lint` | | à compléter par l'intégrateur | |
| à compléter | `pnpm typecheck` | | à compléter par l'intégrateur | |
| à compléter | `pnpm test` | | à compléter par l'intégrateur | |
| à compléter | E2E Linux : `dbus-run-session -- bash e2e/run-with-keyring.sh xvfb-run -a pnpm exec playwright test` (dans `apps/desktop`, après `electron-vite build`) | | à compléter par l'intégrateur | |
| à compléter | CI GitHub Actions (`.github/workflows/ci.yml`) : identifiant du run | | à compléter par l'intégrateur | |
| à compléter | `pnpm --filter @nova/desktop package:dir` | | à compléter par l'intégrateur | |
| à compléter | Scénario 1 manuel avec un vrai compte OpenRouter | | à compléter par l'intégrateur | |

## Non vérifié

Tout le périmètre du jalon 1 tant qu'une ligne ci-dessus ne dit pas le contraire, en particulier :

- parcours des scénarios 1, 2, 3 et parties J1 des scénarios 14, 15, 16 ([`ACCEPTANCE.md`](ACCEPTANCE.md)) ;
- coffre `safeStorage` : niveau réellement détecté sur chaque OS, API asynchrone, consentement au coffre faible ;
- `node:sqlite` dans l'application **empaquetée** sur Windows et macOS ;
- protocole `nova://`, CSP, vérification de l'origine IPC, refus des permissions, liens externes filtrés, fuses Electron ;
- `NOVA_OPENROUTER_BASE_URL` ignorée ou limitée à l'adresse de boucle locale dans un build distribué ([`SECURITY.md`](SECURITY.md#réseau)) ;
- absence du contenu des conversations dans les journaux ;
- paquet sans `node_modules` ni module natif (ADR-002) ;
- avis de licence (OFL, ISC) présents dans le paquet ;
- mesures de référence : taille de l'installeur, mémoire au repos, CPU du compagnon au repos (ADR-001).

_À compléter par l'intégrateur._

## Obstacles

Contraintes connues à ce jour :

- **Pas de signature de code** (question Q3) : paquets non signés, avertissements SmartScreen et Gatekeeper attendus.
- **Windows et macOS** ne sont pas exécutables dans l'environnement local : leur vérification passe uniquement par la CI.
- **Linux sans écran** : pas de trousseau par défaut. Le niveau de coffre `os` n'est testé qu'avec le trousseau privé de `apps/desktop/e2e/run-with-keyring.sh` ; sinon, c'est le chemin du coffre faible qui s'exerce.
- **Sandbox du système sous Linux en E2E** : les E2E lancent Electron avec `--no-sandbox` sous Linux (pas d'assistant setuid de Chromium en CI et en conteneur). Le sandbox au niveau du système n'y est donc pas vérifié ; l'isolation JavaScript du renderer (pas de Node, API fixe) l'est.
- **Service réel** : les vérifications manuelles demandent une vraie clé OpenRouter avec un peu de crédit.

_À compléter par l'intégrateur._

## Matrice plateformes

Aucune plateforme n'est déclarée prise en charge tant que sa ligne n'indique pas « oui » pour construit, testé E2E et installable (ADR-007).

| Plateforme | Construit | Testé E2E | Signé | Installable |
| --- | --- | --- | --- | --- |
| Linux x64 — référence (Ubuntu 26.04) | à compléter par l'intégrateur | à compléter par l'intégrateur | Non (aucun certificat, Q3) | à compléter par l'intégrateur |
| Windows x64 (CI `windows-latest`) | à compléter par l'intégrateur | à compléter par l'intégrateur | Non (aucun certificat, Q3) | à compléter par l'intégrateur |
| macOS (CI `macos-latest`, architecture à consigner) | à compléter par l'intégrateur | à compléter par l'intégrateur | Non (aucun certificat, Q3) | à compléter par l'intégrateur |

Format attendu d'une cellule remplie : « Oui — 2026-mm-jj, commande ou run CI » ou « Non — raison ».

## Versions

| Élément | Version | Source |
| --- | --- | --- |
| Node (développement local) | 24.20.0 | `node --version`, 2026-09-27 |
| pnpm | 12.1.0 | `packageManager` du `package.json` racine |
| Electron | 44.4.5 (Chromium 152, Node 24.21) | `apps/desktop/package.json` ; versions internes relevées lors du cadrage |
| SQLite dans Electron | 3.53.4 | Relevé lors du cadrage (ADR-003) |
| TypeScript, Vitest | 7.0.2, 5.0.2 | Dépendances racine ; Vitest confirmé par l'exécution ci-dessus |

## Prochaine action

_À compléter par l'intégrateur._ Proposition : exécuter `pnpm check`, puis les E2E Linux, puis le scénario 1 avec un vrai compte ; reporter commandes et résultats ici.

## Historique de cette page

- 2026-09-27 — squelette initial.
