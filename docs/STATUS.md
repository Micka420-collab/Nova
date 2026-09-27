# Statut

Page de reprise : ce qui marche, ce qui a réellement été testé, ce qui ne l'est pas. Mise à jour à chaque jalon (règle de `AGENTS.md`). Une ligne n'entre dans « Fonctionne » ou « Testé réellement » qu'avec une commande exécutée et son résultat observé.

## État au 2026-09-27

- **Jalons en cours** : J0 (fondations) et J1 (vraie conversation). Voir [`ROADMAP.md`](ROADMAP.md).
- **Verdict** : non prêt pour la production. La tranche verticale du jalon 1 fonctionne sur Linux x64 contre un faux serveur OpenRouter ; elle n'a pas encore été parcourue avec une vraie clé, ni sur Windows et macOS.
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
| en attente | Scénario 1 manuel avec un vrai compte OpenRouter (réponse en continu réelle) | | à faire : demande une clé avec crédit | |

## Non vérifié

- **Réponse en continu avec une vraie clé OpenRouter** : seuls le catalogue et le refus d'une clé ont été testés contre le vrai service.
- **Coffre `os` de bout en bout sous Linux** : le chargeur Electron de Playwright force `--password-store=basic`, donc les E2E Playwright sous Linux n'exercent que le coffre faible ou la clé de session. Le niveau `os` n'est vérifié que par `vault-smoke.mjs` (application réelle hors Playwright), qui constate le niveau détecté. Chiffrer une clé au coffre `os`, redémarrer et la relire n'est pas couvert par un test versionné (un essai ponctuel de la voie principale a réussi, non consigné comme test).
- **Windows et macOS** : aucun résultat tant que la CI n'a pas tourné ; `node:sqlite` dans l'application empaquetée sur ces systèmes non vérifié.
- **Lecteur d'écran** (Orca, NVDA, VoiceOver) : aucun passage manuel.
- **Signature des installeurs** : aucune (question Q3).
- **Effacement sur disque** : `PRAGMA secure_delete` et le point de contrôle WAL après suppression sont en place et testés au niveau du store (absence des octets dans les fichiers) ; les limites physiques (SSD, instantanés) restent hors de portée — voir [`SECURITY.md`](SECURITY.md#effacement-des-données).
- Paquet : depuis ADR-012, `node_modules` contient uniquement `node-pty` et `@vscode/ripgrep` (+ binaire de la plateforme), désarchivés ; vérifié sous Linux (`release/linux-unpacked`), **pas encore sous Windows et macOS** (prébuilds de `node-pty`, `spawn-helper` sous macOS) : rejouer `--nova-selftest=workers` sur les paquets de la CI.
- J2-A : les groupes IPC `workspace`, `files`, `search`, `terminal`, `missions`, `approvals`, `permissions`, `git`, `mcp`, `web`, `companion`, `checkpoints` existent au contrat mais répondent `unavailable` (phase 0) ; xterm.js n'est pas encore vérifié contre la CSP à nonce.
- Avis de licence (OFL, ISC) présents dans le paquet.
- Mesures de référence : taille de l'installeur, mémoire au repos, CPU du compagnon au repos (ADR-001).

## Obstacles

- **Pas de signature de code** (question Q3) : paquets non signés, avertissements SmartScreen et Gatekeeper attendus.
- **Windows et macOS** ne sont pas exécutables dans l'environnement local : leur vérification passe uniquement par la CI.
- **Coffre sous Playwright** : Playwright force `--password-store=basic` au lancement d'Electron. Le niveau `os` ne peut donc pas être testé par les specs Playwright sous Linux ; il l'est par `apps/desktop/e2e/vault-smoke.mjs`, lancé avec le trousseau privé de `e2e/run-with-keyring.sh`.
- **Intégrité de l'archive sous Linux** : le fuse `enableEmbeddedAsarIntegrityValidation` n'est appliqué par Electron que sous macOS et Windows. Sous Linux (plateforme de référence, AppImage), une archive `app.asar` modifiée n'est pas détectée. Limite connue.
- **Sandbox du système sous Linux en E2E** : les E2E lancent Electron avec `--no-sandbox` sous Linux (pas d'assistant setuid de Chromium en CI et en conteneur). Le sandbox au niveau du système n'y est donc pas vérifié ; l'isolation JavaScript du renderer (pas de Node, API fixe) l'est.
- **Service réel** : les vérifications manuelles demandent une vraie clé OpenRouter avec un peu de crédit.

## Matrice plateformes

Aucune plateforme n'est déclarée prise en charge tant que sa ligne n'indique pas « oui » pour construit, testé E2E et installable (ADR-007).

| Plateforme | Construit | Testé E2E | Signé | Installable |
| --- | --- | --- | --- | --- |
| Linux x64 — référence (Ubuntu 26.04) | Oui — 2026-09-27, `electron-builder --linux dir` | Oui — 2026-09-27, Playwright 13/13 (coffre faible ou session) et `vault-smoke` `os` et `weak` | Non (aucun certificat, Q3) | Non vérifié (AppImage non testée) |
| Windows x64 (CI `windows-latest`) | Oui — run 36320963259 (commit `98762932`), `win-unpacked` | Oui — E2E 13/13 ; coffre `os`/`dpapi` détecté hors Playwright | Non (aucun certificat, Q3) | Non vérifié (installeur NSIS non testé) |
| macOS arm64 (CI `macos-latest`) | Oui — run 36320963259 (commit `98762932`), `mac-arm64` | Oui — E2E 13/13 (trousseau factice de Playwright) ; coffre `os`/`keychain` détecté hors Playwright avec un trousseau de test déverrouillé | Non (aucun certificat, Q3) | Non vérifié (DMG non testé) |

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

1. Terminer et committer les correctifs de revue, puis relancer `pnpm check` et les E2E.
2. Pousser et consigner le premier run CI (ubuntu, windows, macos), puis remplir la matrice.
3. Scénario 1 manuel avec un vrai compte OpenRouter ; reporter commande et résultat ici.
4. Ajouter un test versionné du coffre `os` avec redémarrage sous Linux (hors Playwright).

## Historique de cette page

- 2026-09-27 — squelette initial.
- 2026-09-27 — J2-A phase 0 (socle) : dépendances, contrat partagé, migrations v2–v5, workers, nonce CSP.
- 2026-09-27 — résultats de la tranche verticale (`a08ad93`, `996fd02`) : lint, types, tests unitaires, E2E Linux, coffre, paquet Linux.
