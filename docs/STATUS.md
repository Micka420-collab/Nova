# Statut

Page de reprise : ce qui marche, ce qui a réellement été testé, ce qui ne l'est pas. Mise à jour à chaque jalon (règle de `AGENTS.md`). Une ligne n'entre dans « Fonctionne » ou « Testé réellement » qu'avec une commande exécutée et son résultat observé.

## État au 2026-09-28

- **Jalons en cours** : J0 (fondations) et J1 (vraie conversation) ; J2-A (« l'atelier s'ouvre ») intégré sur la branche `feat/j2a-atelier` (tête vérifiée : `643b286`, non poussée, CI non rejouée sur cette tête). Voir [`ROADMAP.md`](ROADMAP.md).
- **Verdict** : non prêt pour la production. La tranche verticale du jalon 1 et les parcours J2-A (a) à (j) fonctionnent sur Linux x64 contre un faux serveur OpenRouter ; rien n'a encore été parcouru avec une vraie clé, et J2-A n'a pas tourné sur Windows ni macOS.
- **J2-B « parité Harness », phase 0 (2026-09-28, branche `feat/j2b-parite-harness`)** : contrats partagés des huit voies (processus et terminal de l'agent, compaction et dossier de passation, skills, mode « Chaîne », sous-missions, missions planifiées, présence bureau et pilote automatique, missions « jusqu'à preuve » et chronologie), migration v6, dépôts et points d'extension (boucle, passerelle d'outils, lien runtime). Aucune fonction J2-B n'est encore visible : les huit groupes IPC répondent `unavailable` et aucun outil J2-B n'est proposé au modèle tant que sa voie n'est pas branchée.
- **J2-B « parité Harness », intégration (2026-09-28, branche `feat/j2b-parite-harness`, non poussée)** : les huit voies sont branchées dans le main (services, outils, crochets de la boucle, hôte `chain-host`) et dans l'interface (panneaux de mission, options du contrat, documents Extensions › Skills, Missions planifiées et Recherche dans les missions, palette, réglages « Bureau et affichage », accueil de profil). Plus aucun groupe IPC ne répond `unavailable`. Vérifié sur Linux x64 contre le faux serveur OpenRouter : lint, types, 2 212 tests unitaires, build, Playwright 42/42 (les 29 existants + 13 parcours J2-B). Détail et limites plus bas.
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

Parcours J2-B par l'interface (specs `e2e/j2b-*.spec.ts`, faux serveur OpenRouter) :

- (L1) une mission lance deux serveurs en arrière-plan, approuvés dans leur carte ; le dock montre la session de Nomi en lecture seule (saisie ignorée), « Prendre la main » la rend saisissable ; `process_list`, `process_output`, `process_stop` (approuvé) ; quitter NOVA tue le serveur restant ;
- (L2) une mission dépasse 80 % du contexte : carte « Résumé proposé », « Appliquer », la requête suivante porte le résumé ; « /compact » en Discuter ; changement de modèle en cours de mission par un dossier de passation, requête suivante sur le nouveau modèle ;
- (L3) installer une skill depuis un dossier (aperçu avant « Installer »), l'activer pour le projet, carte « Skill chargée » dans une mission, désinstallation sans résidu (l'outil `skill` n'est alors plus proposé) ;
- (L4) mode « Chaîne » : un programme lit deux fichiers puis en modifie un (approbation dans la carte), les trois appels sous la carte du programme, audit des trois exécutions ; un programme dont une lecture (`.env`) est refusée par les permissions : l'appel lève une erreur dans le programme, qui continue, refus visible sous sa carte et audité, le secret n'atteint jamais le fournisseur ;
- (L5) deux sous-missions (lecture et écriture) en arbre ; l'enfant écrivain intégré après ses tests, l'autre « rien à intégrer », aucun worktree restant ; budget partagé : réservation de l'enfant sur le budget du parent, une seconde sous-mission qui ne tient plus est refusée (carte en échec, message en français), réservation libérée à la fin de l'enfant ;
- (L6) planification « toutes les minutes » créée dans l'éditeur : première exécution ≈ 60 s plus tard comme mission normale, « Réussie » dans l'historique, puis mise en pause : l'échéance suivante passe sans exécution ; planification unique exécutée ;
- (L7) accueil (profil et densité) enregistré ; pilote automatique affiché puis modifié avant l'envoi (l'effort choisi part au fournisseur) ; image collée avec un modèle texte : modèle vision proposé, image envoyée une fois, jamais stockée ; fenêtre fermée avec l'option active : la mission continue, quitter demande confirmation ; menu de la barre système (observé via `Menu.buildFromTemplate`) : état de Nomi et mission en cours listés, « Ouvrir NOVA » réaffiche la fenêtre, « Quitter NOVA » nomme la mission et « Annuler » garde tout, puis au repos quitter ne demande plus rien ;
- (L8) « Jusqu'à preuve » : tests rouges au tour 0, verts au tour 1, `continuation.stopped proven` puis réussite ; recherche « panier » ; « Bifurquer d'ici » prépare une mission liée, rien de rejoué ; un tour qui dépense plus que le plafond de poursuite arrête les tours (`continuation.stopped budget`, « Plafond de poursuite atteint · 1 tour », mission `failed`, pas de tour 2).

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
| 2026-09-28 | J2-B phase 0 — `pnpm lint`, `pnpm typecheck` | Linux x64 | Code 0, aucun avertissement ni erreur | Architecte J2-B |
| 2026-09-28 | J2-B phase 0 — `pnpm test` | Linux x64, Vitest 5.0.2 | 145 fichiers réussis, 1 ignoré ; 1 788 tests réussis, 2 ignorés (contrats J2-B, migration v6 et dépôts, crochets de boucle, appels imbriqués de la passerelle, tranches de la vue mission) | Architecte J2-B |
| 2026-09-28 | J2-B phase 0 — `npx electron-vite build` puis `xvfb-run -a npx playwright test` (dans `apps/desktop`) | Linux x64, Electron 44.4.5, Xvfb 1440×900 | Build OK ; 29/29 réussis (pont exposé : 27 groupes, dont les 8 groupes J2-B) | Architecte J2-B |
| 2026-09-28 | Intégration J2-B — `pnpm lint` ; `pnpm typecheck` | Linux x64, Node 24.20.0 | Code 0, aucun avertissement ni erreur | Intégration J2-B |
| 2026-09-28 | Intégration J2-B — `pnpm test` | Linux x64, Vitest 5.0.2 | 208 fichiers réussis, 1 ignoré (209) ; 2 212 tests réussis, 2 ignorés (2 214) | Intégration J2-B |
| 2026-09-28 | Intégration J2-B — `cd apps/desktop && npx electron-vite build` | Linux x64 | Build OK, 5 entrées worker dont `chain-host` ; seul avertissement : taille de bloc > 500 kB | Intégration J2-B |
| 2026-09-28 | Intégration J2-B — `LD_LIBRARY_PATH=<.devdeps>/usr/lib/x86_64-linux-gnu xvfb-run -a npx playwright test` (dans `apps/desktop`) | Linux x64, Electron 44.4.5, Xvfb | 42/42 réussis (4,8 min) : les 29 existants (dont `atelier-foundations` qui exige désormais `chain: ok` du self-test) + `j2b-chain` 1, `j2b-compaction` 3, `j2b-desktop` 4, `j2b-proof-timeline` 1, `j2b-schedules` 1, `j2b-skills` 1, `j2b-submissions` 1, `j2b-terminal-agent` 1 | Intégration J2-B |
| 2026-09-28 | E2E J2-B complétés — `pnpm lint` ; `pnpm typecheck` ; `pnpm test` | Linux x64, Vitest 5.0.2 | Code 0 ; 208 fichiers réussis, 1 ignoré ; 2 215 tests réussis, 2 ignorés | E2E J2-B |
| 2026-09-28 | E2E J2-B complétés — `npx electron-vite build` puis `LD_LIBRARY_PATH=<.devdeps>/usr/lib/x86_64-linux-gnu xvfb-run -a npx playwright test` (dans `apps/desktop`), deux fois de suite | Linux x64, Electron 44.4.5, Xvfb | 46/46 puis 46/46 (≈ 5 min chacun) : + Chaîne avec appel refusé, budget partagé des sous-missions, planification « toutes les minutes » exécutée puis en pause, menu de la barre système et avertissement de sortie, arrêt de la poursuite au plafond | E2E J2-B |
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
  - événement « modèle de secours utilisé » (Mo2) (les outils `process_list` / `process_output` / `process_stop` existent depuis J2-B) ;
  - inspecteur de contexte exact (`chat.previewContext`) et mentions transmises au plan de mission (`MissionPlanRequest.mentions`) ; « Relancer » repart sans les pièces jointes ;
  - recherche projet en flux (MessagePort), lecture paginée des fichiers de 5 à 50 Mo et aperçu hexadécimal ; `truncated` sur `files.list` ;
  - relancer directement une réponse échouée depuis la bulle de Nomi (elle ouvre la conversation) ; commandes de Nomi une à une dans la palette (la palette ouvre le menu de Nomi, Ctrl+Maj+N) ;
  - (fait en J2-B L1 : les processus en arrière-plan tournent dans une session d'agent du pty-host, les commandes au premier plan y sont reflétées en lecture seule) ;
  - vue scindée du terminal, blocs OSC 133 ; editorconfig, minimap ; profils Vim/Emacs ; panneaux Ctrl+1…9 ;
  - jetons de l'atelier encore dans `packages/ui/src/styles/agent.css` (à déplacer dans `tokens.css` avec tests de contraste) ; contraste de `--nv-match-bg` en sombre (3,72:1) à corriger dans VISUAL.md.
- J2-B, vérifié seulement contre le faux serveur et sur Linux x64 ; limites connues :
  - Windows et macOS : aucun passage (le chemin pty d'un processus en arrière-plan sous Windows n'est testé qu'avec un faux spawn) ; barre système sous certains bureaux Linux sans hôte StatusNotifier : l'icône peut exister sans être visible ; une entrée « Missions en cours » du menu de la barre ouvre NOVA sans sélectionner la mission ;
  - Chaîne : `vm` n'est pas une frontière de sécurité (ADR-022, risque résiduel V8) ;
  - compaction : un résumé proposé ne peut plus s'appliquer après un redémarrage ; le coût d'un résumé de conversation n'entre pas dans les totaux de la conversation ; `tokensAfter` est une estimation ;
  - skills : scripts des skills d'utilisateur et livrées non exécutables (hors du projet) ; dossier de skill de projet invalide absent de la liste sans explication ; « contenu changé depuis l'activation » dit seulement « désactivée » ; installation depuis un dossier seulement ; 3 skills livrées sur les 6 de M8 ;
  - sous-missions : intégration toujours manuelle ; chemins en conflit non listés dans l'interface ; outils git et processus non proposés à un enfant écrivain ; la dépense affichée du parent (`MissionBudget.spentUsd`, jauge d'en-tête, carte de fin) ne compte que ses propres appels : le coût réel d'un enfant est bien engagé sur le registre du parent (le plafond en tient compte) mais n'apparaît pas dans ce montant ; la carte « Déléguer » ne nomme pas la sous-mission ;
  - pilote automatique : coût du classement affiché seulement (non enregistré) ; l'accueil (`HomeView`) n'a ni images collées ni pilote automatique (la conversation les a) ; « Relancer » ne renvoie pas les images ;
  - « jusqu'à preuve » : la dépense d'un tour déjà lancé peut dépasser le plafond de la continuation d'au plus ce tour (jamais le budget de la mission) ; un fork dont la planification échoue n'est pas relié à l'original ;
  - planifications : un échec de planification n'est pas relié à sa mission `failed`.
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

- 2026-09-28 — revue J2-B, 22 défauts corrigés (tests unitaires qui échouent sur l'ancien code ; lint, types, 2 239 tests, build ; Playwright : specs J2-B desktop, chain, submissions, terminal-agent (mis à jour : la session reprise quitte la mission), schedules, compaction, proof-timeline, skills, plus j2a-mission, j2a-permissions et ui-journey au vert) : contexte non fiable transmis aux sous-missions, bifurcations et index de skills (W5) ; réserve d'une sous-mission hors du total du jour (migration v7) ; « Prendre la main » détache le processus de la mission ; plafond de processus tenu en parallèle ; aucun processus orphelin des sous-missions ni des tests d'intégration ; résumé de conversation limité aux échanges complets ; barre système et Réglages sans faux zéro ; approbations d'un programme « Chaîne » toujours visibles ; pilote automatique lié à son message ; catalogue non chargé jamais présenté comme vide ; plafond « Jusqu'à preuve » à 0 refusé.
- 2026-09-28 — E2E J2-B complétés (46/46 deux fois) ; corrections : titre d'approbation de `process_stop`, libellé « conflit » générique, tutoiement de la compaction, critères du dossier de passation en français, notices du terminal, marge des planifications, options segmentées.
- 2026-09-28 — intégration J2-B : les huit voies branchées (main, renderer, palette), demandes de contrat des voies appliquées (ADR-022, ADR-023) ; lint, types, 2 212 tests, build, Playwright 42/42.
- 2026-09-28 — J2-B phase 0 : contrats, migration v6 (skills, plannings, liens de missions, résumés de compaction, recherche FTS du journal, parent des appels d'une chaîne), points d'extension, stubs `unavailable`.
- 2026-09-28 — vérification finale J2-A sur `643b286` : lint, types, tests unitaires, build, Playwright 29/29 ×2, `vault-smoke` `os`.
- 2026-09-27 — squelette initial.
- 2026-09-27 — J2-A phase 0 (socle) : dépendances, contrat partagé, migrations v2–v5, workers, nonce CSP.
- 2026-09-27 — résultats de la tranche verticale (`a08ad93`, `996fd02`) : lint, types, tests unitaires, E2E Linux, coffre, paquet Linux.
