# Statut

Page de reprise : ce qui marche, ce qui a réellement été testé, ce qui ne l'est pas. Mise à jour à chaque jalon (règle de `AGENTS.md`). Une ligne n'entre dans « Fonctionne » ou « Testé réellement » qu'avec une commande exécutée et son résultat observé.

## État au 2026-09-28

- **Jalons en cours** : J0 (fondations) et J1 (vraie conversation) ; J2-A (« l'atelier s'ouvre ») intégré sur la branche `feat/j2a-atelier` (tête vérifiée : `643b286`, non poussée, CI non rejouée sur cette tête). Voir [`ROADMAP.md`](ROADMAP.md).
- **Verdict** : non prêt pour la production. La tranche verticale du jalon 1 et les parcours J2-A (a) à (j) fonctionnent sur Linux x64 contre un faux serveur OpenRouter ; rien n'a encore été parcouru avec une vraie clé, et J2-A n'a pas tourné sur Windows ni macOS.
- **Vérification finale J2-A (2026-09-28)** : lint, types, 1 746 tests unitaires, build, suite Playwright complète 29/29 deux fois de suite et `vault-smoke` `os` au vert, sans correctif nécessaire (détail dans « Testé réellement »).
- **Code** : commits sur `main` : `b48b9e4` (monorepo et contrat partagé), `a08ad93` (tranche verticale : application desktop, adaptateur OpenRouter, store SQLite, runtime, interface, CI, E2E), `996fd02` (logo : le concept de ruban du propriétaire redessiné en un seul tracé plein, icônes régénérées). Puis un commit de correctifs issus d'une revue adversariale (6 axes, 42 signalements, 40 confirmés par deux contre-vérificateurs, tous corrigés avec test de non-régression).

## Fonctionne

Sur Linux x64, application construite, contre le faux serveur OpenRouter local (voir « Testé réellement ») :

- premier lancement, enregistrement de la clé, choix d'un modèle, réponse en continu, historique conservé après redémarrage (scénario 1) ;
- erreurs fournisseur expliquées, texte partiel conservé, clé invalide et crédit épuisé (scénario 2) ;
- arrêt d'une génération sans interface bloquée (scénario 3) ;
- compagnon masqué et mouvement réduit sans perte de fonction, navigation au clavier et audit axe-core sans violation grave ou critique (parties J1 des scénarios 14 et 15) ;
- isolation du renderer : pas d'accès Node, pont fixe, CSP, navigation et fenêtres refusées, liens externes filtrés ;
- niveau de coffre détecté : `os` (backend `gnome_libsecret`) avec un trousseau, `weak` (backend `basic_text`) sans trousseau ;
- message resté « en cours » lors d'un plantage marqué « interrompu » au redémarrage, sans relance.

J2-A, sur Linux x64, application construite, contre le faux serveur OpenRouter (`e2e/atelier-wiring.spec.ts`) :

- les 13 groupes de l'atelier (`workspace`, `files`, `search`, `terminal`, `missions`, `approvals`, `permissions`, `audit`, `git`, `mcp`, `web`, `companion`, `checkpoints`) répondent depuis leur service réel ; plus aucune réponse `unavailable` de phase 0 ;
- ouverture d'un dossier depuis l'accueil, arbre affiché ; lecture, recherche ripgrep (`.env` jamais cherché), faits du projet, disposition de l'éditeur conservée, terminal node-pty créé, listé et fermé ;
- une mission complète dans le worker `agent-runtime` : plan, contrat, lecture, demande d'approbation (« une fois »), modification avec point de reprise, réussite, coût réel, `missions.diff`, relecture qui annule le bloc, journal d'audit (décisions, approbation, exécutions) ;
- un message de conversation joint `@src/cart.ts` pour ce seul tour ; `@.env` est refusé.

Parcours J2-A par l'interface (specs `e2e/j2a-*.spec.ts`, faux serveur OpenRouter, serveur MCP stdio de test) :

- (a) ouvrir un dossier, parcourir, éditer et enregistrer ; un changement externe est détecté (tampon propre rechargé, tampon modifié : question, jamais écrasé) ;
- (b) mission « Corriger » : approbations dans la carte, vraie commande de test via `run_tests` (rouge puis vert) comme preuve, relecture qui annule un fichier et garde l'autre, modifications de l'utilisateur conservées (scénarios 4 et 5) ;
- (c) chemins `..`, absolus et liens symboliques sortants refusés par le moteur ; une écriture refusée n'est jamais exécutée (scénario 6) ;
- (d) instructions hostiles lues dans un fichier traitées comme données (scénario 7, partie fichier) ;
- (e) terminal node-pty dans le dossier du projet ; Ctrl+C arrête réellement un programme ;
- (f) MCP : ajout d'un serveur stdio, outils listés, appel approuvé, outil « Refuser » jamais appelé, plantage du serveur visible, serveur désactivé, délai dépassé (scénario 8 partiel) ;
- (g) `web_search` : sources citées avec coût, présentées comme pages non fiables ; bouton « Web » de Discuter ;
- (h) Nomi suit une mission en direct puis transforme un échec de tests en suggestion qui l'explique ;
- (i) plafond de budget : suspension avant l'appel qui le franchirait, reprise après relèvement ; « Arrêter » donne un seul résultat terminal (scénario 10, un worker) ;
- (j) NOVA tué après un effet externe : au redémarrage, pas de relance, un seul effet, action interrompue affichée comme telle (scénario 11).

Avec le vrai service OpenRouter : seuls la lecture du catalogue (458 modèles) et le traitement d'une clé refusée (HTTP 401 → `invalid_key`) ont été exercés.

## Testé réellement (commande + résultat)

Environnement commun, sauf mention contraire : Linux x64, Ubuntu 26.04, Node 24.20.0, 2026-09-27.

| Date | Commande | Environnement | Résultat | Par |
| --- | --- | --- | --- | --- |
| 2026-09-27 | `pnpm lint` | Linux x64 | Aucun avertissement | Voie principale |
| 2026-09-27 | `pnpm typecheck` | Linux x64 | Aucune erreur | Voie principale |
| 2026-09-27 | `pnpm test` (après correctifs de revue) | Linux x64, Vitest 5.0.2 | 38 fichiers, 520 tests réussis ; 2 ignorés (suite OpenRouter en direct, sans clé) | Voie principale |
| 2026-09-27 | E2E Playwright après correctifs (`xvfb-run -a npx playwright test`) + `vault-smoke` os/weak | Linux x64, Electron 44.4.5 | 13/13 réussis ; coffre `os`/`gnome_libsecret` et `weak`/`basic_text` détectés | Voie principale |
| 2026-09-27 | `pnpm exec electron-vite build && xvfb-run -a pnpm exec playwright test` (dans `apps/desktop`) | Linux x64, Xvfb | 13/13 réussis : `bridge-security.spec.ts` 7, `ui-journey.spec.ts` 6 (scénarios 1, 2 ×2, 3, 14, 15 ; axe-core : 0 violation grave ou critique). Coffre faible ou session uniquement (voir « Obstacles ») | Voie principale |
| 2026-09-27 | `dbus-run-session -- bash e2e/run-with-keyring.sh xvfb-run -a node e2e/vault-smoke.mjs --expect os` | Linux x64, trousseau gnome-keyring privé | Niveau `os`, backend `gnome_libsecret` | Voie principale |
| 2026-09-27 | `xvfb-run -a node e2e/vault-smoke.mjs --expect weak` | Linux x64, sans trousseau | Niveau `weak`, backend `basic_text` | Voie principale |
| 2026-09-27 | `pnpm exec electron-builder --config electron-builder.yml --linux dir` (dans `apps/desktop`) | Linux x64 | Dossier construit ; fuses relus sur le binaire et conformes à `electron-builder.yml` | Voie principale |
| 2026-09-27 | Build empaqueté Linux lancé avec `NOVA_OPENROUTER_BASE_URL`, `NOVA_USER_DATA_DIR`, `ELECTRON_RENDERER_URL` | Linux x64, dossier empaqueté | Les trois variables ignorées | Voie principale |
| 2026-09-27 | Catalogue OpenRouter en direct, puis vérification d'une clé invalide | Linux x64, réseau réel | 458 modèles reçus ; HTTP 401 traduit en `invalid_key` | Voie principale |
| 2026-09-27 | CI GitHub Actions (`.github/workflows/ci.yml`), run 36320963259 (commit `98762932`) | ubuntu, windows, macos | 4 jobs verts : lint/types/unitaires ; sur chaque OS E2E 13/13, `vault-smoke` et `electron-builder --dir` | CI |
| 2026-09-27 | J2-A phase 0 — `pnpm install` (`node-pty` compilé par node-gyp, N-API) puis un script lancé par le vrai binaire Electron qui ouvre un pty `echo nova-pty-ok` | Linux x64, Electron 44.4.5 (Node 24.21, ABI 149, N-API 10) | Sortie `nova-pty-ok`, code 0 ; `rgPath` résolu, `ripgrep 15.0.0` | Voie J2-A |
| 2026-09-27 | J2-A phase 0 — `nova --nova-selftest=workers` sur le build `out/` puis sur `release/linux-unpacked/nova` (`electron-builder --dir`, fuses actifs) | Linux x64, Xvfb | `ok: true` : 4 workers (`pty-host`, `fs-worker`, `agent-runtime`, `mcp-host`) répondent au ping ; pty `nova-pty-ok` dans le pty-host ; `ripgrep 15.0.0` lancé par le fs-worker depuis `app.asar.unpacked` | Voie J2-A |
| 2026-09-27 | J2-A phase 0 — `pnpm lint`, `pnpm typecheck`, `pnpm test` | Linux x64 | Lint et types sans erreur ; 42 fichiers, 578 tests réussis, 2 ignorés (migrations v1→v5, contrat partagé, workers, nonce CSP) | Voie J2-A |
| 2026-09-27 | J2-A phase 0 — `electron-vite build && xvfb-run -a npx playwright test` | Linux x64, Xvfb | 16/16 réussis : les 13 existants + `atelier-foundations.spec.ts` 3 (workers et natifs, nonce de style, relais de port) | Voie J2-A |
| 2026-09-27 | Intégration J2-A — `npx tsc -p tsconfig.json --noEmit` | Linux x64 | 0 erreur | Intégration J2-A |
| 2026-09-27 | Intégration J2-A — `npx oxlint --deny-warnings apps packages scripts` | Linux x64 | 0 erreur, 0 avertissement | Intégration J2-A |
| 2026-09-27 | Intégration J2-A — `npx vitest run` | Linux x64, Vitest 5.0.2 | 129 fichiers réussis (1 ignoré), 1 630 tests réussis, 2 ignorés (suite OpenRouter en direct, test Windows) | Intégration J2-A |
| 2026-09-27 | Intégration J2-A — `cd apps/desktop && npx electron-vite build` puis `xvfb-run -a npx playwright test` | Linux x64, Electron 44.4.5, Xvfb | Build OK ; 19/19 réussis : les 16 existants + `atelier-wiring.spec.ts` 3 (groupes servis, mission de bout en bout, mentions en Discuter) | Intégration J2-A |
| 2026-09-28 | Vérification finale J2-A (tête `643b286`) — `pnpm lint` | Linux x64, Node 24.20.0 | Code 0, aucun avertissement (`oxlint --deny-warnings`) | Vérification finale J2-A |
| 2026-09-28 | Vérification finale J2-A — `pnpm typecheck` | Linux x64 | Code 0, aucune erreur | Vérification finale J2-A |
| 2026-09-28 | Vérification finale J2-A — `pnpm test` | Linux x64, Vitest 5.0.2 | 140 fichiers réussis, 1 ignoré (141) ; 1 746 tests réussis, 2 ignorés (1 748) ; 63,6 s | Vérification finale J2-A |
| 2026-09-28 | Vérification finale J2-A — `cd apps/desktop && npx electron-vite build` | Linux x64 | Build OK (13,1 s) ; seul avertissement : taille de bloc > 500 kB | Vérification finale J2-A |
| 2026-09-28 | Vérification finale J2-A — `LD_LIBRARY_PATH=<.devdeps>/usr/lib/x86_64-linux-gnu timeout 1800 xvfb-run -a -s "-screen 0 1440x900x24" npx playwright test` (dans `apps/desktop`), lancé deux fois de suite | Linux x64, Electron 44.4.5, Xvfb 1440×900 | Passage 1 : 29/29 (2,5 min) ; passage 2 : 29/29 (2,4 min). `atelier-foundations` 3, `atelier-wiring` 3, `bridge-security` 7, `j2a-budget-crash` 2, `j2a-mcp` 1, `j2a-mission` 1, `j2a-permissions` 2, `j2a-terminal` 1, `j2a-web-nomi` 2, `j2a-workspace` 1, `ui-journey` 6 ; aucune relance | Vérification finale J2-A |
| 2026-09-28 | Vérification finale J2-A — `NOVA_KEYRING_ROOT=<.devdeps> dbus-run-session -- bash e2e/run-with-keyring.sh xvfb-run -a node e2e/vault-smoke.mjs --expect os` | Linux x64, trousseau gnome-keyring privé | Code 0 : `level=os backend=gnome_libsecret expected=os` | Vérification finale J2-A |
| en attente | Scénario 1 manuel avec un vrai compte OpenRouter (réponse en continu réelle) | | à faire : demande une clé avec crédit | |

## Non vérifié

- **Réponse en continu avec une vraie clé OpenRouter** : seuls le catalogue et le refus d'une clé ont été testés contre le vrai service.
- **Coffre `os` de bout en bout sous Linux** : le chargeur Electron de Playwright force `--password-store=basic`, donc les E2E Playwright sous Linux n'exercent que le coffre faible ou la clé de session. Le niveau `os` n'est vérifié que par `vault-smoke.mjs` (application réelle hors Playwright), qui constate le niveau détecté. Chiffrer une clé au coffre `os`, redémarrer et la relire n'est pas couvert par un test versionné (un essai ponctuel de la voie principale a réussi, non consigné comme test).
- **Windows et macOS** : aucun résultat tant que la CI n'a pas tourné ; `node:sqlite` dans l'application empaquetée sur ces systèmes non vérifié.
- **Lecteur d'écran** (Orca, NVDA, VoiceOver) : aucun passage manuel.
- **Signature des installeurs** : aucune (question Q3).
- **Effacement sur disque** : `PRAGMA secure_delete` et le point de contrôle WAL après suppression sont en place et testés au niveau du store (absence des octets dans les fichiers) ; les limites physiques (SSD, instantanés) restent hors de portée — voir [`SECURITY.md`](SECURITY.md#effacement-des-données).
- Paquet : depuis ADR-012, `node_modules` contient uniquement `node-pty` et `@vscode/ripgrep` (+ binaire de la plateforme), désarchivés ; vérifié sous Linux (`release/linux-unpacked`), **pas encore sous Windows et macOS** (prébuilds de `node-pty`, `spawn-helper` sous macOS) : la CI et la release rejouent désormais `--nova-selftest=workers` sur l'app empaquetée (`e2e/packaged-selftest.mjs`), et chaque arch mac est construite sur son propre runner (`macos-latest` arm64, `macos-15-intel` x64) car pnpm n'installe le binaire ripgrep que pour le cpu hôte — non encore observé en CI.
- J2-A, pas encore vérifié sur la tête `643b286` : CI trois OS (branche non poussée ; Windows et macOS n'ont jamais exécuté les specs `j2a-*`) ; `vault-smoke --expect weak` et `--nova-selftest=workers` sur le paquet `electron-builder --dir` (non relancés le 2026-09-28) ; démonstration J2-A sur le build empaqueté (le dépôt de test `e2e/fixtures/vite-bug` n'existe pas) ; scénarios 15 et 16 rejoués sur le périmètre de l'atelier (l'audit axe-core ne couvre que le parcours de conversation ; journal d'audit et exports de mission non inspectés pour les secrets par un E2E) ; mesures initiales de performance (tableau §3 de `FEATURES.md`).
- J2-A, vérifié seulement contre le faux serveur : appels d'outils et recherche web avec le vrai OpenRouter ; serveurs MCP réels (seul un serveur de test du SDK a été exercé) ; xterm.js sans WebGL perd les couleurs « truecolor » sous la CSP à nonce (bandeau « mode dégradé ») ; isolation L0 seulement (bubblewrap détecté, jamais présenté comme actif).
- J2-A, non fait (aucun groupe masqué : tous les groupes sont servis ; ce qui manque n'a pas de bouton) :
  - mémoriser une commande précise (`PermissionRule.argvPrefix`, demande une migration) ; journal des notifications de Nomi persistant (table `companion_notices`, migration) ;
  - outils de suivi des processus en arrière-plan (`process_list` / `process_stop`) ; événement « modèle de secours utilisé » (Mo2) ;
  - inspecteur de contexte exact (`chat.previewContext`) et mentions transmises au plan de mission (`MissionPlanRequest.mentions`) ; « Relancer » repart sans les pièces jointes ;
  - recherche projet en flux (MessagePort), lecture paginée des fichiers de 5 à 50 Mo et aperçu hexadécimal ; `truncated` sur `files.list` ;
  - relancer directement une réponse échouée depuis la bulle de Nomi (elle ouvre la conversation) ; commandes de Nomi une à une dans la palette (la palette ouvre le menu de Nomi, Ctrl+Maj+N) ;
  - commandes de l'agent dans le terminal (E13, partie agent) : `run_command` / `run_tests` s'exécutent dans main (`child_process`, L0), jamais dans le pty-host ; les sessions d'agent en lecture seule et « Prendre la main » existent dans le pty-host et le panneau, mais aucune mission n'en crée (`createAgentSession` n'a pas d'appelant) : le dock ne montre donc jamais de commande de l'agent ;
  - vue scindée du terminal, blocs OSC 133 ; editorconfig, minimap ; profils Vim/Emacs ; panneaux Ctrl+1…9 ;
  - jetons de l'atelier encore dans `packages/ui/src/styles/agent.css` (à déplacer dans `tokens.css` avec tests de contraste) ; contraste de `--nv-match-bg` en sombre (3,72:1) à corriger dans VISUAL.md.
- Avis de licence (OFL, ISC) présents dans le paquet.
- Mesures de référence : taille de l'installeur, mémoire au repos, CPU du compagnon au repos (ADR-001).

## Obstacles

- **Pas de signature de code** (question Q3) : paquets non signés, avertissements SmartScreen et Gatekeeper attendus.
- **Windows et macOS** ne sont pas exécutables dans l'environnement local : leur vérification passe uniquement par la CI.
- **Coffre sous Playwright** : Playwright force `--password-store=basic` au lancement d'Electron. Le niveau `os` ne peut donc pas être testé par les specs Playwright sous Linux ; il l'est par `apps/desktop/e2e/vault-smoke.mjs`, lancé avec le trousseau privé de `e2e/run-with-keyring.sh`.
- **Intégrité de l'archive sous Linux** : le fuse `enableEmbeddedAsarIntegrityValidation` n'est appliqué par Electron que sous macOS et Windows. Sous Linux (plateforme de référence, AppImage), une archive `app.asar` modifiée n'est pas détectée. Limite connue.
- **Sandbox du système sous Linux en E2E** : les E2E lancent Electron avec `--no-sandbox` sous Linux (pas d'assistant setuid de Chromium en CI et en conteneur). Le sandbox au niveau du système n'y est donc pas vérifié ; l'isolation JavaScript du renderer (pas de Node, API fixe) l'est.
- **Service réel** : les vérifications manuelles demandent une vraie clé OpenRouter avec un peu de crédit.
- **Bibliothèques graphiques de la machine locale** : sur la machine de développement, Electron sous Xvfb et le trousseau privé demandent des bibliothèques système extraites hors dépôt dans `.devdeps/linux-gui/root` (ignoré par git) ; d'où `LD_LIBRARY_PATH=.devdeps/linux-gui/root/usr/lib/x86_64-linux-gnu` pour Playwright et `NOVA_KEYRING_ROOT=.devdeps/linux-gui/root` pour `run-with-keyring.sh`. La CI utilise les paquets du système.

## Matrice plateformes

Aucune plateforme n'est déclarée prise en charge tant que sa ligne n'indique pas « oui » pour construit, testé E2E et installable (ADR-007).

| Plateforme | Construit | Testé E2E | Signé | Installable |
| --- | --- | --- | --- | --- |
| Linux x64 — référence (Ubuntu 26.04) | Oui — 2026-09-27, `electron-builder --linux dir` | Oui — 2026-09-28, Playwright 29/29 deux fois (J1 + J2-A, coffre faible ou session) et `vault-smoke` `os` ; `weak` le 2026-09-27 | Non (aucun certificat, Q3) | Non vérifié (AppImage non testée) |
| Windows x64 (CI `windows-latest`) | Oui — run 36320963259 (commit `98762932`), `win-unpacked` | Oui pour J1 — E2E 13/13 ; coffre `os`/`dpapi` détecté hors Playwright. J2-A : non vérifié | Non (aucun certificat, Q3) | Non vérifié (installeur NSIS non testé) |
| macOS arm64 (CI `macos-latest`) | Oui — run 36320963259 (commit `98762932`), `mac-arm64` | Oui pour J1 — E2E 13/13 (trousseau factice de Playwright) ; coffre `os`/`keychain` détecté hors Playwright avec un trousseau de test déverrouillé. J2-A : non vérifié | Non (aucun certificat, Q3) | Non vérifié (DMG non testé) |

Format attendu d'une cellule remplie : « Oui — 2026-mm-jj, commande ou run CI » ou « Non — raison ».

## Versions

| Élément | Version | Source |
| --- | --- | --- |
| Node (développement local) | 24.20.0 | `node --version`, 2026-09-27 |
| pnpm | 12.1.0 | `packageManager` du `package.json` racine |
| Electron | 44.4.5 (Chromium 152, Node 24.21) | `apps/desktop/package.json` ; versions internes relevées lors du cadrage |
| SQLite dans Electron | 3.53.4 | Relevé lors du cadrage (ADR-003) |
| TypeScript, Vitest | 7.0.2, 5.0.2 | Dépendances racine ; Vitest confirmé par l'exécution ci-dessus |
| Playwright | 1.63.0 | `apps/desktop/package.json` |

## Prochaine action

1. Pousser `feat/j2a-atelier` et consigner le run CI sur la tête (ubuntu, windows, macos : E2E 29/29, `vault-smoke`, `--nova-selftest=workers` sur le paquet, arch mac x64 sur `macos-15-intel`), puis mettre la matrice à jour.
2. Rejouer les scénarios 15 et 16 sur le périmètre de l'atelier (axe-core sur l'atelier ; journal d'audit et exports de mission inspectés pour les secrets).
3. Créer le dépôt de démonstration `e2e/fixtures/vite-bug` et jouer la démonstration J2-A sur le build empaqueté Linux ; relever les mesures initiales de performance.
4. Scénario 1 et une mission J2-A avec un vrai compte OpenRouter ; reporter commande et résultat ici.
5. Ajouter un test versionné du coffre `os` avec redémarrage sous Linux (hors Playwright).

## Historique de cette page

- 2026-09-28 — vérification finale J2-A sur `643b286` : lint, types, tests unitaires, build, Playwright 29/29 ×2, `vault-smoke` `os`.
- 2026-09-27 — squelette initial.
- 2026-09-27 — J2-A phase 0 (socle) : dépendances, contrat partagé, migrations v2–v5, workers, nonce CSP.
- 2026-09-27 — résultats de la tranche verticale (`a08ad93`, `996fd02`) : lint, types, tests unitaires, E2E Linux, coffre, paquet Linux.
