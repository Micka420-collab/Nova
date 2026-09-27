# NOVA — Power UX : clavier, éditeur, agent, terminal, accessibilité, performance, réglages

Document de conception pour les utilisatrices et utilisateurs avancés de NOVA (mode Expert d'abord, mais chaque décision profite aussi au mode Créer). Il complète [`UX.md`](UX.md) (parcours, états, ton) et [`VISUAL.md`](VISUAL.md) (anatomie, tokens, composants) ; il ne les répète pas. Quand il s'en écarte, l'écart est nommé et justifié (section 11).

Base de lecture : `docs/ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md`, `docs/DECISIONS.md`, `apps/desktop/src/renderer` (état au 2026-09-27, commits `a08ad93` → correctifs de revue), captures `apps/desktop/e2e/artifacts/screens/*.png`. Les points techniques qui décident d'un choix (CSP et injection de styles, ticket Monaco, rendu DOM de xterm, client LSP CodeMirror, intégration shell) ont été vérifiés à la source le jour de la rédaction ; ce qui reste à confirmer est marqué **à vérifier au spike**.

Conventions : `Ctrl` désigne `Ctrl` sous Windows et Linux et `⌘` sous macOS, sauf mention explicite ; `Maj`, `Alt`, `Entrée`, `Échap`, `Retour` suivent la microcopie de `renderer/copy/fr.ts`. Une touche notée entre crochets `[Digit1]` est identifiée par sa position physique (`KeyboardEvent.code`), pas par le caractère produit.

## Sommaire

0. [Décisions en une page](#0-décisions-en-une-page)
1. [Ce qui existe et ce qui contraint](#1-ce-qui-existe-et-ce-qui-contraint)
2. [Système clavier d'abord](#2-système-clavier-dabord)
3. [Éditeur : moteur et disposition](#3-éditeur--moteur-et-disposition)
4. [UX agent pour utilisateurs avancés](#4-ux-agent-pour-utilisateurs-avancés)
5. [Terminal](#5-terminal)
6. [Accessibilité WCAG 2.2 AA](#6-accessibilité-wcag-22-aa)
7. [Performance perçue](#7-performance-perçue)
8. [Réglages](#8-réglages)
9. [Checklist d'implémentation priorisée](#9-checklist-dimplémentation-priorisée)
10. [Décisions à consigner (ADR) et questions](#10-décisions-à-consigner-adr-et-questions)
11. [Écarts avec UX.md et VISUAL.md](#11-écarts-avec-uxmd-et-visualmd)

---

## 0. Décisions en une page

| Sujet | Décision | Raison décisive |
| --- | --- | --- |
| Éditeur de code | **CodeMirror 6**, monté avec un nonce CSP (ou dans un Shadow DOM) | Fonctionne sous `style-src 'self'` + nonce ; Monaco exige `'unsafe-inline'` (ticket ouvert depuis 2016) ; ~10× plus léger ; thème par variables CSS `--nv-*` ; `@codemirror/merge` fournit accepter/rejeter par bloc ; client LSP officiel |
| Disposition du plan de travail | **dockview** (React, MIT) pour onglets, groupes, glisser-déposer, sérialisation ; **react-resizable-panels** reste la coque à trois zones | Déjà en place pour la coque ; dockview apporte le dock/tabs sans réinventer ; sérialisation JSON par espace de travail |
| Terminal | **xterm.js** + **`@xterm/addon-webgl`** obligatoire ; PTY `node-pty` dans un `utilityProcess` | Le rendu DOM de xterm injecte des `<style>` sans nonce (bloqué par la CSP) ; WebGL dessine sur canvas. `node-pty` est le seul module natif : exception explicite à l'ADR-002 |
| Une touche pour « agir ici » | `Ctrl+K` = palette hors éditeur et terminal ; = modification en ligne dans l'éditeur ; = génération de commande dans le terminal. `Ctrl+Maj+P` et `F1` ouvrent toujours la palette | Compatible avec le J1 livré et ses tests ; convention Cursor dans l'éditeur ; une seule règle à apprendre |
| Accords (chords) | **Aucun accord chronométré** dans le profil NOVA ; les « suites » vivent dans la palette (préfixes) ; le profil VS Code réactive les accords `Ctrl+K …` | Un accord en attente n'est jamais annoncé au lecteur d'écran et casse les IME ; la palette est déjà la surface universelle |
| Dispositions clavier | Lettres et signes reconnus par le **caractère** (`key`), chiffres par la **position** (`code`) ; **jamais `Ctrl+Alt+…` dans les défauts** (AltGr sur AZERTY) ; libellés via `navigator.keyboard.getLayoutMap()` | Public francophone : AZERTY majoritaire |
| Profils de clavier | NOVA (défaut), VS Code, Vim (`@replit/codemirror-vim`), Emacs (`@replit/codemirror-emacs`) ; surcharge JSON par l'utilisateur | Les profils remplacent les réglages fins ; l'export JSON reste pour les cas rares |
| Streaming | Fusion des fragments toutes les 50 ms max, Markdown rendu par blocs mémorisés ; annonces lecteur d'écran à la fin seulement (livré) + mode optionnel « lire au fil de l'eau » par phrases | Le rendu actuel ré-analyse tout le Markdown à chaque fragment (O(n²) sur une longue réponse) |
| Performance | Budgets chiffrés (section 7) mesurés par une spec Playwright `perf.spec.ts` ; porte CI relative à une base versionnée (+25 % = échec sur Linux, informatif ailleurs) | ADR-001 : budgets fixés après première mesure, sur la machine de référence |
| Accessibilité | Un service `Announcer` unique ; modes lecteur d'écran pour éditeur, terminal et diff ; thèmes contraste élevé + `forced-colors` ; zoom `Ctrl+=`/`Ctrl+−`/`Ctrl+0` ; scripts manuels NVDA/VoiceOver/Orca ; Guidepup en option | Scénario 15 est « partiel » : lecteur d'écran jamais passé |
| Réglages | Registre unique (zod + métadonnées) → interface, recherche, JSON expert (CM6 + schéma JSON dérivé de zod 4), export/import ; portée `user`/`workspace`/`machine` prête pour une synchronisation | Une source de vérité, pas trois |

---

## 1. Ce qui existe et ce qui contraint

Relevé du code, pas des intentions.

### 1.1 Livré (J1)

| Élément | Où | Ce qu'il impose à la suite |
| --- | --- | --- |
| Raccourcis globaux `Ctrl+K` (palette), `Ctrl+N`, `Ctrl+,` | `renderer/App.tsx` (`useGlobalShortcuts`) : `keydown` sur `window`, ignore `altKey`/`shiftKey`, accepte `ctrlKey` **ou** `metaKey` partout | Base saine (AltGr ignoré). À remplacer par un résolveur de keymap, pas par une liste de `if` |
| Palette | `components/palette/CommandPalette.tsx` : cmdk, deux pages (`commands`, `conversations`), `vimBindings={false}`, `loop`, Retour arrière sur champ vide = page précédente, recherche des conversations dans le main (150 ms) | Le patron « page d'arguments » existe déjà ; la liste des commandes est codée en dur : à remplacer par un registre |
| Dialogues | `packages/ui/src/components/Dialog.tsx` : `<dialog>` natif (`showModal`), piège de focus et arrière-plan inerte par la plateforme, retour du focus à l'ouvreur ou à un repli (`returnFocus`) | Réutiliser tel quel pour la palette, l'ouverture rapide, l'aide clavier |
| Coque à trois zones | `components/layout/Workshop.tsx` : `react-resizable-panels` v4 (`Group`/`Panel`/`Separator`), séparateurs focalisables, < 900 px : tiroir + surcouche | Garder pour la coque ; le dock à onglets vient en plus (section 3.3) |
| Annonces | `App.tsx` `OutcomeAnnouncer` : `<output aria-live="polite">`, un nœud par résultat, jamais les fragments ; `ErrorBlock` sans `role="alert"` | Généraliser en service `Announcer` (section 6.3) |
| Mouvement réduit | `packages/ui/src/styles/base.css` : `prefers-reduced-motion` sauf `data-motion="full"`, `data-motion="reduce"` force | Éditeur, terminal, dock et flux doivent respecter le même attribut |
| Thème | `data-theme` sur `<html>`, tokens `--nv-*` (`packages/ui/src/styles/tokens.css`), `index.html` fixe `data-theme="dark"`, fenêtre `backgroundColor: "#111619"` | Un thème clair enregistré provoque un flash sombre avant que React n'applique le clair (section 7.2) |
| CSP | `main/renderer-assets.ts` : `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'` ; `assetsInlineLimit: 0` ; pas d'`unsafe-inline` hors `pnpm dev` | **Contrainte structurante** : toute bibliothèque qui injecte `<style>` avec du texte est bloquée. Les styles posés par CSSOM (`element.style.x = …`, `sheet.insertRule`) passent ; le `style` de React aussi. Il faut un mécanisme de nonce (section 3.2) |
| Renderer sandboxé | `contextIsolation`, `sandbox`, preload CJS minimal, `window.novaBridge` fixe, IPC zod | Pas d'accès fichier, pas de `Worker` depuis `blob:` (`script-src 'self'`) ; les workers doivent être des fichiers émis par Vite |
| Streaming | `state/chat-reducer.ts` : chaque `delta` concatène et déclenche un rendu ; `MessageItem` → `Markdown` (`react-markdown` + `remark-gfm`) re-parse tout le texte | Coût quadratique sur une réponse longue (section 7.5) |
| Défilement suiveur | `ChatView.tsx` `MessageList` : `ResizeObserver` + seuil 64 px, bouton « aller en bas » | Même logique à réutiliser pour « suivre l'agent » (section 4.3) |
| Horloges | `NomiDock.tsx` `useNow(1000)` : réveil du renderer chaque seconde, même au repos | À rendre conditionnel à la fenêtre de 4 s d'un résultat (section 7.8) |
| Tests a11y | `e2e/ui-journey.spec.ts` scénario 15 : axe (mode legacy, violations `serious`/`critical`), `Ctrl+K`, `Ctrl+N`, anneau de focus du composer | Base pour la porte a11y (section 6.8) |
| Composer | `Composer.tsx` : `Entrée` envoie, `Maj+Entrée` retour à la ligne, `Échap` arrête, `field-sizing: content`, anneau sur le conteneur | Conserver ; `↑` sur champ vide = rappeler le dernier message (section 2.2) |

### 1.2 Contraintes de plateforme (ADR-001, ADR-005, ADR-007)

- Electron 44 (Chromium 152, Node 24) : `navigator.keyboard.getLayoutMap()`, `field-sizing`, `adoptedStyleSheets`, WebGL2, `PerformanceEventTiming` sont disponibles.
- Plateforme de référence Linux x64, CI Windows et macOS : les raccourcis sont testés sur les trois, avec Xvfb sous Linux.
- Preload sandboxé : `webFrame` y est disponible (sous-ensemble), mais le zoom passera par le main (`webContents.setZoomFactor`) pour rester persisté et validé.
- Menu d'application : sous macOS, `⌘C`/`⌘V`/`⌘Q` n'existent que si un menu avec les rôles `editMenu`/`appMenu`/`windowMenu` est défini. Sous Windows et Linux, aucun menu (`autoHideMenuBar`, `Menu.setApplicationMenu(null)`) : `Alt` seul ne vole pas le focus.

---

## 2. Système clavier d'abord

### 2.1 Principes

1. **Une règle, trois contextes.** `Ctrl+K` signifie « commander NOVA ici » : dans la conversation, l'accueil et les réglages, il ouvre la palette (livré) ; dans un éditeur, il ouvre la modification en ligne sur la sélection ; dans un terminal, il ouvre la génération de commande. `Ctrl+Maj+P` et `F1` ouvrent la palette partout, sans exception, et l'aide en ligne le rappelle dans les deux autres contextes.
2. **Pas d'accord chronométré.** Un accord (`Ctrl+K` puis `Ctrl+S`) crée un état invisible : rien n'est annoncé au lecteur d'écran, un IME peut l'avaler, et un utilisateur AZERTY ne sait pas si `Ctrl+K` a « pris ». Les suites de touches existent seulement (a) dans la palette, sous forme de préfixes et de pages d'arguments, (b) dans le profil Vim (grammaire native), (c) dans le profil VS Code, pour qui les accepte explicitement.
3. **AZERTY d'abord.** Sous Windows et Linux, `AltGr` = `Ctrl+Alt`. `@`, `[`, `]`, `{`, `}`, `\`, `|`, `#`, `~`, `` ` ``, `€` s'obtiennent avec `AltGr` sur AZERTY : **aucun raccourci par défaut n'utilise `Ctrl+Alt`**, ni ne cible ces caractères. Les chiffres demandent `Maj` sur AZERTY : les raccourcis `Ctrl+1…9` sont reconnus par position (`code`), pas par caractère. `` Ctrl+` `` (touche morte `AltGr+7`) est banni ; il est remplacé par `Ctrl+J`.
4. **Résolution mixte `key`/`code`.** Lettres et signes sont reconnus par `event.key` (ce que l'utilisateur voit sur la touche) ; les chiffres, `Espace`, les flèches, `Entrée`, `Échap`, `Tab`, les touches de fonction par `event.code`. Les libellés affichés (`Kbd`) sont dérivés de `navigator.keyboard.getLayoutMap()` et rafraîchis au changement de disposition. CodeMirror applique la même double correspondance pour ses propres keymaps.
5. **Le composant focalisé possède ses touches.** L'éditeur possède `Tab`, `Ctrl+D`, `Ctrl+F`… ; le terminal possède tout sauf une liste courte de touches globales qui traversent (`commandsToSkipShell`, section 5.5). Les touches simples (`j`, `k`, `a`, `r`) n'existent qu'en mode révision ou dans une liste focalisée, jamais globalement (WCAG 2.1.4).
6. **Tout raccourci a un nom et un libellé.** Chaque commande du registre porte son titre français ; le libellé de touche est généré, jamais écrit à la main dans la microcopie. Les boutons exposent `aria-keyshortcuts` (déjà fait pour « Nouvelle conversation ») et `title` avec le raccourci.
7. **Un raccourci qui ne peut rien faire le dit.** Une commande indisponible n'est pas silencieuse : soit elle est absente du contexte (`when` faux), soit elle est visible et désactivée avec sa raison (`enabled` faux), comme `blocked.reason` du composer.
8. **Argent et fichiers : jamais par une seule touche.** Relancer une génération, relancer une mission depuis une étape, approuver une commande dangereuse, restaurer un point de reprise passent par une confirmation ou un bouton nommé focalisé, jamais par une touche simple.

### 2.2 Carte des raccourcis par défaut (profil NOVA)

Colonnes : action · Windows/Linux · macOS · contexte (`when`) · identifiant de commande. Les commandes marquées J2/J3 n'existent qu'à partir de ce jalon ; les autres se branchent sur le J1 livré.

#### Global

| Action | Win/Linux | macOS | Contexte | Commande |
| --- | --- | --- | --- | --- |
| Palette de commandes | `Ctrl+K` | `⌘K` | `!editorFocus && !terminalFocus` | `palette.open` |
| Palette de commandes (toujours) | `Ctrl+Maj+P`, `F1` | `⇧⌘P`, `F1` | — | `palette.open` |
| Ouverture rapide (fichiers, conversations, missions, récents) | `Ctrl+P` | `⌘P` | — | `quickOpen.open` |
| Nouvelle conversation | `Ctrl+N` | `⌘N` | — | `conversation.new` (livré) |
| Réglages | `Ctrl+,` | `⌘,` | — | `settings.open` (livré) |
| Rechercher dans les réglages | `Ctrl+,` puis saisie | `⌘,` puis saisie | `route == settings` | `settings.search` |
| Arrêter la génération ou la mission en cours | `Maj+Échap` | `⇧Échap` | `streaming \|\| missionRunning` | `run.stop` (confirmation si mission, cf. UX.md 10.1) |
| Basculer Créer / Expert | `Ctrl+Maj+E` | `⇧⌘E` | — | `view.toggleExpert` (UX.md 6.2) |
| Basculer la disposition converse ↔ build | `Ctrl+Maj+D` | `⇧⌘D` | `workspaceOpen` | `layout.toggleMode` (J2) |
| Zoom + / − / réinitialiser | `Ctrl+=` (`Ctrl++`), `Ctrl+−`, `Ctrl+0` | `⌘=`, `⌘−`, `⌘0` | — | `view.zoomIn` / `view.zoomOut` / `view.zoomReset` |
| Plein écran | `F11` | `⌃⌘F` | — | `window.toggleFullScreen` |
| Aide clavier (liste des raccourcis du contexte) | `Alt+F1`, ou `F1` puis `?` | `⌥F1` | — | `help.keyboard` (pas de `Ctrl+Maj+/` : `/` demande `Maj` sur AZERTY) |
| Basculer le mode « Tab déplace le focus » | `Ctrl+M` | `⌃⇧M` | `editorFocus \|\| terminalFocus` | `a11y.toggleTabFocus` |
| Appui pour parler (J4) | `Ctrl+Espace` maintenu | `⌃Espace` maintenu | `!editorFocus && !terminalFocus` | `voice.pushToTalk` (UX-5) |

`Alt+F1` : sous Windows et Linux sans menu, libre ; sous GNOME, `Alt+F1` ouvre le menu Activités sur certaines configurations — la palette (`F1` puis `?`) reste la voie garantie.

#### Zones et focus

| Action | Win/Linux | macOS | Contexte | Commande |
| --- | --- | --- | --- | --- |
| Zone suivante / précédente (navigation → plan de travail → dock → panneau droit → composer) | `F6` / `Maj+F6` | `F6` / `⇧F6` | — | `focus.nextZone` / `focus.previousZone` |
| Navigation : afficher, focaliser, masquer (cyclique) | `Ctrl+B` | `⌘B` | — | `nav.toggle` |
| Panneau droit (Contexte en J1, Agent en J2) : afficher, focaliser, masquer | `Ctrl+Maj+B` | `⇧⌘B` | — | `sidePanel.toggle` |
| Dock (terminal, problèmes, tests, ports) : afficher, focaliser, masquer | `Ctrl+J` | `⌘J` | `workspaceOpen` | `dock.toggle` (J2) |
| Conversation : focaliser le composer (avec la sélection de l'éditeur comme contexte) | `Ctrl+L` | `⌘L` | — | `conversation.focusComposer` |
| Mission / agent : ouvrir le panneau Agent | `Ctrl+I` | `⌘I` | `workspaceOpen` | `mission.focus` (J2) |
| Chronologie de la mission | `Ctrl+Maj+I` | `⇧⌘I` | `missionExists` | `mission.timeline` (J2) |
| Approbation en attente : y aller | `Ctrl+Maj+A` | `⇧⌘A` | `approvalPending` | `approval.focus` (J2) |
| Panneaux nommés : 1 Éditeur · 2 Changements · 3 Terminal · 4 Aperçu · 5 Preuves · 6 Fichiers · 7 Missions · 8 Contexte · 9 Conversation | `Ctrl+[Digit1…9]` | `⌃[Digit1…9]` | — | `panel.goTo` (argument `n`) |
| Onglet n du groupe actif | `Alt+[Digit1…9]` | `⌘[Digit1…9]` | `tabsFocusable` | `tabs.goTo` |
| Onglet suivant / précédent (récence) | `Ctrl+Tab` / `Ctrl+Maj+Tab` | `⌃Tab` / `⌃⇧Tab` | — | `tabs.nextRecent` / `tabs.previousRecent` |
| Onglet suivant / précédent (ordre) | `Ctrl+PageDown` / `Ctrl+PageUp` | `⌥⌘→` / `⌥⌘←` | — | `tabs.next` / `tabs.previous` |
| Fermer l'onglet | `Ctrl+W` | `⌘W` | `tabsFocusable` | `tabs.close` (jamais la fenêtre ; `⇧⌘W` ferme la fenêtre sous macOS) |
| Rouvrir l'onglet fermé | `Ctrl+Maj+T` | `⇧⌘T` | — | `tabs.reopen` |
| Diviser le groupe (menu « Diviser » : droite, bas) | `Ctrl+Maj+Entrée` avec une sélection ou un onglet focalisé | `⇧⌘Entrée` | `editorFocus \|\| tabsFocusable` | `layout.split` (argument : direction ; pas de `Ctrl+\` : `\` est `AltGr+8` sur AZERTY) |
| Déplacer l'onglet vers un groupe (alternative clavier au glisser-déposer) | palette « Déplacer l'onglet vers… » | idem | `tabsFocusable` | `tabs.moveTo` (WCAG 2.5.7) |
| Redimensionner un séparateur | `Tab` sur la poignée, `←→` 16 px, `Maj+←→` 64 px, `Début`/`Fin` | idem | poignée focalisée | natif `react-resizable-panels` (livré) |

Les panneaux nommés ont un numéro **stable** quelle que soit la disposition : `Ctrl+3` ouvre et focalise le terminal même si le dock est replié. C'est ce qui rend la carte mémorisable au clavier seul. Sous macOS, on garde `⌃` (Control) pour ces neuf panneaux parce que `⌘1…9` est la convention des onglets (Safari, Chrome, Terminal.app) ; sous Windows et Linux, `Alt+1…9` est la convention des onglets (navigateurs, Warp) et ne rencontre aucun menu puisque NOVA n'en a pas.

#### Conversation

| Action | Win/Linux | macOS | Contexte | Commande |
| --- | --- | --- | --- | --- |
| Envoyer / nouvelle ligne / arrêter | `Entrée` / `Maj+Entrée` / `Échap` | idem | `composerFocus` | livré |
| Rappeler le dernier message envoyé dans le composer vide | `↑` | `↑` | `composerFocus && composerEmpty` | `composer.recallPrevious` (puis `↑`/`↓` dans l'historique des envois de la conversation) |
| Réessayer / relancer la dernière réponse | `Ctrl+R` | `⌘R` | `route == chat && !streaming && lastAnswerRetryable` | `conversation.retryLast` (action utilisateur explicite, ADR-011) |
| Changer de modèle | `Ctrl+Maj+M` | `⇧⌘M` | — | `model.pick` (livré via palette) |
| Copier la dernière réponse | `Ctrl+Maj+C` | `⇧⌘C` | `route == chat && !terminalFocus` | `conversation.copyLastAnswer` |
| Renommer la conversation | `F2` | `F2` | `route == chat && !editorFocus` | `conversation.rename` (livré, bouton) |
| Aller au message précédent / suivant | `↑` / `↓`, `j` / `k` | idem | `messagesFocus` (liste focalisée via `F6`) | `messages.previous` / `messages.next` |
| Dans un message : copier, réessayer, modifier et renvoyer (J2), bloc de code suivant | `c`, `r`, `e`, `n` | idem | `messagesFocus` | `message.*` |
| Aller en bas et reprendre le suivi | `Fin` | `Fin` | `messagesFocus` | livré (bouton) |

#### Palette et ouverture rapide

| Touche | Effet |
| --- | --- |
| `↑` `↓`, `Ctrl+N` `Ctrl+P` (profils Vim/Emacs : `vimBindings` de cmdk) | Déplacer la sélection |
| `Entrée` | Exécuter ; si la commande a des arguments, ouvrir la page d'arguments |
| `Ctrl+Entrée` | Exécuter sans fermer (commandes répétables : « Panneau suivant », changement de thème) |
| `Tab` | Compléter le préfixe ou basculer la portée (fichier ↔ espace de travail pour les symboles) |
| `Retour arrière` sur champ vide | Page précédente (livré) |
| `Échap` | Fermer, focus rendu à l'ouvreur (livré, `Dialog`) |
| `>` `@` `#` `/` `:` `.` `,` `?` | Préfixes (section 2.4.5) |

#### Éditeur (CodeMirror 6, par-dessus `defaultKeymap`, `searchKeymap`, `historyKeymap`, `foldKeymap`, `completionKeymap`, `lintKeymap`)

| Action | Win/Linux | macOS | Commande |
| --- | --- | --- | --- |
| Modification en ligne par l'agent | `Ctrl+K` | `⌘K` | `agent.inlineEdit` (section 4.1) |
| Ajouter la sélection à la conversation | `Ctrl+L` | `⌘L` | `conversation.focusComposer` |
| Enregistrer maintenant (enregistrement automatique après 1 s par défaut) | `Ctrl+S` | `⌘S` | `file.save` |
| Tout enregistrer | `Ctrl+Maj+S` | `⇧⌘S` | `file.saveAll` |
| Chercher / remplacer | `Ctrl+F` / `Ctrl+H` | `⌘F` / `⌥⌘F` | CM6 `searchKeymap` |
| Chercher / remplacer dans les fichiers | `Ctrl+Maj+F` / `Ctrl+Maj+H` | `⇧⌘F` / `⇧⌘H` | `search.workspace` (J2) |
| Aller à la ligne | `Ctrl+G` | `⌃G` | `editor.gotoLine` (palette `:`) |
| Symbole du fichier / de l'espace | `Ctrl+Maj+O` / `Ctrl+T` | `⇧⌘O` / `⌘T` | `quickOpen.symbols` (palette `.`) |
| Définition / références / aperçu | `F12` / `Maj+F12` / `Ctrl+F12` | idem | LSP |
| Renommer le symbole | `F2` | `F2` | LSP |
| Actions rapides | `Ctrl+.` | `⌘.` | LSP / lint |
| Complétion / aide de signature | `Ctrl+Espace` / `Ctrl+Maj+Espace` | `⌃Espace` / `⇧⌘Espace` | CM6 (conflit connu : `Ctrl+Espace` peut être pris par ibus sous Linux ; la palette « Compléter » et `Ctrl+Maj+Espace` restent) |
| Occurrence suivante / toutes les occurrences | `Ctrl+D` / `Ctrl+Maj+L` | `⌘D` / `⇧⌘L` | CM6 `selectNextOccurrence` / `selectSelectionMatches` |
| Curseur au-dessus / en dessous | `Maj+Alt+↑` / `Maj+Alt+↓` | `⌥⌘↑` / `⌥⌘↓` | `editor.addCursor` (jamais `Ctrl+Alt+↑↓` : GNOME change d'espace de travail) |
| Déplacer la ligne | `Alt+↑` / `Alt+↓` | `⌥↑` / `⌥↓` | CM6 `moveLineUp` / `moveLineDown` |
| Dupliquer la ligne | `Ctrl+Maj+Entrée` sans sélection (voir note) ou palette | `⇧⌘Entrée` sans sélection | `editor.duplicateLine` |
| Supprimer la ligne | `Ctrl+Maj+K` | `⇧⌘K` | CM6 `deleteLine` |
| Commenter | `Ctrl+/` (sur AZERTY : `Ctrl+Maj+:` produit `/`, reconnu) | `⌘/` | CM6 `toggleComment` |
| Plier / déplier | `Ctrl+Maj+[` / `]` (défaut CM6, AltGr sur AZERTY) **et** `Ctrl+Maj+,` / `Ctrl+Maj+.` (ajout NOVA) | `⌥⌘[` / `]` | `foldCode` / `unfoldCode` |
| Formater le document | `Maj+Alt+F` | `⇧⌥F` | LSP / formateur |
| Sortir de l'éditeur au clavier | `Échap` puis `Tab`, ou `Ctrl+M` puis `Tab` | idem | WCAG 2.1.2 |

Note sur la duplication de ligne : `Maj+Alt+↑↓` est réservé aux curseurs multiples (VS Code sous Linux les met sur `Ctrl+Maj+Alt+↑↓`, impossible ici à cause d'AltGr) et `Ctrl+Maj+D` est pris par la bascule de disposition. Dupliquer la ligne est donc disponible par la palette et par `Ctrl+Maj+Entrée` **quand la sélection est vide** ; avec une sélection, la même touche ouvre le menu « Diviser ». Ce compromis est consigné comme décision (PX-5, section 10).

#### Revue et diff (mode révision : vue non éditable, touches simples autorisées par WCAG 2.1.4 car actives seulement quand la vue a le focus)

| Action | Touches | Aussi (depuis l'éditeur en aperçu inline) |
| --- | --- | --- |
| Bloc suivant / précédent | `j` / `k`, `n` / `p`, `↓` / `↑` | `F7` / `Maj+F7` |
| Fichier suivant / précédent | `J` / `K` (Maj) | `Ctrl+F7` / `Ctrl+Maj+F7` |
| Garder (accepter) le bloc | `a`, `Entrée` sur le bouton | `Ctrl+Entrée` |
| Restaurer (rejeter) le bloc | `r` | `Ctrl+Retour` |
| Garder tout le fichier / tout restaurer | `A` / `R` (confirmation pour `R`) | `Ctrl+Maj+Entrée` / palette |
| Ouvrir le fichier à cette ligne | `o` | — |
| Côte à côte ↔ unifié | `u` | — |
| Mode lecture (phrases, lecteur d'écran) | `l` | — |
| Résumé du fichier avant le détail | `s` | — |
| Quitter la revue | `Échap` | `Échap` (rejette **rien** : demande « Garder les blocs acceptés et abandonner le reste ? » si des blocs sont en attente) |

Les touches `j`/`k`/`a`/`r`/`o` sont celles d'UX.md 10.1 ; `n`/`p`, `u`, `l`, `s` s'ajoutent. `[`/`]` sont exclus (AltGr).

#### Agent, mission, chronologie (J2–J3)

| Action | Win/Linux | macOS | Contexte | Commande |
| --- | --- | --- | --- | --- |
| Lancer la mission depuis le plan | `Ctrl+Entrée` | `⌘Entrée` | `route == plan` | `mission.launch` (UX.md 10.1) |
| Suivre l'agent (bascule) | `F9` | `F9` | `missionRunning` | `agent.follow` |
| Reprendre le suivi après l'avoir rompu | `F9` | `F9` | `followSuspended` | idem |
| Chronologie : étape précédente / suivante | `↑` / `↓`, `k` / `j` | idem | `timelineFocus` | `timeline.previous` / `timeline.next` |
| Chronologie : première / dernière étape, étape en cours | `Début` / `Fin` / `.` (`Espace` reste l'activation du bouton focalisé) | idem | `timelineFocus` | `timeline.first` / `timeline.last` / `timeline.current` |
| Détail de l'étape | `Entrée` | `Entrée` | `timelineFocus` | `timeline.open` |
| Diff à cette étape / fichiers touchés / sortie terminal | `d` / `f` / `t` | idem | `timelineFocus` | `timeline.diffAt` / `filesAt` / `outputAt` |
| Relancer depuis cette étape | `r` puis dialogue de confirmation avec coût estimé | idem | `timelineFocus && stepRerunnable` | `mission.rerunFrom` |
| Copier l'étape (texte) | `c` | `c` | `timelineFocus` | `timeline.copy` |
| Approuver la carte focalisée | `Entrée` sur « Autoriser », ou `Ctrl+Entrée` | idem | `approvalFocus` | `approval.approve` |
| Refuser | `Entrée` sur « Refuser », ou `Échap` (UX.md 10.1) | idem | `approvalFocus` | `approval.deny` |

#### Terminal (quand il a le focus ; tout le reste va au shell)

| Action | Win/Linux | macOS | Commande |
| --- | --- | --- | --- |
| Générer une commande avec l'agent (insérée, jamais exécutée) | `Ctrl+K` | `⌘K` | `terminal.generateCommand` |
| Expliquer la dernière commande échouée | `Ctrl+Maj+X` | `⇧⌘X` | `terminal.explainFailure` |
| Nouveau terminal / fermer la session | `Ctrl+Maj+J` / `Ctrl+Maj+W` (`Ctrl+W` va au shell) | `⇧⌘J` / `⌘W` (`⇧⌘W` reste « fermer la fenêtre » sous macOS) | `terminal.new` / `terminal.close` |
| Copier / coller | `Ctrl+Maj+C` / `Ctrl+Maj+V` (et `Ctrl+C` copie **si** une sélection existe, sinon SIGINT) | `⌘C` / `⌘V` | `terminal.copy` / `terminal.paste` |
| Chercher | `Ctrl+F` | `⌘F` | `terminal.find` (addon search) |
| Commande précédente / suivante (blocs) | `Ctrl+↑` / `Ctrl+↓` | `⌘↑` / `⌘↓` | `terminal.previousCommand` / `nextCommand` |
| Sélectionner la sortie de la commande | `Ctrl+Maj+↑` / `Ctrl+Maj+↓` | `⇧⌘↑` / `⇧⌘↓` | `terminal.selectOutput` |
| Commandes récentes (sélecteur) | `Ctrl+Maj+R` | `⇧⌘R` | `terminal.recentCommands` |
| Effacer | commande `clear` ou palette | idem | `terminal.clear` |
| Sortir du terminal | `F6`, `Ctrl+L` (vers le composer), `Ctrl+M` puis `Tab` | idem | annoncé à l'entrée : « Terminal. F6 pour sortir. » |
| Lire les 10 dernières lignes (lecteur d'écran) | `Alt+L` | `⌥L` | `terminal.readTail` (`Ctrl+Maj+L` reste « toutes les occurrences » dans l'éditeur) |

`Ctrl+K` dans un shell readline supprime jusqu'à la fin de ligne. Les habitués le retrouvent en profil VS Code (où `Ctrl+K` traverse vers le shell) ou en réaffectant `terminal.generateCommand` dans leur JSON ; le profil NOVA garde la règle « une touche pour agir ici ».

### 2.3 Accords (chords)

- **Profil NOVA** : aucun accord chronométré. Les « suites » sont des préfixes de palette ou des pages d'arguments. `Ctrl+K` n'est jamais un préfixe.
- **Profil VS Code** : `Ctrl+K` redevient préfixe (`Ctrl+K Ctrl+S` raccourcis, `Ctrl+K Ctrl+T` thème, `Ctrl+K Z` zen, `Ctrl+K Ctrl+W` tout fermer) ; la modification en ligne passe sur `Ctrl+I` comme dans VS Code ; le panneau Agent sur `Ctrl+Maj+I`. L'état « accord en attente » est affiché dans la barre d'état et annoncé (`Announcer.polite("Ctrl+K en attente")`), avec expiration à 3 s **sans** action.
- Le résolveur de keymap gère les accords génériquement (`keys: ["Ctrl+K", "Ctrl+S"]`) : un seul moteur, deux profils.

### 2.4 Architecture de la palette de commandes

#### 2.4.1 Registre de commandes (`renderer/commands/registry.ts`)

```ts
export type CommandCategory =
  | "app" | "conversation" | "model" | "settings" | "view" | "layout" | "focus"
  | "file" | "editor" | "search" | "review" | "mission" | "approval" | "terminal" | "a11y" | "help";

export interface CommandDefinition<Args = void> {
  /** `categorie.action`, unique, stable : sert de clé pour les keybindings et les récents. */
  id: `${CommandCategory}.${string}`;
  title: string;                 // français, verbe d'action, depuis copy/fr.ts
  category: CommandCategory;
  keywords?: readonly string[];  // synonymes (« thème », « sombre », « dark »)
  icon?: IconName;
  /** Absent du contexte quand faux. */
  when?: (ctx: CommandContext) => boolean;
  /** Visible mais désactivée avec sa raison quand faux : jamais un no-op silencieux. */
  enabled?: (ctx: CommandContext) => { ok: true } | { ok: false; reason: string };
  /** Commande à arguments : la palette ouvre une page pour les saisir. */
  args?: { schema: ZodType<Args>; page: (ctx: CommandContext) => ArgumentPage<Args> };
  /** « paid » : confirmation avec coût estimé avant exécution (ADR-006, UX.md 7.5). */
  cost?: "free" | "paid";
  run: (args: Args, ctx: CommandContext) => void | Promise<void>;
}
```

- Les commandes sont enregistrées par module (`commands/builtin/app.ts`, `conversation.ts`, `editor.ts`, `terminal.ts`, `mission.ts`, `layout.ts`, `a11y.ts`) au démarrage ; un plugin/extension (J3) ne peut enregistrer que par le même type, avec un préfixe d'identifiant imposé.
- `CommandContext` est un sélecteur pur sur le store zustand plus l'état de focus (`focus: "nav" | "chat" | "composer" | "messages" | "editor" | "terminal" | "diff" | "timeline" | "approval" | "sidePanel" | "palette" | "none"`), recalculé sur `focusin` et à chaque mise à jour du store. Testable sans DOM.
- Le registre expose `list(ctx)`, `get(id)`, `run(id, args?)`, et publie `commands.changed` pour la palette et le menu.
- Tests : chaque commande enregistrée a un titre non vide, un identifiant conforme, et `run` ne lève jamais vers l'appelant (les erreurs vont au toast, comme aujourd'hui `errorToast`).

#### 2.4.2 Résolveur de raccourcis (`renderer/keymap/`)

```ts
interface Keybinding { keys: readonly string[]; command: CommandId; when?: string; args?: unknown }
```

- `profiles/nova.ts`, `profiles/vscode.ts`, `profiles/vim.ts`, `profiles/emacs.ts` : listes de `Keybinding` ; `mac` variante par entrée quand elle diffère.
- `when` est une mini-grammaire de chaînes (`editorFocus && !streaming`, `route == chat`, `focus == timeline`) — ~60 lignes de parseur, testées ; nécessaire parce que les surcharges utilisateur sont du JSON.
- `resolve.ts` : `keydown` capturé sur `window` (phase de capture, pour passer avant cmdk et CodeMirror **uniquement** pour la liste globale ; le reste en phase de bulle) → normalisation `{ mod, shift, alt, key, code }` → recherche dans la table `chord → bindings[]` → première dont `when` est vrai → `registry.run`. Ignore les événements avec `isComposing`, et `Ctrl+Alt` ensemble (AltGr) sauf binding explicite.
- Priorité : surcharge utilisateur > profil > défauts ; une entrée `{ "keys": ["Ctrl+K"], "command": "-agent.inlineEdit" }` retire une liaison (syntaxe VS Code).
- `format.ts` : libellé d'affichage (`⌘K`, `Ctrl+K`, `Maj+Entrée`) via `getLayoutMap()` ; utilisé par `Kbd`, `aria-keyshortcuts` (`"Control+K Meta+K"`), le menu macOS et la section Raccourcis des réglages (qui devient générée et consultable par recherche, avec réaffectation en place).
- Remplace `useGlobalShortcuts` de `App.tsx` (qui garde son test E2E : `Ctrl+K` → palette, `Ctrl+N` → composer).

#### 2.4.3 Recherche floue, tri, récents

- Filtre : `command-score` de cmdk (déjà là) sur `title + keywords + category`, insensible aux accents (normalisation NFD dans un champ `searchText` précalculé).
- Tri final = score × (1 + bonus récence) × (1 + bonus contexte) : les 20 dernières commandes exécutées (MRU, dans la table `settings` sous la clé `ui.palette.recent`, portée `machine`) remontent ; une commande de la catégorie du focus courant remonte légèrement.
- Champ vide : groupe « Récentes » (5), puis « Suggestions du contexte » (ex. « Arrêter » pendant un flux, déjà fait ; « Garder tout » en revue), puis catégories.
- Jamais de vide : sans résultat, l'item « Demander à Nomi : “<requête>” » envoie la requête au composer (VISUAL.md 4.9) ; c'est une commande `conversation.askFromPalette`.

#### 2.4.4 Arguments

Généralisation de la page `conversations` existante : `ArgumentPage<Args>` est soit `{ kind: "list", search: (q) => Promise<Item[]>, delay }` (conversations, fichiers, modèles, étapes de mission, groupes de dock), soit `{ kind: "text", label, validate }` (« Aller à la ligne », « Renommer »), soit `{ kind: "confirm", title, cost? }`. La page se branche sur le même `Command` cmdk avec `shouldFilter={false}` et délègue la recherche (au main pour les fichiers et conversations, au worker pour les symboles).

#### 2.4.5 Préfixes (« aller à n'importe quoi »)

Une seule boîte (`CommandPalette`), deux points d'entrée : `Ctrl+K`/`Ctrl+Maj+P` ouvrent en mode commandes (`>` implicite), `Ctrl+P` ouvre en mode « tout » (sans préfixe). Le préfixe se tape ou se choisit dans le pied (VISUAL.md 4.9).

| Préfixe | Portée | Source |
| --- | --- | --- |
| *(aucun)* | Fichiers du projet, conversations, missions, commandes récentes, mélangés | main (`conversations.list`, `workspace.files`), MRU |
| `>` | Commandes | registre |
| `@` | Fichiers du projet (UX.md 4.5) | index de fichiers en worker (section 7.7) |
| `#` | Missions (UX.md 4.5) | main |
| `/` | Modes de travail (UX.md 4.4) | registre |
| `:` | Aller à la ligne (`:42`, `:42:7`) | éditeur |
| `.` | Symboles du fichier courant ; `Tab` bascule vers l'espace de travail | LSP `documentSymbol` / `workspace/symbol` |
| `,` | Réglages (recherche dans le registre des réglages) | section 8 |
| `?` | Aide : raccourcis du contexte, préfixes | registre + keymap |

`@` et `#` gardent le sens fixé par UX.md (fichiers, missions) plutôt que celui de VS Code (symboles) : la cohérence interne prime ; les symboles ont `.` et deux raccourcis directs (`Ctrl+Maj+O`, `Ctrl+T`).

### 2.5 Ouverture rapide : fichiers, symboles

- **Index de fichiers** : le main énumère l'espace de travail (respect de `.gitignore` et d'une liste d'exclusions par défaut : `node_modules`, `.git`, `dist`, `out`, `target`, `.venv`), envoie la liste en une fois (chemins relatifs, ≤ 200 000 entrées, sinon tronqué et signalé), puis des deltas par `fs.watch` (dans un `utilityProcess`, avec `debounce` 200 ms). Le renderer garde l'index dans un **Web Worker** (`workers/file-index.worker.ts`, émis par Vite comme fichier — pas de `blob:`), qui répond aux requêtes floues en < 30 ms pour 50 000 fichiers (`fzf`-for-js ou `command-score` sur le nom + bonus chemin ; à mesurer, préférer la dépendance déjà présente).
- **Tri** : ouverts récemment > modifiés par la mission en cours > correspondance du nom de fichier > correspondance du chemin. Les fichiers touchés par l'agent portent un badge « modifié par Nomi ».
- **Aperçu** : `→` sur un résultat ouvre un aperçu de 12 lignes dans la palette (lecture seule, sans charger CM6 : `<pre>` monospace) ; `←` le referme.
- **Symboles** : `documentSymbol` du LSP du fichier courant (mis en cache par version de document) ; symboles de l'espace par `workspace/symbol` avec `debounce` 150 ms ; sans LSP pour le langage, repli sur les symboles Lezer (`@codemirror/language` `syntaxTree`) pour le fichier courant, et « Aucun index de symboles pour ce langage » pour l'espace — dit, pas caché.

### 2.6 Profils Vim et Emacs

- Éditeur : `@replit/codemirror-vim` et `@replit/codemirror-emacs` (MIT, maintenus), chargés paresseusement avec le chunk éditeur, activés par `keymap.profile`.
- Hors éditeur : le profil Vim active `vimBindings` de cmdk, `j`/`k` dans les listes (messages, chronologie, revue), `Ctrl+W h/j/k/l` **en accord natif de Vim uniquement dans l'éditeur** ; il ne touche pas aux touches globales (`Ctrl+K`, `F6`, `Ctrl+P`).
- Emacs : `Ctrl+X Ctrl+S` enregistrer, `Ctrl+X b` onglets, `Ctrl+G` = `Échap` dans la palette et le composer, `Alt+X` = palette. Les accords Emacs sont gérés par `@replit/codemirror-emacs` dans l'éditeur et par le résolveur (mode accord activé par le profil) ailleurs.
- La barre d'état affiche le mode Vim (`NORMAL`, `INSERT`, `VISUAL`) en texte, annoncé au changement (`polite`).

---

## 3. Éditeur : moteur et disposition

### 3.1 CodeMirror 6 plutôt que Monaco

| Critère | CodeMirror 6 | Monaco | Poids pour NOVA |
| --- | --- | --- | --- |
| CSP `style-src 'self'` (ADR-005) | Le module `style-mod` crée une balise `<style>` et **pose l'attribut `nonce` si on le lui donne** (`EditorView.cspNonce`) ; dans un Shadow DOM, il passe par `adoptedStyleSheets` + `insertRule`, donc hors CSP. Vérifié dans la source de `style-mod` | Écrit du CSS dans des `<style>` par `textContent` sans nonce ; ticket `microsoft/monaco-editor#271` ouvert depuis 2016, état « Backlog ». La pratique courante est `style-src 'unsafe-inline'`, ce qui annule la protection de l'ADR-005 pour tout le renderer (un nonce désactive `'unsafe-inline'`) | **Décisif** |
| Renderer sandboxé, workers | Aucun worker requis : Lezer analyse de manière incrémentale et découpée dans le temps sur le thread principal ; les workers restent pour LSP et recherche | Exige des workers (`MonacoEnvironment.getWorker`) émis comme fichiers ; faisable avec `script-src 'self'`, mais chaque langage TypeScript/JSON/CSS embarque son service | Moyen |
| Taille | Cœur (`state`, `view`, `language`, `commands`, `search`, `autocomplete`, `lint`) de l'ordre de 300 Ko minifiés, ~100 Ko gzip ; langages à la demande (50–150 Ko chacun) | De l'ordre de plusieurs Mo minifiés hors workers et langages (**à mesurer au spike**, ordre de grandeur ×10) | Fort : démarrage < 1,5 s, `app.asar` |
| LSP | `@codemirror/lsp-client` (officiel, MIT) : `Transport` abstrait (messages JSON) — parfait pour un pont IPC vers un `utilityProcess` qui parle au serveur ; fonctions couvertes à confirmer version par version dans la référence | `monaco-languageclient` : couche `@codingame/monaco-vscode-api`, couplage de versions notoire, poids | Fort |
| Thème | `EditorView.theme({...})` génère du CSS : on écrit `color: var(--nv-accent)` ; le thème suit `data-theme` et le contraste élevé sans réinitialisation | `defineTheme` en couleurs hexadécimales : recalcul des tokens à chaque changement de thème, pas de `var()` | Moyen |
| Diff, accepter/rejeter | `@codemirror/merge` : `MergeView` (côte à côte), `unifiedMergeView` (dans l'éditeur), `acceptChunk`/`rejectChunk`, `goToNextChunk`, `collapseUnchanged`, `mergeControls` | `DiffEditor` sans accept/reject par bloc ; à construire | Fort (section 4.2) |
| Accessibilité | `contenteditable` avec le texte réel dans le DOM, `role="textbox"` `aria-multiline` ; `EditorView.announce` pour les annonces ; `Échap` puis `Tab` documenté | Zone de texte cachée + « mode lecteur d'écran » très travaillé par VS Code, dialogue d'aide intégré | Monaco devant sur l'existant ; CM6 rattrapé par le travail de la section 6.2 |
| Vim/Emacs | `@replit/codemirror-vim`, `@replit/codemirror-emacs` | `monaco-vim` (moins suivi) | Faible |
| Grandes lignes / gros fichiers | Rendu par fenêtre (viewport), documents en corde, lignes de 10 000+ caractères tenues (sans retour à la ligne) ; **à mesurer** sur 10 Mo | Excellent sur les gros fichiers | Moyen |
| React 19 | `EditorView` dans un `ref`, pas d'enveloppe nécessaire | `@monaco-editor/react` ou manuel | Faible |
| Provenance | Dépôts GitHub `codemirror/*` archivés en avril 2026, développement poursuivi sur `code.haverbeke.berlin` ; les paquets npm `@codemirror/*` restent la voie d'installation (à consigner dans ADR-009, avec le délai de 3 jours) | Microsoft | Suivi |

**Décision : CodeMirror 6.** Monaco n'est reconsidéré que si un besoin de compatibilité avec des extensions VS Code apparaît, ce qui est un non-objectif (`PRODUCT.md` : « Remplacer un IDE professionnel complet »).

### 3.2 Conditions d'intégration

1. **Nonce CSP par chargement** (prérequis P0, `main/renderer-assets.ts`, `main/protocol.ts`) : le gestionnaire `nova://` génère 16 octets aléatoires par réponse `index.html`, les injecte dans `Content-Security-Policy: … style-src 'self' 'nonce-<b64>'` **et** dans `<meta name="nova-csp-nonce" content="…">`. Le renderer lit la meta (`document.querySelector`) et la passe à `EditorView.cspNonce`. Les feuilles de style de `@nova/ui` restent des fichiers (`'self'`). En `pnpm dev`, le nonce est absent et `'unsafe-inline'` reste (déjà le cas). Test : `renderer-assets.test.ts` vérifie que deux chargements ont deux nonces et que l'en-tête et la meta correspondent.
   - Alternative sans nonce : monter chaque `EditorView` avec `root: shadowRoot` (`adoptedStyleSheets`). Coût : les tokens `--nv-*` traversent le Shadow DOM (variables héritées, OK) mais les classes utilitaires de `@nova/ui` non ; la sélection de texte inter-éditeurs et les outils de test (`getByRole`) se compliquent. Le nonce est préféré ; le Shadow DOM reste la solution de repli documentée.
2. **Chunk paresseux** : `editor/` importé par `import()` à la première ouverture de fichier ; langages par `@codemirror/language-data` (chargement à la demande par extension). Rien de CM6 dans le chunk initial.
3. **Un `EditorState` par document, une `EditorView` par onglet visible** : les onglets non visibles gardent leur état (curseur, plis, historique) dans un `Map<docId, EditorState>` ; la vue est reconstruite à l'affichage (quelques ms). Pas de vues cachées qui consomment.
4. **LSP** : un serveur par langage dans un `utilityProcess` (main), démarré à la première ouverture, arrêté après 10 min sans document ; JSON-RPC relayé au renderer par un canal IPC `nova:lsp:*` validé (taille des messages bornée, 1 Mo) ; `Transport` de `@codemirror/lsp-client` côté renderer. Aucun serveur n'est installé silencieusement : une bannière « Serveur de langage TypeScript indisponible — installer ? » avec le coût disque et la provenance (UX « proposé, jamais imposé »).
5. **Thème** : `editor/theme.ts` mappe les tokens de VISUAL.md 2.3 (palettes de syntaxe) sur `HighlightStyle` avec des `var(--nv-syntax-*)` ; contraste vérifié par `packages/ui/src/contrast.ts` dans un test (chaque couleur de syntaxe ≥ 4,5:1 sur `field`).
6. **Réglages de l'éditeur exposés dès J2** : taille de police (indépendante du zoom), retour à la ligne, numéros de ligne, guides d'indentation (pas de minimap en J2 : coût élevé, valeur nulle au clavier et au lecteur d'écran), curseur clignotant (suit `motion`), enregistrement automatique (défaut : après 1 s), formatage à l'enregistrement (défaut : non).
7. **Gros fichiers** : section 7.6.

### 3.3 Moteur de disposition du plan de travail

**Décision : dockview (`dockview-react`, MIT, sans dépendance) pour le plan de travail et le dock ; `react-resizable-panels` conservé pour la coque (rail, explorateur, plan de travail, panneau Agent).**

Pourquoi pas tout en `react-resizable-panels` : il sait diviser et redimensionner, pas glisser un onglet d'un groupe à l'autre ni sérialiser une arborescence de groupes avec leurs onglets. Pourquoi pas Golden Layout, FlexLayout, rc-dock : Golden Layout est plus lourd et moins React-natif ; FlexLayout est viable (MIT, sérialisation) et reste le **repli** si le spike dockview échoue sur l'un des critères ci-dessous ; rc-dock est moins actif.

Ce que dockview apporte : groupes, onglets, glisser-déposer entre groupes et vers les bords, division, `toJSON()`/`fromJSON()`, composant d'onglet personnalisable (`tabComponents`), verrouillage de groupe, fenêtres détachées (**désactivées** : `setWindowOpenHandler` refuse déjà tout), glisser-déposer désactivable par réglage. CSS livré en fichier (compatible CSP) ; positionnement par `style` React (CSSOM, compatible).

Critères du spike (2 jours, bloquants) :

- **Clavier** : la barre d'onglets doit être un `role="tablist"` avec `tabindex` tournant, `←→` entre onglets, `Entrée`/`Espace` active, `Suppr` ferme, `Ctrl+Maj+PageUp/PageDown` déplace l'onglet dans le groupe. Si dockview ne l'offre pas, on le fait dans notre `tabComponent` (`packages/ui` : `Tabs`, `Tab`) — accepté d'avance.
- **Alternative au glisser-déposer** (WCAG 2.5.7) : commandes « Déplacer l'onglet vers le groupe… », « Diviser à droite/en bas », « Fusionner les groupes » ; le menu contextuel d'un onglet (`Maj+F10`, `Menu`) les liste.
- **Sérialisation stable** : `toJSON()` → validé par un schéma zod avant enregistrement ; `fromJSON` tolérant (panneau inconnu = ignoré, jamais un plantage). Table `workspace_layouts (workspace_id, mode converse|build, layout_json, updated_at)` dans la migration J2 (changement de schéma : accord explicite). Une disposition par espace de travail **et** par mode.
- **Perf** : ouverture/fermeture d'onglet < 16 ms de script ; changement d'onglet sans démontage de l'éditeur voisin.
- **Réduit** : sous 900 px, dockview reste dans le plan de travail ; le dock passe en feuille du bas (VISUAL.md 3).

Dispositions nommées (commande `layout.preset`, page d'arguments) : « Discuter », « Coder », « Terminal », « Revue » ; « Réinitialiser la disposition » ; les presets ne sont que des `layout_json` livrés.

---

## 4. UX agent pour utilisateurs avancés

Toutes les actions ci-dessous passent par le moteur de permissions et le contrat de mission (UX.md 7). Ce qui suit est l'ergonomie, pas la politique.

### 4.1 Modification en ligne (`Ctrl+K` dans l'éditeur)

1. `Ctrl+K` avec sélection (ou sans : la ligne courante) ouvre un **panneau CM6** (`showPanel`, au-dessus de la sélection, jamais un `<dialog>` : on reste dans le document) contenant un champ d'une ligne « Décris la modification… », le modèle courant (bouton → `model.pick`), l'estimation de coût (« ≈ 0,002 $ ») et le rappel « `Ctrl+Maj+P` : palette ». Focus dans le champ ; `Échap` ferme sans rien envoyer ; `↑` rappelle la dernière consigne.
2. `Entrée` envoie : consigne + sélection + 40 lignes de contexte de chaque côté + chemin + langage + diagnostics LSP de la plage (bornés : 8 Ko de contexte, affiché dans « Ce qui part » au survol de l'estimation).
3. La réponse arrive en flux dans un **`unifiedMergeView`** limité à la plage : les lignes proposées apparaissent en vert au fil de l'eau, l'original reste en rouge ; rien n'est écrit sur disque. Nomi passe en `working` ; l'éditeur reste éditable ailleurs.
4. Fin de flux : les blocs deviennent navigables (`F7`/`Maj+F7`), `Ctrl+Entrée` garde le bloc, `Ctrl+Retour` le restaure, `Ctrl+Maj+Entrée` garde tout, `Échap` demande « Garder les blocs acceptés et abandonner le reste ? » si mélange. Annonce : « Proposition reçue : 3 modifications, F7 pour parcourir ».
5. Garder = transaction CM6 unique (annulable par `Ctrl+Z` en un coup), enregistrement automatique, entrée dans la chronologie (« Modification en ligne, `app.ts`, 2 blocs gardés, 1 restauré ») pour la restauration ciblée (UX.md 7.4).
6. Échec du fournisseur : la proposition partielle reste visible avec le callout d'erreur du même type que `ErrorBlock` (code, action) ; jamais de relance automatique.

### 4.2 Accepter et rejeter des blocs au clavier

- **Deux surfaces, un modèle** : l'aperçu inline (4.1) et la vue « Changements » (onglet du plan de travail, `MergeView` ou `unifiedMergeView` par fichier) partagent `review/model.ts` : liste ordonnée de `{ fileId, chunkIndex, state: "pending" | "kept" | "restored" }`, curseur de revue, compteurs. Les touches (`j`/`k`/`a`/`r`/`A`/`R`/`o`/`u`/`l`/`s`, section 2.2) appellent le modèle ; les deux vues s'y abonnent.
- Le bloc courant est toujours visible (`scrollIntoView` avec marge, WCAG 2.4.11) et porte `aria-label` « Bloc 2 sur 5, lignes 40 à 52, 6 ajoutées, 1 supprimée, en attente ». Les couleurs ne portent jamais seules l'information : préfixes `+`/`−`, icône par type (UX.md 10.4).
- « Garder tout » sur un fichier applique une seule transaction ; « Tout restaurer » demande confirmation (perte de travail de l'agent, pas de l'utilisateur, mais irréversible pour le budget dépensé).
- Les modifications préexistantes de l'utilisateur (scénario 5) apparaissent comme blocs « à toi », non acceptables ni restaurables par l'agent, avec un badge et un filtre `t` (toggle « masquer mes blocs »).
- Barre d'état : « Revue : 3 gardés · 1 restauré · 2 en attente » ; annonce polie à chaque décision (« Gardé »).

### 4.3 Suivre le curseur de l'agent

- L'agent expose des **événements de position** (`mission.cursor`: fichier, plage, étape) via le même canal que les `ChatStreamEvent` ; le renderer les rend comme une décoration CM6 (`Decoration.widget`, classe `.nova-agent-caret`, couleur `accent`, étiquette « Nomi » au survol/focus, `aria-hidden` ; le texte de la ligne reste lisible) et un marqueur de gouttière.
- **Suivi** (`F9`) : ouvrir le fichier de l'agent dans le groupe actif (ou un groupe « Nomi » verrouillé, réglage), faire défiler vers la plage (`EditorView.scrollIntoView`, `y: "center"`, au plus 4 fois par seconde), ne jamais déplacer le focus ni la sélection de l'utilisateur (WCAG 3.2.x).
- **Rupture** : une frappe, un défilement de plus de 64 px, un changement d'onglet manuel suspend le suivi — même règle que le fil de conversation (`STICK_THRESHOLD_PX`). Barre d'état : « Suivi suspendu · F9 pour reprendre » ; annonce polie une seule fois.
- Mouvement réduit : pas de défilement animé ; le curseur agent ne clignote pas.

### 4.4 Chronologie de la mission et parcours (scrubbing)

- **Modèle** : la chronologie est la liste des `AgentRun`/`ToolCall`/`Approval`/`Checkpoint` (ARCHITECTURE.md, entités J2–J3) ; chaque étape a un identifiant, un état, une durée, un coût constaté ou « inconnu », ses fichiers touchés, sa sortie terminal bornée, et un **point de reprise** (Checkpoint) quand elle a modifié des fichiers.
- **Vue** : liste virtualisée (`@tanstack/react-virtual`) `role="listbox"` avec `aria-activedescendant`, groupée par étape du plan ; en-têtes collants ; l'étape en cours porte l'orbite (activité réelle) ; la sélection d'une étape passée affiche à droite **l'instantané** : diff cumulé à ce point (`d`), fichiers (`f`), sortie (`t`) — lecture seule, onglet « Instantané · étape 4 » clairement distinct de l'éditeur vivant (bandeau ambre « Tu regardes le passé »).
- **Parcours au clavier** : `↑`/`↓` (ou `j`/`k`) ; `Début`/`Fin` ; `.` revient à l'étape en cours ; `PageUp`/`PageDown` par groupe. Le fil de conversation se synchronise (le message correspondant est mis en évidence, sans voler le focus).
- **Souris** : la barre de progression de la mission (VISUAL.md 4.6) est un `slider` `aria-valuetext="Étape 4 sur 9 : tests lancés"`, `←→` la déplacent aussi.
- Coût : la chronologie affiche le cumul « estimé / réservé / constaté » à chaque étape ; « inconnu » reste écrit.

### 4.5 Relancer depuis une étape

- `r` sur une étape, ou palette « Mission : relancer depuis l'étape… » (argument : liste des étapes avec point de reprise). Dialogue de confirmation (`Dialog`) : ce qui sera restauré (fichiers, depuis le point de reprise — jamais les modifications de l'utilisateur postérieures sans les lister), ce qui sera rejoué, coût estimé et budget restant, case « Essai à blanc » (UX.md : voir ce que la mission ferait). Bouton primaire « Relancer depuis l'étape 4 » ; `Échap` annule.
- La relance crée une **nouvelle branche** de chronologie ; l'ancienne reste consultable (« Tentative 1 », « Tentative 2 »), jamais écrasée (ADR-011 : la version précédente reste jusqu'au début de la nouvelle).
- Une étape sans point de reprise (par exemple un appel d'outil externe non idempotent, scénario 11) n'est pas « relançable » ; l'item est visible et désactivé avec la raison.

### 4.6 Approbations au clavier

- Une carte d'approbation est un `dialog` non modal nommé (UX.md 10.2) ; elle **reçoit le focus** à l'apparition seulement si l'utilisateur n'est pas en train de taper (composer, éditeur ou terminal avec frappe dans les 2 dernières secondes) ; sinon annonce assertive « Nomi demande une confirmation : … · Ctrl+Maj+A » et Nomi passe en `waiting`.
- Dans la carte : `Tab` entre « Détail », « Refuser », « Autoriser » ; `Entrée` active ; `Échap` refuse (UX.md) ; `Ctrl+Entrée` autorise depuis n'importe où dans la carte. Aucune touche simple.
- Plusieurs cartes : `Ctrl+Maj+A` va à la plus ancienne ; `↑`/`↓` dans la pile.

---

## 5. Terminal

### 5.1 Architecture

- **Rendu** : `@xterm/xterm` dans le renderer, **`@xterm/addon-webgl` obligatoire**. Vérifié dans la source de `DomRenderer.ts` : le rendu DOM crée des `<style>` et leur affecte `textContent` (thème, dimensions) sans nonce — bloqué par `style-src` avec nonce. Le rendu WebGL dessine sur canvas ; **à vérifier au spike** qu'aucun `<style>` n'est injecté sur ce chemin (sinon, correctif upstream + `pnpm patch` justifié dans ADR-009). Si WebGL est indisponible (rendu logiciel, perte de contexte), NOVA l'affiche (« Accélération graphique indisponible : terminal en mode dégradé ») et propose l'option « Réduire l'isolation des styles pour le terminal » — **désactivée par défaut**, décrite dans SECURITY.md, plutôt qu'un terminal illisible ou un `'unsafe-inline'` global silencieux.
- **PTY** : `node-pty` dans un `utilityProcess` dédié par espace de travail (ARCHITECTURE.md prévoit ce processus). C'est le seul module natif : exception à l'ADR-002 à consigner (ADR-014), avec binaires précompilés épinglés par version d'Electron et vérification d'empreinte à l'installation. Sans `node-pty` fonctionnel (ABI, plateforme), l'onglet Terminal montre l'erreur réelle et son niveau d'isolation (VISUAL.md 4.5), jamais un faux terminal.
- **Flux** : `utilityProcess` → main → renderer par `MessagePort` (pas `ipcRenderer.invoke` par fragment) ; sortie coalescée par trame (≤ 16 ms ou 64 Ko) ; contrôle de flux par crédits : le renderer accuse réception après `term.write(data, cb)`, le PTY est mis en pause au-delà de 1 Mo non accusé (recommandation xterm). Entrée renderer → PTY sans coalescence (latence d'écho ≤ 30 ms, section 7.1).
- **Sessions de Nomi** : lancées par le runtime avec le même processus, affichées en lecture seule (« Prendre la main » rend l'entrée, VISUAL.md 4.5) ; leur sortie alimente aussi les preuves de mission.
- Addons : `fit`, `search`, `unicode11`, `serialize` (restauration de l'écran à la reprise), `clipboard` ; **pas** `web-links` (les liens passent par `app.openExternal` et sa liste d'autorisation : un gestionnaire de liens maison appelle l'IPC, et affiche l'origine refusée comme `RefusedLink` du Markdown).

### 5.2 Intégration shell

- Séquences **OSC 133** (FinalTerm, standard de fait : `A` début d'invite, `B` début de commande, `C` début de sortie, `D;<code>` fin) + **OSC 7** (répertoire courant) + **OSC 633** en lecture (compatibilité avec des scripts VS Code déjà présents chez l'utilisateur : `E` ligne de commande, `P` propriétés). NOVA n'émet pas de séquence propriétaire.
- Scripts d'intégration livrés pour bash, zsh, fish, pwsh (Windows : pwsh et Git Bash), injectés à l'ouverture comme VS Code : bash `--rcfile` enveloppant le `~/.bashrc`, zsh via `ZDOTDIR` temporaire qui source le vrai, fish via `XDG_DATA_DIRS`, pwsh via `-NoExit -Command`. Réglage « Intégration du shell : automatique / manuelle / désactivée » et commande « Copier le chemin du script d'intégration » pour l'installation manuelle. Sans intégration (shell inconnu), les blocs sont indisponibles et l'interface le dit (« Blocs de commande indisponibles : shell sans intégration »), le terminal fonctionne.
- Le renderer parse OSC 133/633/7 avec `term.parser.registerOscHandler` et maintient un modèle `blocks: { id, marker, command, cwd, startedAt, endedAt, exitCode | null }`.

### 5.3 Blocs de commande

Choix : **une seule instance xterm par session**, blocs matérialisés par des décorations et un modèle latéral — pas un DOM par bloc à la Warp. Raisons : la fidélité VT (applications plein écran, `vim`, `htop`) reste parfaite ; le coût est celui de xterm ; Warp obtient ses blocs en prenant la place du shell, ce que NOVA ne veut pas (le terminal reste « le vrai »).

- **Décorations** (`term.registerDecoration` sur le marqueur de `B`) : gouttière 6 px à gauche du bloc (`accent` en cours, `text-muted` terminé, `danger` code ≠ 0), point de statut sur la ligne de commande avec `title` « Terminé, code 1, 2,3 s », bandeau collant de la commande en cours en haut (sticky scroll) quand la sortie dépasse l'écran.
- **Navigation** : `Ctrl+↑/↓` entre commandes, `Ctrl+Maj+↑/↓` sélectionne la sortie du bloc ; survol/focus d'un bloc : barre d'actions (Copier la commande, Copier la sortie, Relancer, Expliquer, Envoyer à la conversation).
- **Liste de blocs** (panneau latéral 160 px repliable, VISUAL.md 4.5 « sessions ») : liste virtualisée `role="list"` avec commande, durée, code ; `Entrée` fait défiler le terminal vers le bloc ; c'est aussi la vue lisible au lecteur d'écran.
- **Historique** : commandes et codes de sortie (jamais la sortie) enregistrés dans SQLite (`terminal_commands`, J2, avec accord de schéma) pour « Commandes récentes » (`Ctrl+Maj+R`) et pour les preuves de mission ; réglage « Ne pas enregistrer » ; les lignes qui ressemblent à des secrets (motifs de `redactSecrets`) ne sont jamais enregistrées.

### 5.4 Expliquer une commande échouée, générer une commande

- Fin de bloc avec code ≠ 0 : décoration « Expliquer » sur la ligne de commande (bouton réel, focalisable via `Ctrl+↑` puis `Tab`), raccourci `Ctrl+Maj+X` pour le dernier échec, annonce polie « Commande terminée avec le code 127 » **seulement** si le réglage « Annonces du terminal » est activé (bavard sinon). Jamais d'appel automatique au modèle : c'est une requête payante (ADR-006) et la sortie peut contenir des secrets.
- Au clic : carte « Ce qui sera envoyé » (commande, code, `cwd`, shell, les 200 dernières lignes / 8 Ko de sortie, après `redactSecrets`), coût estimé, bouton « Demander l'explication ». La réponse s'affiche dans la conversation (pas dans le terminal), avec, si le modèle propose une commande corrigée, un bouton « Insérer dans le terminal » (insère, n'exécute pas) et, en mode Construire, « Laisser Nomi la lancer » (approbation).
- `Ctrl+K` dans le terminal : champ « Décris la commande… » ancré au-dessus de l'invite (panneau NOVA, pas dans le flux VT) ; la proposition est insérée à l'invite, jamais exécutée ; `Échap` annule. Même carte « Ce qui sera envoyé » (contexte : shell, OS, `cwd`, 3 dernières commandes).

### 5.5 Clavier et accessibilité du terminal

- `term.attachCustomKeyEventHandler` laisse passer vers l'application **uniquement** : `Ctrl+Maj+P`, `F1`, `F6`/`Maj+F6`, `Ctrl+B`, `Ctrl+Maj+B`, `Ctrl+J`, `Ctrl+Maj+J`, `Ctrl+I`, `Ctrl+L`, `Ctrl+,`, `Ctrl+P`, `Ctrl+Tab`, `Ctrl+PageUp/Down`, `Ctrl+[Digit1…9]`, `Alt+[Digit1…9]`, `Ctrl+W`, `Ctrl+K`, `Ctrl+Maj+C/V/X/R/F`… (liste `terminal.keysToSkipShell`, exposée dans le JSON des réglages, comme VS Code). Tout le reste va au shell, y compris `Ctrl+C` sans sélection, `Ctrl+D`, `Ctrl+R`, `Ctrl+Z`.
- `Ctrl+M` bascule « Tab déplace le focus » ; annonce à l'entrée du terminal « Terminal. F6 pour sortir. » (remplace le « `Ctrl+Maj+`` » d'UX.md).
- `screenReaderMode: true` quand la prise en charge d'accessibilité est active (Electron `app.isAccessibilitySupportEnabled()` relayé dans `AppInfo` + événement `accessibility-support-changed`), réglage « auto / activé / désactivé ».
- `minimumContrastRatio: 4.5` (7 en contraste élevé) : xterm ajuste les couleurs ANSI trop faibles ; palette ANSI de VISUAL.md 2.4 vérifiée dans un test de contraste.
- Curseur : bloc, clignotement suivant `motion`. Taille de police propre au terminal.
- « Lire les 10 dernières lignes » (`Alt+L`) et « Copier la sortie du bloc » alimentent un `Dialog` avec un `<pre role="document">` lisible ligne à ligne — la voie fiable pour les lecteurs d'écran, complémentaire du mode `log`.

---

## 6. Accessibilité WCAG 2.2 AA

Cible inchangée (DESIGN_SYSTEM.md, UX.md 10) ; ici, le plan pour les trois surfaces les plus dures — éditeur, terminal, diff — et le streaming.

### 6.1 Critères sensibles par surface

| Critère | Éditeur | Terminal | Diff / revue | Flux de conversation |
| --- | --- | --- | --- | --- |
| 1.3.1 Information et relations | Diagnostics liés par `aria-describedby` au niveau ligne (mode lecteur d'écran) ; plis annoncés | Blocs = liste ; commande/sortie/code en texte | Blocs = régions nommées, `+`/`−` textuels | Messages `article` nommés « Toi » / « Nomi » (livré) |
| 1.4.1 Couleur | Syntaxe : jamais porteuse seule d'un sens fonctionnel | Codes de sortie en texte | Préfixes, icônes, hachures (UX.md 10.4) | Statuts en texte (livré) |
| 1.4.3 / 1.4.11 Contraste | Palette de syntaxe ≥ 4,5:1 ; gouttière, guides, curseur agent ≥ 3:1 | `minimumContrastRatio`, ANSI vérifiée | Fonds ajout/suppression : texte ≥ 4,5:1 dessus | Livré (tokens) |
| 1.4.4 / 1.4.10 Redimensionnement, reflow | Police de l'éditeur indépendante ; pas de défilement horizontal imposé (retour à la ligne activable) | Police propre, `fit` | Unifié par défaut sous 900 px | 200 % : disposition étroite (livré) |
| 1.4.12 Espacement du texte | Interligne 1,6 et espacement de lettres appliqués aussi à l'éditeur (option « Lecture facilitée », UX.md 10.5) | Interligne réglable (`lineHeight`) | idem éditeur | Livré |
| 1.4.13 Contenu au survol | Infobulles LSP fermables par `Échap`, persistantes au survol | Barre d'actions de bloc idem | idem | — |
| 2.1.1 / 2.1.2 Clavier, pas de piège | `Échap` puis `Tab` ; `Ctrl+M` | `F6` ; `Ctrl+M` | Tout au clavier (section 2.2) | Livré |
| 2.1.4 Raccourcis à une touche | Aucun hors mode Vim (activé par l'utilisateur) | Aucun côté application | Actifs seulement quand la vue a le focus | idem (liste focalisée) |
| 2.4.3 / 2.4.7 Ordre et visibilité du focus | Anneau `focus` sur le conteneur de l'éditeur (`.cm-editor.cm-focused`) | Anneau sur `.xterm` focalisé | Bloc courant entouré | Livré |
| 2.4.11 Focus non masqué | `scroll-padding` sous les en-têtes collants et au-dessus du composer collant ; bloc courant jamais sous le bandeau | Sticky scroll ≤ 1 ligne | idem | Bouton « aller en bas » ne recouvre pas le focus |
| 2.5.7 Mouvements de glisser | Séparateurs au clavier (livré) ; onglets : commandes « Déplacer vers… » | Redimensionnement du dock au clavier | — | — |
| 2.5.8 Taille des cibles | Onglets 36 px, poignées 6 px avec zone de 24 px | Boutons de bloc 24 px min | Boutons Garder/Restaurer 30 px | Livré |
| 3.2.1 / 3.2.2 Pas de changement de contexte inattendu | Le suivi de l'agent ne déplace jamais le focus | Fin de commande ne déplace pas le focus | Décision sur un bloc ne change pas de fichier | Fin de réponse : annonce, pas de focus |
| 3.3.1 / 3.3.3 Erreurs | Diagnostics annoncés à l'entrée dans la ligne, message + suggestion | Code de sortie + « Expliquer » | — | Livré (codes, action) |
| 4.1.2 / 4.1.3 Nom, rôle, valeur ; messages d'état | `role=textbox` `aria-multiline` `aria-label` « Éditeur : app.ts » ; `aria-invalid` par diagnostic | Conteneur `region` nommé « Terminal 1 : zsh » ; pas de `role=application` sur le conteneur (xterm gère son propre arbre en mode lecteur d'écran) | `region` par fichier, `group` par bloc | `Announcer` unique (6.3) |

### 6.2 Modes lecteur d'écran

- **Détection** : `AppInfo.accessibilitySupport: boolean` + événement `nova:app:accessibility-changed` (Electron `accessibility-support-changed`). Réglage `a11y.screenReader: "auto" | "on" | "off"` ; « auto » suit la détection. Aucune détection heuristique par frappe.
- **Éditeur** :
  - Annonce du numéro de ligne au déplacement vertical, des diagnostics à l'entrée dans une ligne, du nombre de résultats de recherche, des changements de mode Vim, des blocs de proposition — par `EditorView.announce` (région `aria-live` interne de CM6).
  - Dialogue « Aide accessibilité de l'éditeur » (`Alt+F1`) : sortie, `Ctrl+M`, raccourcis du contexte, état du mode lecteur d'écran.
  - Curseur agent : jamais lu comme du texte (`aria-hidden`), mais « Nomi modifie la ligne 42 » annoncé poliment quand le suivi est actif, au plus une fois par 5 s.
  - Complétions : `role=listbox` de CM6, `aria-activedescendant` ; le nombre de propositions est annoncé.
- **Terminal** : `screenReaderMode` (xterm rend une région live de l'écran) + liste de blocs lisible + « Lire les 10 dernières lignes » + annonces de fin de commande optionnelles. Le mode `log` d'UX.md 10.2 est ce `screenReaderMode` ; les blocs sont l'accès structuré.
- **Diff** : mode « Lecture » (`l`) : chaque bloc rendu en phrases dans un `Dialog` non modal (« `index.html`, bloc 1 sur 3, lignes 12 à 18 : 4 lignes ajoutées, 1 supprimée. Ligne supprimée : … Lignes ajoutées : … »), `s` lit le résumé du fichier, `j`/`k` continuent de fonctionner. En mode lecteur d'écran « on », l'unifié est le défaut, jamais le côte à côte.

### 6.3 Stratégie `aria-live` et streaming

Un service unique `renderer/a11y/announcer.ts` (deux régions permanentes dans `App.tsx` : `polite` et `assertive`, `aria-atomic="false"`, un nœud enfant par message, purge après 10 s), remplaçant `OutcomeAnnouncer` et les `aria-live` posés sur des boutons (`CodeBlock`, `RefusedLink` — un `aria-live` sur un bouton dont le libellé change est fragile ; on annonce « Copié » par le service).

Règles :

| Événement | Priorité | Texte | Dédoublonnage |
| --- | --- | --- | --- |
| Fin de génération (succès, arrêt, échec) | polite | livré (`fr.chat.announce*`) | par `outcome.at` |
| Longue génération | polite toutes les 30 s | « Nomi écrit toujours, 40 lignes reçues » (UX.md) | — |
| Étape de mission terminée | polite | « Étape 2 sur 4 terminée : … » | par étape |
| Approbation demandée, suspension budget | **assertive** | « Nomi demande une confirmation : … Ctrl+Maj+A » | par approbation |
| Erreur qui bloque l'action de l'utilisateur (envoi refusé) | assertive | titre de `describeUiError` | par draft |
| Erreur d'une réponse (non bloquante) | polite | livré | — |
| Décision de revue, copie, suivi suspendu, mode Vim, zoom | polite | court (« Gardé », « Zoom 150 % ») | fusion si < 500 ms |
| Fin de commande terminal | polite, opt-in | « Commande terminée, code 1 » | — |

Streaming : par défaut, **rien** pendant le flux (livré). Option `a11y.readWhileStreaming` : les fragments sont tamponnés jusqu'à une fin de phrase (`. ! ? \n`), vidés toutes les 2 s au plus, 300 caractères par annonce, dans la région polite ; `aria-busy="true"` sur le message en cours ; `Maj+Échap` arrête le flux et vide le tampon.

### 6.4 Gestion du focus

- Ouverture d'un fichier par l'utilisateur → focus éditeur, curseur restauré. Ouverture par l'agent (suivi) → jamais de focus.
- Fermeture d'onglet → onglet voisin (suivant, sinon précédent), comme la suppression de conversation dans `Sidebar.tsx` (`neighborId`).
- Palette, ouverture rapide, aide, confirmation : `Dialog` natif (retour à l'ouvreur ou repli `main[tabindex]`, livré).
- Panneaux CM6 (modification en ligne, recherche) : focus dans le panneau à l'ouverture, retour à l'éditeur à la fermeture (`EditorView.focus()`).
- `F6` suit l'ordre visuel : navigation → plan de travail (groupe actif) → dock → panneau droit → composer ; chaque zone est un point d'arrêt `tabindex="-1"` nommé, la zone reçue est annoncée (« Plan de travail »).
- Aucun `autoFocus` hors composer et champ de saisie demandé (règles oxlint existantes).

### 6.5 Contraste élevé et `forced-colors`

- Deux thèmes supplémentaires `hc-dark`, `hc-light` (`data-theme`) : texte ≥ 7:1, contrôles et bordures ≥ 4,5:1, bordures pleines partout (pas d'élévation par ombre), anneau de focus 3 px double (`focus` + `bg`), sélection avec bordure, syntaxe et ANSI recalculées. Réglage `theme` étendu (`system | dark | light | hc-dark | hc-light`) : changement de schéma `SettingsPatchSchema` → accord explicite ; « système » suit `prefers-contrast: more` en choisissant la variante HC.
- `@media (forced-colors: active)` (Windows contraste élevé) : couleurs système (`CanvasText`, `Highlight`, `ButtonText`), `forced-color-adjust: none` seulement sur la marque et Nomi ; diff avec hachures et préfixes ; terminal : xterm dessine sur canvas, donc thème HC forcé par code quand `forced-colors` est actif.
- Test : `contrast.test.ts` étendu aux tokens HC, syntaxe et ANSI ; E2E axe `color-contrast` sur les quatre thèmes.

### 6.6 Zoom 200 %

- `Ctrl+=`/`Ctrl+−`/`Ctrl+0` → IPC `nova:view:zoom` → `webContents.setZoomFactor` (0,5–3), persisté `appearance.zoom` (portée `machine`), annoncé (« Zoom 200 % »). Menu macOS : rôles `zoomIn`/`zoomOut`/`resetZoom` reliés à la même commande.
- À 200 % sur 1 320 px, la largeur CSS est 660 px : la disposition étroite (< 900 px, livrée) s'applique ; le dock passe en feuille. À 400 % sur 1 280 px (320 px CSS, WCAG 1.4.10) : fenêtre minimale 720 px → 180 px CSS ; on documente 320 px CSS comme minimum garanti (fenêtre ≥ 1 280 px à 400 %, ou ≥ 640 px à 200 %).
- Polices de l'éditeur et du terminal indépendantes du zoom (réglages), pour que l'interface puisse grossir sans réduire le code, et inversement.
- Test E2E : `viewport 1280×720`, zoom 2 : aucun `scrollWidth > clientWidth` dans `.nova-chat__scroll`, `.cm-scroller` (avec retour à la ligne), `.nova-settings` ; tous les boutons d'en-tête visibles ou dans un menu « Plus ».

### 6.7 Mouvement réduit

Étend la règle globale (`base.css`) aux nouvelles surfaces : CM6 `drawSelection({ cursorBlinkRate: 0 })` quand réduit ; xterm `cursorBlink: false` ; dockview : durées de transition `0s` via les variables CSS du thème ; suivi de l'agent : `scrollIntoView` sans lissage ; chronologie sans apparition animée ; l'orbite de fin de flux (`OrbitIndicator` sur `.nova-message__cursor`) est déjà figée par la règle globale.

### 6.8 Plan de test

**Automatique (CI, à chaque PR)**

1. `e2e/a11y.spec.ts` : audit axe (`@axe-core/playwright`, mode legacy, livré) sur chaque écran : onboarding, conversation avec réponse, palette ouverte, ouverture rapide, réglages (chaque section + JSON), éditeur avec fichier et diagnostics, revue de diff, terminal avec deux blocs, chronologie, approbation ; sur les quatre thèmes ; à 100 % et 200 %. Règle `color-contrast` activée. Aucune violation `serious`/`critical`, et **liste figée** des `moderate` acceptées (fichier `a11y-allowlist.json`, toute entrée justifiée).
2. `e2e/keyboard.spec.ts` : traversée `Tab` complète de chaque écran, ordre attendu en instantané (liste de noms accessibles) ; `F6` cycle ; sortie de l'éditeur et du terminal ; aucune zone où `document.activeElement` devient `body`.
3. `e2e/announcer.spec.ts` : `getByRole("status")` / `getByRole("alert")` contiennent exactement les textes attendus après fin de réponse, erreur, décision de revue ; **pas** d'annonce pendant le flux quand l'option est désactivée.
4. Tests de composants (Vitest + jsdom) : rôles, noms, `aria-keyshortcuts` générés, `when` du registre, résolveur de keymap (AZERTY simulée : `key: "&"`, `code: "Digit1"`).
5. Contraste : `contrast.test.ts` sur tokens, syntaxe, ANSI, HC.

**Manuel (par jalon, consigné dans `STATUS.md`, scénario 15)** — trois scripts identiques, un par lecteur d'écran, avec colonnes « annonce attendue / annonce entendue / OK ».

| # | Étape | Attendu |
| --- | --- | --- |
| 1 | Lancer NOVA, `Tab` | « Aller au contenu, lien » puis champ « Clé API OpenRouter » |
| 2 | Coller une clé, `Entrée` | « Vérification… » puis « Clé vérifiée » (titre focalisé) |
| 3 | `Ctrl+K`, taper « thème », `↓`, `Entrée` | items lus avec catégorie ; « Réglage enregistré » |
| 4 | `Ctrl+N`, écrire, `Entrée` | « Nomi réfléchit » via le dock ; silence pendant le flux ; « Réponse terminée » |
| 5 | `F6` jusqu'aux messages, `↓` | « Nomi, réponse terminée, … » lu ; `n` va au bloc de code, « Copier le code » nommé |
| 6 | `Ctrl+P`, `app.ts`, `Entrée` | « Éditeur : app.ts, ligne 1 » ; `↓` annonce la ligne ; `Alt+F1` ouvre l'aide |
| 7 | Sélection, `Ctrl+K`, consigne, `Entrée` | « Proposition reçue : n modifications » ; `F7`, `Ctrl+Entrée` → « Gardé » |
| 8 | `Ctrl+3` | « Terminal 1 : zsh. F6 pour sortir. » ; taper `false`, `Entrée` ; `Ctrl+Maj+X` → carte « Ce qui sera envoyé » lue |
| 9 | `Ctrl+2`, `j`, `l` | bloc lu en phrases ; `a` → « Gardé » |
| 10 | Approbation simulée | annonce assertive, `Ctrl+Maj+A`, carte lue dans l'ordre action / effet / provenance / boutons |
| 11 | `Ctrl+=` ×3 | « Zoom 200 % » ; tout reste atteignable |
| 12 | Réglages › Apparence › contraste élevé | thème appliqué, annonce |

- **NVDA** (Windows 11, Chromium) : mode navigation vs mode formulaire — vérifier que l'éditeur et le terminal passent en mode formulaire automatiquement ; `NVDA+F7` liste les régions.
- **VoiceOver** (macOS) : `VO+U` rotor → régions ; vérifier que `⌘K`/`⌘P` ne sont pas capturés par VO ; le menu d'application expose les rôles.
- **Orca** (Ubuntu, plateforme de référence) : lancer avec `ACCESSIBILITY_ENABLED=1` ou `--force-renderer-accessibility` pour les essais sans Orca actif ; vérifier AT-SPI dans Xvfb (Orca hors CI, manuel).
- **Guidepup** (`@guidepup/playwright`, MIT) : à partir de J2, scripts 1–5 automatisés avec NVDA et VoiceOver sur les runners Windows et macOS ; informatif d'abord, bloquant une fois stable.

---

## 7. Performance perçue

### 7.1 Budgets

Machine de référence : celle d'ADR-007 (Linux x64), SSD, cache disque chaud ; les valeurs CI sont relatives à une base mesurée, pas absolues (runners lents). Chaque budget a sa mesure ; « à mesurer » est autorisé une fois, pas deux (ADR-001).

| Métrique | Budget | Mesure |
| --- | --- | --- |
| Démarrage : lancement → fenêtre visible (`ready-to-show`) | ≤ 600 ms | main : `performance.now()` à l'entrée du module, log `startup` |
| Démarrage : lancement → coque interactive (composer focalisable, store `ready`) | **≤ 1 500 ms** (cible), ≤ 2 500 ms cache froid (informatif) | renderer `performance.mark("nova:interactive")` + main |
| Liste des conversations peinte | ≤ 1 800 ms | `mark("nova:conversations")` |
| Ouvrir une conversation de 200 messages | ≤ 150 ms jusqu'au premier rendu | `mark` autour de `openConversation` |
| Palette : ouverture / résultats (50 000 fichiers) | ≤ 50 ms / ≤ 80 ms | marks |
| Frappe → peinture (composer, éditeur, terminal) | p95 traitement ≤ 16 ms ; INP p95 ≤ 100 ms | `PerformanceObserver("event")` |
| Écho terminal (touche → glyphe) | ≤ 30 ms | E2E : horodatage écriture PTY / trame |
| Débit terminal (`cat` 10 Mo) | ≤ 2 s, aucune trame > 50 ms | idem |
| Flux : coût d'un vidage de fragments (réponse de 50 000 caractères) | ≤ 8 ms | `mark` dans le vidage |
| Ouvrir un fichier 1 Mo / 10 Mo | ≤ 300 ms / ≤ 1 s (lecture seule) | marks |
| Mémoire renderer au repos (une conversation, Nomi visible) | ≤ 150 Mo | `app.getAppMetrics()` |
| Mémoire renderer : 4 éditeurs + 2 terminaux | ≤ 350 Mo | idem |
| Mémoire main / `utilityProcess` terminal | ≤ 100 Mo / ≤ 30 Mo | idem |
| CPU au repos (aucune activité) | 0 réveil périodique > 1/min | `useNow` conditionnels (7.8), profil |
| Chunk initial renderer / éditeur / terminal | ≤ 350 Ko gz / ≤ 400 Ko gz / ≤ 250 Ko gz | `scripts/check-bundle-size.mjs` sur `out/renderer` |

### 7.2 Démarrage à froid

1. **Thème connu du main** : `settings.theme` est en SQLite, lu avant `createWindow` : `backgroundColor` et `data-theme` du `index.html` (substitution à la volée dans le gestionnaire `nova://`, en même temps que le nonce) reflètent le thème réel — plus de flash sombre en thème clair, et le squelette `Boot` a déjà les bonnes couleurs.
2. **Afficher tôt** : `ready-to-show` reste le déclencheur ; la page initiale ne charge que la coque (React, zustand, cmdk, ui) ; éditeur, terminal, diff, Markdown lourd (`react-markdown` + `remark-gfm` : chargés à la première réponse, avec un `<pre>` de repli pendant le chargement), modèle de sélecteur : chunks `import()` ; Vite `manualChunks` explicites et testés (`[INEFFECTIVE_DYNAMIC_IMPORT]` surveillé au build).
3. **Polices** : `<link rel="preload" as="font" crossorigin>` pour Manrope et JetBrains Mono (deux fichiers variables), `font-display: swap` avec `size-adjust` pour limiter le décalage.
4. **Store** : ouverture SQLite synchrone et courte (livré) ; `PRAGMA optimize` au quit, pas au démarrage ; `markInterruptedStreams()` reste, indexé.
5. **Boot renderer** : `loadCore` (3 IPC en parallèle, livré) → on ajoute `conversations.list` dans le même lot et on diffère `models.catalog` de 500 ms après `interactive`.
6. **Mesure** : `main/startup-trace.ts` écrit `startup.json` (`t0` process, `ready`, `window-created`, `ready-to-show`, `did-finish-load`, `renderer:interactive` reçu par IPC) dans `logDir` ; visible dans Réglages › Diagnostics (« Dernier démarrage : 1,2 s ») — preuve, pas promesse.

### 7.3 Latence de saisie

- Composer : `textarea` contrôlé par le store via `setDraft` à chaque frappe (`useSendMessage`) : garder, mais **différer** l'écriture dans le store (`startTransition`) et ne jamais faire dépendre du store le rendu de la frappe elle-même ; mesurer INP.
- Éditeur : CM6 gère ; on interdit les extensions qui font un travail synchrone par transaction (lint en `debounce` 300 ms, LSP en `debounce` 150 ms, décorations agent par `requestAnimationFrame`).
- Terminal : entrée envoyée sans regroupement ; sortie regroupée (5.1).
- Règle générale : pas de `useEffect` qui écrit dans le store à chaque frappe ; les listeners `keydown` globaux sont un seul (`resolve.ts`), en O(1) par touche.

### 7.4 Virtualisation

`@tanstack/react-virtual` (MIT, sans dépendance, hauteurs dynamiques par `measureElement`) pour : liste des conversations (aujourd'hui capée à 200 ; avec pagination « charger plus » côté main), fil de messages (longues conversations : charger les 100 derniers messages puis « Messages précédents »), liste de blocs terminal, chronologie, arbre de fichiers (aplati), résultats de recherche dans les fichiers, catalogue de modèles (458 entrées, aujourd'hui non virtualisé). Le fil garde la logique « coller en bas » ; l'ancrage de défilement (`overflow-anchor`) évite les sauts quand une réponse au-dessus change de hauteur.

### 7.5 Rendu du flux

- **Regroupement** : le main coalesce déjà les écritures ; le renderer ajoute un tampon `pendingDeltas` vidé par `requestAnimationFrame` au plus toutes les 50 ms (≥ 20 images/s perçues, moins de rendus).
- **Markdown par blocs** : `Markdown.tsx` découpe le texte en blocs (frontières `\n\n` hors blocs de code ouverts), rend chaque bloc **stable** (tous sauf le dernier) par un composant mémorisé sur la chaîne du bloc ; seul le dernier bloc est ré-analysé. Coût linéaire au lieu de quadratique. Alternative évaluée : `streamdown` (rendu Markdown pour flux, gère les blocs incomplets) — retenue seulement si le découpage maison ne suffit pas aux tableaux et listes en cours.
- **Bloc de code en cours** : rendu en `<pre>` sans coloration jusqu'à sa fermeture ; coloration (CM6 `highlightCode` ou Lezer en lecture seule, même chunk que l'éditeur) ensuite.
- Curseur d'orbite : un seul élément, pas de recréation par fragment.

### 7.6 Gros fichiers

| Taille / forme | Comportement |
| --- | --- |
| ≤ 1 Mo | Normal |
| 1–5 Mo | Coloration Lezer découpée (budget 20 ms par tranche, en arrière-plan), LSP désactivé, avertissement dans l'onglet |
| 5–50 Mo | Lecture seule, sans coloration, recherche disponible ; « Modifier quand même » explicite |
| > 50 Mo | Refus expliqué (« 120 Mo : trop gros pour l'éditeur. Ouvrir dans le terminal avec `less` ? ») |
| Ligne > 10 000 caractères | Retour à la ligne forcé désactivé pour ce fichier, avertissement |
| Binaire (octet nul dans les 8 premiers Ko) | Aperçu hexadécimal 4 Ko, jamais l'éditeur |

Lecture par IPC en une réponse jusqu'à 5 Mo ; au-delà, flux par tranches de 1 Mo (`nova:file:read` paginé), pour ne pas bloquer le main.

### 7.7 Workers et processus

| Travail | Où | Pourquoi |
| --- | --- | --- |
| Index de fichiers, recherche floue, symboles Lezer | Web Worker (fichier émis par Vite, `script-src 'self'`) | Jamais de blocage de la frappe |
| Serveurs LSP, `fs.watch`, énumération | `utilityProcess` (Node) | Accès disque, isolation, arrêt propre |
| PTY | `utilityProcess` par espace de travail | Module natif isolé du main |
| Recherche dans les fichiers (`ripgrep`-like) | `utilityProcess`, flux de résultats bornés (10 000) | Disque + CPU |
| Diff (calcul) | `@codemirror/merge` dans le renderer (diff incrémental) ; pour les diffs de mission > 200 Ko, `utilityProcess` | Éviter les gels |
| SQLite lourd (recherche plein texte des conversations) | main, requêtes indexées ; FTS5 si nécessaire (schéma : accord) | ADR-003 |

### 7.8 Mémoire et réveils

- Plafonds : `scrollback` terminal 10 000 lignes (réglable) ; états CM6 des onglets inactifs conservés, vues démontées ; conversations : détail déchargé quand la conversation quitte l'écran depuis > 5 min ; catalogue en mémoire une fois.
- Réveils : `useNow(1000)` de `NomiDock` uniquement pendant la fenêtre `OUTCOME_WINDOW_MS` ; `useNow(30_000)`/`useNow(60_000)` remplacés par un unique `useMinuteTick` partagé ; aucune animation CSS en boucle au repos (règle de l'orbite, déjà écrite).
- Diagnostics : Réglages › Diagnostics affiche `app.getAppMetrics()` (par processus : type, CPU, mémoire) et le dernier `startup.json` ; bouton « Copier le rapport » (sans secrets).

### 7.9 Méthodologie et portes CI

- `apps/desktop/e2e/perf.spec.ts` : 5 lancements, médiane, pour démarrage, ouverture de conversation, ouverture de fichier 1 Mo, `cat` 10 Mo, 50 000 caractères en flux ; résultats dans `e2e/artifacts/perf.json`.
- `apps/desktop/e2e/perf-baseline.json` versionné par plateforme CI ; échec si médiane > base × 1,25 sur le job Linux ; informatif sur Windows et macOS jusqu'à trois runs stables ; la base ne se met à jour que par une PR qui l'explique.
- `scripts/check-bundle-size.mjs` : tailles gzip par chunk contre les budgets de 7.1 ; échec dur.
- Profil : `contentTracing` d'Electron activable par `NOVA_TRACE_STARTUP=1` (développement uniquement, ignoré empaqueté comme les autres variables, `security-policy.ts`).
- Chaque budget est reporté dans `STATUS.md` avec la commande et le résultat (règle du dépôt).

---

## 8. Réglages

### 8.1 Une source de vérité

`packages/shared/src/settings-registry.ts` : pour chaque réglage, `{ id, section, title, description, keywords, kind, scope, default, schema }` où `schema` est le sous-schéma zod déjà présent (`SettingsPatchSchema`) — le registre **dérive** de `AppSettings`, il ne le duplique pas (typage `satisfies`). Il alimente : l'interface (contrôles par `kind` : `switch`, `segmented`, `select`, `number`, `text`, `keybinding`, `json`), la recherche, le préfixe `,` de la palette, le schéma JSON de l'éditeur expert (`z.toJSONSchema` de zod 4), l'export/import, la documentation générée (`docs/reference/settings.md`, à créer par script).

### 8.2 Recherche

Champ de recherche en tête de `SettingsView` (`Ctrl+F` dans les réglages, ou saisie directe après `Ctrl+,`), insensible aux accents, sur titre + description + mots-clés + section ; résultats groupés par section avec fil d'Ariane ; `openSettings(section, settingId)` fait défiler et met en évidence le réglage (`:target`-like, 2 s, sans animation en mouvement réduit). Les réglages modifiés portent une pastille « modifié » et une action « Rétablir ».

### 8.3 JSON pour les experts

- « Modifier en JSON » (bouton en tête de Réglages, palette « Réglages : ouvrir en JSON ») : onglet du plan de travail avec CM6 (`@codemirror/lang-json`) + `codemirror-json-schema` (MIT) pour la complétion et la validation contre le schéma dérivé ; le document est l'objet `AppSettings` courant (les secrets n'y sont jamais : la clé vit dans le coffre, ADR-004).
- Enregistrer = diff objet → `settings.update(patch)` ; erreurs de validation zod affichées à la ligne fautive (`lint` CM6) ; rien n'est écrit si invalide.
- Même mécanisme pour `keybindings` (tableau `{ keys, command, when }`, complétion des identifiants de commandes depuis le registre) et pour les dispositions.
- Pas de fichier `settings.json` sur disque (ADR-003 : l'état produit est en SQLite) ; **export/import** `nova-settings.json` comme artefact nommé (menu et palette), secrets exclus, version de schéma incluse, import validé et prévisualisé (« 3 réglages changent »).

### 8.4 Prêt pour la synchronisation

- Chaque clé porte `scope` : `user` (thème, keymap, éditeur), `workspace` (mode de travail, contrat, disposition), `machine` (clé de coffre, dossier de données, zoom, accélération). Seul `user` et `workspace` seraient synchronisables ; `machine` jamais.
- Table `settings` étendue avec `updated_at` par clé (schéma : accord explicite) ; règle de fusion « dernière écriture gagne » par clé ; aucune synchronisation n'est activée ni codée avant J5 (`PRODUCT.md` : rien de distant par défaut).
- La section Raccourcis devient générée : liste de toutes les commandes, filtre, réaffectation en place (capture de touche avec détection de conflit et affichage du `when`), « Rétablir le profil ».

---

## 9. Checklist d'implémentation priorisée

P0 = prérequis ou correctif d'un défaut constaté ; P1 = J2 ; P2 = J2 fin / J3 ; P3 = J3+. Chaque ligne cite les fichiers.

### P0 — socle (avant ou avec le début de J2)

- [ ] **Nonce CSP par chargement** : `apps/desktop/src/main/renderer-assets.ts` (`RENDERER_CSP` → fonction avec nonce, injection `<meta name="nova-csp-nonce">` et `data-theme`/`backgroundColor` selon le thème), `main/protocol.ts`, tests `renderer-assets.test.ts` ; `renderer/lib/csp.ts` (`readCspNonce()`).
- [ ] **Registre de commandes et résolveur de keymap** : `renderer/commands/{registry,context,when}.ts`, `renderer/commands/builtin/{app,conversation,model,settings,view,focus,a11y}.ts`, `renderer/keymap/{resolve,format,profiles/nova,profiles/vscode}.ts` ; `App.tsx` : `useGlobalShortcuts` → `useKeymap` ; `lib/platform.ts` : `getLayoutMap`, libellés ; `packages/ui` `Kbd` accepte un libellé généré ; tests unitaires (AZERTY simulée) ; E2E scénario 15 inchangé et vert.
- [ ] **Palette pilotée par le registre** : `components/palette/CommandPalette.tsx` (groupes générés, récents, indisponibles avec raison, « Demander à Nomi »), `components/palette/pages/{ListPage,TextPage,ConfirmPage}.tsx` ; préfixes `>` `,` `?` ; MRU dans `settings` (`ui.palette.recent`).
- [ ] **Announcer** : `renderer/a11y/announcer.ts`, régions dans `App.tsx`, migration de `OutcomeAnnouncer`, `CodeBlock`, `RefusedLink`, `Composer` (« Message envoyé » non — silence), tests `announcer.test.ts`.
- [ ] **Zoom** : canal `nova:view:zoom` (`packages/shared/src/{channels,ipc}.ts`, `main/ipc-routes.ts`), réglage `appearance.zoom` (schéma : accord), commandes `view.zoom*`, menu macOS (`main/menu.ts`, rôles + zoom), E2E 200 %.
- [ ] **Flux linéaire** : `components/chat/Markdown.tsx` par blocs mémorisés ; `state/store.ts` tampon de `delta` vidé par `requestAnimationFrame` ; test de non-régression (50 000 caractères : nombre de rendus de `Markdown` borné).
- [ ] **Réveils** : `NomiDock.tsx` `useNow(1000)` conditionnel ; `lib/hooks.ts` `useMinuteTick` partagé ; test « aucun timer actif au repos ».
- [ ] **Menu d'application** : `main/menu.ts` (macOS : rôles ; Windows/Linux : `null` + `autoHideMenuBar`), `main/index.ts`.
- [ ] **Perf : mesure de démarrage** : `main/startup-trace.ts`, marks renderer dans `main.tsx`/`App.tsx`, affichage dans `SettingsView.tsx` › Diagnostics, `e2e/perf.spec.ts` (démarrage seul), `perf-baseline.json`, `scripts/check-bundle-size.mjs`.
- [ ] **Docs** : ADR-012 à ADR-017 (section 10), `DESIGN_SYSTEM.md` (raccourcis, HC), `STATUS.md`.

### P1 — J2 : éditeur, plan de travail, revue

- [ ] **Chunk éditeur** : `renderer/editor/{create,theme,keymap,large-files,agent-caret}.ts`, `components/editor/EditorTab.tsx` ; `@codemirror/*` + `@codemirror/language-data` + `@replit/codemirror-vim`/`-emacs` (lazy) ; réglages éditeur dans le registre ; tests contraste syntaxe.
- [ ] **Dockview** : spike 2 jours (critères 3.3), puis `components/layout/Workbench.tsx` (dockview dans `Panel id="center"`), `packages/ui` `Tabs`/`Tab` (tablist accessible, utilisés comme `tabComponent`), commandes `tabs.*`, `layout.*`, `panel.goTo`, persistance `workspace_layouts` (migration J2, accord), presets.
- [ ] **Modification en ligne** : `renderer/editor/inline-edit/{panel,request,preview}.ts` (`showPanel`, `unifiedMergeView`), canal `nova:agent:inline-edit` (schéma), commandes `agent.inlineEdit`, `review.*` ; E2E avec le faux serveur (proposition, `F7`, `Ctrl+Entrée`).
- [ ] **Revue** : `renderer/review/model.ts` + `components/review/{ReviewView,FileDiff,ReadingMode}.tsx` (`MergeView`/`unifiedMergeView`), touches simples, mode lecture, blocs « à toi » (scénario 5).
- [ ] **Ouverture rapide** : `renderer/workers/file-index.worker.ts`, canal `nova:workspace:files` (+ deltas), page `@`, tri, aperçu ; `quickOpen.symbols` via LSP/Lezer.
- [ ] **LSP** : `main/services/lsp-host.ts` (`utilityProcess` par langage), canal `nova:lsp:*`, `renderer/editor/lsp-transport.ts` (`@codemirror/lsp-client`), bannière d'installation explicite.
- [ ] **Terminal** : `main/services/pty-host.ts` (`utilityProcess`, `node-pty`), `MessagePort`, contrôle de flux ; `renderer/terminal/{create,shell-integration,blocks,keys}.ts`, `components/terminal/{TerminalPanel,BlockList}.tsx` ; scripts `apps/desktop/resources/shell-integration/{bash,zsh,fish,pwsh}` ; commandes `terminal.*` ; E2E : `false` → décoration danger, `Ctrl+↑` ; vérification WebGL/CSP au spike.
- [ ] **Suivi de l'agent, chronologie, approbations** : événements `mission.cursor`, `components/mission/{Timeline,StepSnapshot,ApprovalCard}.tsx`, commandes `agent.follow`, `timeline.*`, `approval.*`, `mission.rerunFrom` (dialogue avec coût), virtualisation `@tanstack/react-virtual`.
- [ ] **A11y J2** : modes lecteur d'écran (éditeur, terminal, diff), `AppInfo.accessibilitySupport` + événement, thèmes HC + `forced-colors` (`packages/ui/src/styles/tokens.css`, `tokens.ts`, `contrast.test.ts`), aide `Alt+F1`, E2E `a11y.spec.ts` étendu, `keyboard.spec.ts`, scripts manuels joués sur Linux (Orca) et consignés.
- [ ] **Perf J2** : `perf.spec.ts` étendu (fichier 1 Mo, `cat` 10 Mo, flux), budgets mesurés et reportés dans `STATUS.md`, virtualisation du fil, du catalogue et de la liste des conversations, pagination `conversations.list`.

### P2 — J2 fin / J3

- [ ] Réglages : `packages/shared/src/settings-registry.ts`, recherche dans `SettingsView.tsx`, préfixe `,`, JSON expert (`components/settings/SettingsJson.tsx`, `codemirror-json-schema`), export/import, section Raccourcis générée avec réaffectation, `updated_at` par clé (accord).
- [ ] Profils Vim/Emacs hors éditeur (listes, palette `vimBindings`), barre d'état du mode.
- [ ] `terminal.explainFailure`, `terminal.generateCommand` (carte « Ce qui sera envoyé », `redactSecrets`), historique `terminal_commands` (accord).
- [ ] Guidepup sur runners Windows/macOS (informatif).
- [ ] « Lecture facilitée » appliquée à l'éditeur et au terminal (UX.md 10.5).

### P3 — J3+

- [ ] Commandes enregistrées par les extensions/skills (préfixe imposé, `when` restreint).
- [ ] Recherche plein texte des conversations (FTS5, accord de schéma) si la recherche `LIKE` actuelle dépasse 100 ms sur 10 000 messages.
- [ ] Synchronisation des portées `user`/`workspace` (J5, jamais par défaut).

---

## 10. Décisions à consigner (ADR) et questions

Propositions d'ADR (format de `DECISIONS.md`), à accepter avant implémentation ; chaque nouvelle dépendance rejoint le tableau « Dépendances et justification ».

| ADR | Sujet | Contenu |
| --- | --- | --- |
| ADR-012 | CodeMirror 6 pour l'éditeur | Section 3.1 ; dépendances `@codemirror/{state,view,language,commands,search,autocomplete,lint,merge,lsp-client,language-data,lang-json}`, `@replit/codemirror-{vim,emacs}`, `codemirror-json-schema` ; provenance (dépôts déplacés hors GitHub, paquets npm inchangés, délai ADR-009) |
| ADR-013 | Nonce CSP par chargement dans `nova://` | Section 3.2 ; `pnpm dev` inchangé ; Shadow DOM en repli |
| ADR-014 | Terminal : xterm.js + WebGL obligatoire, `node-pty` en `utilityProcess` | Exception unique à « aucun module natif » (ADR-002) : binaires précompilés épinglés, empreinte vérifiée ; option « isolation des styles réduite pour le terminal » désactivée par défaut ; dépendances `@xterm/{xterm,addon-webgl,addon-fit,addon-search,addon-unicode11,addon-serialize,addon-clipboard}`, `node-pty` |
| ADR-015 | dockview pour le plan de travail, `react-resizable-panels` pour la coque | Section 3.3 ; FlexLayout en repli ; fenêtres détachées désactivées |
| ADR-016 | Keymap : profils, pas d'accords chronométrés, résolution `key`/`code`, `Ctrl+K` contextuel | Section 2 ; surcharges JSON |
| ADR-017 | Virtualisation et flux | `@tanstack/react-virtual` ; Markdown par blocs ; regroupement 50 ms ; budgets de la section 7 |

Changements de schéma SQLite à faire accepter explicitement : `workspace_layouts`, `terminal_commands`, `settings.updated_at`, extension de `theme`/`appearance.zoom`/`keymap`/`a11y` dans `SettingsPatchSchema`.

Questions pour le propriétaire (en plus de Q1–Q8 et UX-1–UX-8) :

| # | Question | Proposition |
| --- | --- | --- |
| PX-1 | `Ctrl+K` contextuel (palette / modification en ligne / commande terminal) ou palette partout et `Ctrl+I` pour l'agent partout ? | Contextuel (une règle « agir ici »), `Ctrl+Maj+P` et `F1` toujours palette |
| PX-2 | Autoriser l'option « isolation des styles réduite pour le terminal » (repli sans WebGL) ? | Oui, désactivée par défaut, décrite dans `SECURITY.md` |
| PX-3 | Exception module natif pour `node-pty` (ADR-002) ou binaire compagnon (Rust/Go) qui expose un PTY par socket ? | `node-pty` précompilé (simplicité, maturité) ; réexaminer si l'empaquetage multi-OS échoue |
| PX-4 | Enregistrement automatique par défaut après 1 s ? | Oui (l'agent et l'utilisateur écrivent le même disque ; réduit les conflits) |
| PX-5 | Dupliquer la ligne sans raccourci direct (AZERTY) ? | Palette + `Ctrl+Maj+Entrée` sans sélection |
| PX-6 | Guidepup en CI : runners hébergés (VoiceOver, NVDA) suffisent-ils ? | Essai informatif en J2 |

---

## 11. Écarts avec UX.md et VISUAL.md

| Point | UX.md / VISUAL.md | Ici | Raison |
| --- | --- | --- | --- |
| Focus terminal | `` Ctrl+` `` ; sortie `` Ctrl+Maj+` `` (UX.md 10.1) | `Ctrl+J` (dock) / `Ctrl+3` (terminal) ; sortie `F6` ou `Ctrl+M` | `` ` `` est une touche morte `AltGr+7` sur AZERTY |
| Nouveau terminal | `` ⌘⇧` `` (VISUAL.md 4.5) | `Ctrl+Maj+J` / `⇧⌘J` | idem |
| Panneau Agent | `⌘/Ctrl+J` (VISUAL.md 3) | `Ctrl+I` ; `Ctrl+J` = dock | `Ctrl+J` = panneau du bas chez VS Code ; `Ctrl+I` = agent chez Cursor et VS Code |
| Bascule converse ↔ build | `⌘/Ctrl+Maj+L` (VISUAL.md 3) | `Ctrl+Maj+D` | `Ctrl+Maj+L` = toutes les occurrences dans l'éditeur ; `Ctrl+L` = conversation |
| Onglets du panneau de travail | `Ctrl+1…6` fixes (UX.md 10.1) | `Ctrl+[1…9]` panneaux nommés stables (9 entrées), `Alt+[1…9]` onglets | Même idée, étendue au dock et aux groupes ; numéros stables |
| Préfixes de palette | `>` `@` `#` `/` (UX.md 4.5) ; pied « `#` symboles » (VISUAL.md 4.9) | `>` `@` fichiers `#` missions `/` `:` `.` symboles `,` `?` | UX.md fait foi pour `@`/`#` ; VISUAL.md 4.9 à corriger (`.` symboles) |
| Appui pour parler | `Ctrl+Espace` (UX-5) | `Ctrl+Espace` hors éditeur et terminal (complétion dans l'éditeur) | Conflit avec la complétion |
| Annonce longue génération | toutes les 30 s (UX.md 10.2) | conservé, plus option « lire au fil de l'eau » par phrases | Ajout |
| Diff : touches | `j k a r o Entrée` (UX.md 10.1) | idem + `n p J K A R u l s`, `F7` depuis l'éditeur | Ajout, sans `[`/`]` |
| Approbation : `Échap` = refuser | UX.md 10.1 | conservé ; focus déplacé seulement si l'utilisateur ne tape pas | Précision 3.2.x |

*Fin du document. Les raccourcis et commandes de ce document sont destinés à être générés depuis le registre (section 2.4) ; toute divergence entre ce document et `renderer/keymap/profiles/nova.ts` se règle en faveur du code, puis ce document est mis à jour.*
