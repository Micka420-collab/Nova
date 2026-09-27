# NOVA — Direction visuelle et design de l'atelier

`docs/design/VISUAL.md` · Proposition de la voie design, 2026-09-27 · Statut : **à valider par le propriétaire**, puis reporter les valeurs retenues dans `packages/ui` (le code fait foi) et dans `DESIGN_SYSTEM.md` (« Tokens validés »).

Périmètre : toute l'interface de NOVA telle qu'elle devient — éditeur de code complet, agent autonome (fichiers, terminal, web, MCP) et compagnon Nomi qui agit. Ce document part de l'existant (tokens `--nv-*`, coque à trois zones, composants de `packages/ui`, marque « ruban jade », Nomi « cairn ») et le prolonge ; il ne le remplace pas. Tout ce qui est chiffré ici (px, hex, ms, ratios) est une valeur cible à intégrer, pas une décoration.

---

## 0. Ce que l'on a vu, et ce qui doit changer

Les captures E2E (`apps/desktop/e2e/artifacts/screens/`) montrent une base saine : coque nav / centre / contexte, thème Papier minéral, lockup à 20 px, Nomi à 44 px dans le dock, avis d'erreur en callout, usage sous chaque réponse, contexte de confidentialité visible. Ce qui manque pour un atelier de code :

| Constat | Conséquence design |
| --- | --- |
| Le centre est un fil de discussion pleine largeur (760 px) ; le panneau droit est un « Contexte » textuel. | L'atelier a besoin d'un **plan de travail** (éditeur, diff, aperçu, carte) et d'un **panneau Agent** (fil + journal d'outils) qui coexistent. |
| Une seule surface de profondeur : `bg` centre, `panel` côtés. | Il faut une échelle d'élévation explicite (surface enfoncée pour l'éditeur et le terminal, surfaces flottantes pour palette, menus, toasts). |
| Pas de palette de syntaxe, pas de diff, pas de terminal. | Nouveaux tokens code / diff / ANSI, contrastes calculés. |
| Une seule densité. | Deux densités (compacte, confortable) sur les mêmes composants. |
| Orbite utilisée pour le curseur de flux et les boutons occupés. | Étendre la signature aux onglets, nœuds de mission, sessions de terminal, cartes d'outil — avec une règle de « foyer unique ». |
| Nomi vit dans un dock 44 px en bas de la navigation. | Nomi doit apparaître partout où l'agent agit (en-tête du panneau Agent, barre d'état, cartes d'approbation), sans devenir décoratif. |

---

## 1. Principes de design

1. **Le travail occupe l'espace.** Le code, le diff, l'aperçu et les preuves sont au premier plan ; le chrome se tient à 1 px de bordure et à un cran de valeur. Aucun panneau ne dépasse 12 % de luminosité d'écart avec son voisin, sauf les surfaces flottantes.
2. **Mat, minéral, calme.** Aucune surface n'est transparente ni brillante ; profondeur par valeur de gris et par ombre courte, jamais par flou. Pas de dégradé de marque, pas de néon, pas de verre. Le jade est un accent rare : actions principales, focus, orbite active, texte de lien. Sur un écran d'atelier chargé, moins de 3 % des pixels sont jade.
3. **Un état réel, un signal.** Une animation ne se produit que si le runtime rapporte une activité (phase de flux, mission, processus). Rien ne bouge au repos — ni orbite, ni squelette, ni Nomi (hors respiration idle, désactivable).
4. **Preuves avant promesses.** Toute assertion (« tests passés », « 3 fichiers modifiés ») est un élément cliquable qui ouvre sa preuve : sortie de terminal, diff, capture. La citation (`app.ts:42`) est un composant de première classe.
5. **Inconnu se lit « inconnu ».** Jamais 0, jamais une barre pleine par défaut, jamais une jauge de budget sans son plafond et sa part réservée.
6. **Deux densités, une logique.** Créer (confortable) et Expert (compact) partagent les composants ; la densité change hauteurs, tailles de police et quantité d'information, jamais la hiérarchie.
7. **Clavier d'abord.** Tout ce que la souris fait, la palette et les raccourcis le font ; toutes les poignées de redimensionnement sont focusables ; le focus est un anneau 2 px jade, toujours visible.
8. **Accessible par construction.** AA sur toutes les paires réellement utilisées (calcul dans `packages/ui/src/contrast.ts`, paires assertées dans `contrast.test.ts`). Couleur jamais seule porteuse d'information ; chaque état a un mot.
9. **Le compagnon est un collègue, pas une mascotte.** Nomi montre ce qu'il fait, demande quand il doit, se tait sinon. Il n'a ni score, ni cœur, ni notification d'attention.
10. **Une seule façon de faire chaque chose.** Un composant par concept, une couleur par sens, un raccourci par action. Si deux composants se ressemblent, l'un disparaît.

---

## 2. Système de tokens évolué

Conventions : préfixe `--nv-`, thème par `data-theme` sur `<html>`, densité par `data-density="comfortable" | "compact"` sur `<html>`, mouvement par `data-motion`. Les valeurs existantes restent ; les nouvelles sont marquées **(nouveau)**. Les ratios de contraste ci-dessous sont **calculés** (formule WCAG 2.x, même code que `contrast.ts`), pire cas parmi les surfaces indiquées.

### 2.1 Surfaces et élévation

Six niveaux, du plus enfoncé au plus flottant. La profondeur se lit par la valeur ; l'ombre n'apparaît qu'à partir de E4.

| Niveau | Token | Nuit minérale | Papier minéral | Usage |
| --- | --- | --- | --- | --- |
| E0 sunken | `--nv-editor-bg` **(nouveau)** | `#0D1215` (= `field`) | `#FBFAF5` | Éditeur, diff, blocs de code du fil |
| E0 sunken | `--nv-terminal-bg` **(nouveau)** | `#0A0E10` | `#F7F5EE` | Terminal, sorties de processus |
| E1 base | `--nv-bg` | `#111619` | `#F5F3EC` | Fond de l'application, plan de travail |
| E2 panel | `--nv-panel` | `#192226` | `#EEEBE3` | Navigation, panneau Agent, barres d'onglets, dock |
| E3 raised | `--nv-raised` | `#243035` | `#FFFFFF` | Cartes, lignes sélectionnées, bulles utilisateur |
| E4 floating | `--nv-raised` + `--nv-shadow-raised` | idem | idem | Menus, palette, toasts, popovers |
| E5 overlay | `--nv-overlay` | `rgb(6 9 10 / 0.62)` | `rgb(23 35 40 / 0.36)` | Voile derrière un dialogue |

Surfaces annexes **(nouveau)** :

| Token | Nuit | Papier | Usage |
| --- | --- | --- | --- |
| `--nv-line-highlight` | `#141B1F` | `#F1EFE7` | Ligne courante de l'éditeur (1,08:1 et 1,10:1 vs éditeur : volontairement subtil, non porteur d'information) |
| `--nv-statusbar-bg` | `#0F1417` | `#EEEBE3` | Barre d'état 24 px |
| `--nv-text-muted` | `#8C9EA0` | `#556668` | Texte tertiaire : commentaires, numéros de ligne inactifs, méta. Pire cas **4,85:1** (nuit, sur `raised`) et **5,06:1** (papier, sur `panel`) |
| `--nv-gutter-fg` | `#7A8B8E` | `#5F7073` | Numéros de ligne. **5,30:1** / **4,96:1** sur l'éditeur |
| `--nv-indent-guide` | `#2A363B` (= `border`) | `#DDD8CC` | Guides d'indentation, décoratifs |

Ombres (inchangées, valeurs relevées) : `--nv-shadow-raised` nuit `0 1px 2px rgb(0 0 0 / 0.28), 0 10px 28px rgb(0 0 0 / 0.32)` ; papier `0 1px 2px rgb(23 35 40 / 0.06), 0 10px 28px rgb(23 35 40 / 0.1)`. Ajouter **(nouveau)** `--nv-shadow-popover` : nuit `0 1px 2px rgb(0 0 0 / 0.3), 0 6px 16px rgb(0 0 0 / 0.28)` ; papier `0 1px 2px rgb(23 35 40 / 0.06), 0 6px 16px rgb(23 35 40 / 0.08)` pour les menus (plus courte que celle des dialogues).

Bordures : `--nv-border` (séparateurs, 1 px) et `--nv-border-strong` (contrôles ; 3,57:1 nuit, 3,24:1 papier, ≥ 3:1). Règle : un panneau se sépare de son voisin par **1 px `border`**, jamais par une ombre.

### 2.2 Couleurs sémantiques (relevé + ajouts)

Existant, inchangé : `accent` `#86D8BB` / `#216B56` (8,10:1 / 5,34:1), `amber` `#EEC181` / `#7D5310` (8,12 / 5,66), `danger` `#F18A8A` / `#B3261E` (5,64 / 5,49), `info` `#9CC7D6` / `#2B6076` (7,46 / 5,80), `focus` = `accent`, `selection` `#2F5E50` / `#BFE3D4` (texte dessus 6,74 / 11,59), variantes `*-soft`, `*-hover`, `on-accent`, `on-danger`.

Paires vérifiées pour les nouveaux composants : accent sur `accent-soft` **7,40:1** / **5,32:1** (rail actif, chips) ; info sur `info-soft` **7,53:1** / **5,74:1** (chips de citation) ; amber sur `amber-soft` **7,75:1** / **5,57:1** (approbations) ; danger sur `danger-soft` **5,91:1** / **5,25:1** (nœud échoué).

**Diff (nouveau)** — fonds de ligne, texte coloré, gouttière, surlignage mot à mot :

| Token | Nuit | Papier | Contraste vérifié |
| --- | --- | --- | --- |
| `--nv-diff-add-bg` | `#132A23` | `#DFF0E6` | texte principal dessus 13,83 / 13,57 |
| `--nv-diff-add-fg` | `#A9E4CC` | `#1B5A47` | sur add-bg 10,60 / 6,82 |
| `--nv-diff-add-word` | `#1E4A3B` | `#C4E6D4` | texte 9,12 / 11,94 ; add-fg 6,99 / 6,01 |
| `--nv-diff-del-bg` | `#33191C` | `#F9E1DF` | texte 14,75 / 12,90 |
| `--nv-diff-del-fg` | `#F3A9A9` | `#9C1F18` | sur del-bg 8,53 / 6,43 |
| `--nv-diff-del-word` | `#4A2528` | `#F4C6C2` | texte 12,06 / 10,48 ; del-fg 6,97 / 5,22 |
| `--nv-diff-mod-bg` | `#302A19` | `#F6E8D0` | texte 13,01 / 13,29 |
| `--nv-diff-mod-fg` | `#EEC181` | `#7D5310` | sur mod-bg 8,55 / 5,57 |
| gouttière `+` / `−` | `accent` / `danger` | idem | 9,08 et 6,74 (nuit), 5,37 et 5,25 (papier), ≥ 3:1 |

Toutes les couleurs de syntaxe (§2.3) restent ≥ 4,5:1 sur `add-bg` et `del-bg` (pire cas : commentaire papier sur del-bg **4,84:1**). Une ligne de diff est donc colorée syntaxiquement *et* teintée sans perte de lisibilité.

**Recherche / appariement (nouveau)** : `--nv-match-bg` `#4A3F1E` / `#F3E3B4` (texte 9,47 / 12,59), `--nv-match-current-bg` `#6B5A2A` / `#E9CF82` (texte 6,13 / 10,49), `--nv-bracket-bg` `#24433A` / `#CFE9DC` (texte 9,87 / 12,50), `--nv-word-highlight` `#1E2C31` / `#F1EFE7`.

### 2.3 Palettes de syntaxe

Principe : **mêmes familles minérales que l'interface** — jade pour ce qui s'appelle (fonctions), ambre pour ce qui est littéral (chaînes), glacier pour les nombres, sable pour la structure (mots-clés), sauge pour les types, cuivre pour les balises. Saturation basse, pas de violet, pas de rose. Le texte « plain » reste le texte principal ; commentaires en `text-muted`.

Contrastes calculés sur **six surfaces** (éditeur, terminal, bg, panel, raised, ligne courante) ; le pire cas est indiqué. Seuil : 4,5:1 partout, commentaires compris.

| Rôle (tag Lezer) | Token | Nuit minérale | pire cas | Papier minéral | pire cas |
| --- | --- | --- | --- | --- | --- |
| Texte, variables | `--nv-syn-plain` | `#F2F5F3` | 12,35 | `#172328` | 13,48 |
| Mots-clés, modificateurs | `--nv-syn-keyword` | `#D9C3A3` | 7,93 | `#7A4A12` | 6,26 |
| Fonctions, méthodes | `--nv-syn-function` | `#86D8BB` | 8,10 | `#216B56` | 5,34 |
| Chaînes, templates | `--nv-syn-string` | `#EEC181` | 8,12 | `#7D5310` | 5,66 |
| Nombres, unités | `--nv-syn-number` | `#9CC7D6` | 7,46 | `#2B6076` | 5,80 |
| Types, classes, interfaces | `--nv-syn-type` | `#B7D2A8` | 8,26 | `#4A6A2A` | 5,21 |
| Propriétés, attributs d'objet | `--nv-syn-property` | `#D5DFDB` | 9,95 | `#33474C` | 8,21 |
| Opérateurs, ponctuation | `--nv-syn-operator` | `#ABB9BB` | 6,71 | `#4B5A5D` | 6,04 |
| Commentaires | `--nv-syn-comment` | `#8C9EA0` | 4,85 | `#556668` | 5,06 |
| Constantes, booléens, `null` | `--nv-syn-constant` | `#EBA79A` | 6,79 | `#9A3B2E` | 5,80 |
| Balises HTML/JSX | `--nv-syn-tag` | `#E1AE8F` | 6,88 | `#9A4A22` | 5,22 |
| Attributs de balise | `--nv-syn-attribute` | `#D9C3A3` | 7,93 | `#7A4A12` | 6,26 |
| Regex, échappements | `--nv-syn-regex` | `#C5D69B` | 8,69 | `#556B1E` | 5,02 |
| Invalide | `--nv-syn-invalid` | `#F18A8A` + soulignement ondulé | 5,64 | `#B3261E` | 5,49 |

Règles d'application :

- Curseur : 2 px `accent` (11,26:1 nuit, 6,09:1 papier sur l'éditeur) ; pas de clignotement sous `data-motion="reduce"`.
- Sélection : `selection` ; occurrences du mot sous le curseur : `word-highlight`.
- Diagnostics : soulignement ondulé 1,5 px `danger` (erreur), `amber` (avertissement, 11,29:1), `info` (indication) ; jamais de fond de ligne pour un diagnostic (le fond est réservé au diff).
- Un seul moteur de coloration pour l'éditeur **et** les blocs de code du fil (Lezer / `@lezer/highlight` via des classes `nv-syn-*`), pour que la même palette s'applique partout. Préflight solutions existantes : CodeMirror 6 (léger, thème en CSS, facette `EditorView.cspNonce` compatible avec la CSP sans styles injectés) plutôt que Monaco ; à confirmer par un essai réel dans le renderer.

### 2.4 Palette ANSI du terminal

Terminal sur `--nv-terminal-bg` ; texte par défaut `--nv-text`. Toutes les couleurs de premier plan ≥ 4,5:1 sur le fond du terminal.

| Index | Nom | Nuit | ratio | Papier | ratio |
| --- | --- | --- | --- | --- | --- |
| 0 | black | `#243035` (fond seulement) | — | `#172328` | 14,72 |
| 1 | red | `#F18A8A` | 8,07 | `#B3261E` | 5,99 |
| 2 | green | `#86D8BB` | 11,59 | `#216B56` | 5,83 |
| 3 | yellow | `#EEC181` | 11,61 | `#7D5310` | 6,18 |
| 4 | blue | `#9CC7D6` | 10,67 | `#2B6076` | 6,34 |
| 5 | magenta | `#D9B8CF` | 10,81 | `#7B4B70` | 6,24 |
| 6 | cyan | `#8FD3D3` | 11,47 | `#1F6A6A` | 5,78 |
| 7 | white | `#D5DFDB` | 14,22 | `#4B5A5D` | 6,59 |
| 8 | bright black | `#8C9EA0` | 6,94 | `#556668` | 5,52 |
| 9 | bright red | `#F5A3A3` | 9,83 | `#9C1F18` | 7,34 |
| 10 | bright green | `#9FE2CA` | 13,11 | `#1A5A48` | 7,40 |
| 11 | bright yellow | `#F3D3A3` | 13,53 | `#6A4407` | 7,88 |
| 12 | bright blue | `#B4D7E3` | 12,71 | `#215064` | 8,03 |
| 13 | bright magenta | `#E6CCDD` | 12,97 | `#663A5C` | 8,28 |
| 14 | bright cyan | `#A8E0E0` | 13,30 | `#185858` | 7,47 |
| 15 | bright white | `#F2F5F3` | 17,66 | `#172328` | 14,72 |

L'index 0 en nuit est un fond (1,43:1 en premier plan) : configurer xterm.js avec `minimumContrastRatio: 4.5`, qui rehausse automatiquement tout premier plan trop faible, y compris les couleurs 256/truecolor envoyées par les programmes. Curseur : `accent` (11,59 / 5,83). Sélection : `selection`.

### 2.5 Rayons

Échelle inchangée, avec une attribution stricte **(nouveau)** :

| Token | Valeur | Attribué à |
| --- | --- | --- |
| `--nv-radius-xs` | 6 px | Badges, code inline, chips de gouttière, poignées |
| `--nv-radius-sm` | 10 px | Boutons, champs, lignes de liste, onglets (coins hauts seulement) |
| `--nv-radius-md` | 12 px | Cartes d'outil, callouts, blocs de code, toasts |
| `--nv-radius-lg` | 16 px | Composer, cartes d'accueil, dialogues, palette |
| `--nv-radius-pill` | 999 px | Pills de statut, chips de citation, jauge |
| `--nv-radius-none` **(nouveau)** | 0 | Éditeur, terminal, arbre, diff : les surfaces de travail plein-cadre n'ont pas de rayon |

### 2.6 Espacement

Échelle 4 · 8 · 12 · 16 · 24 · 32 · 48 inchangée. Ajouts **(nouveau)** : `--nv-space-0-5: 2px` (séparation de lignes de liste, épaisseur de guide) et `--nv-space-8: 64px` (marges de la page d'accueil et de l'onboarding en écran large). Largeur de lecture du fil : 760 px (relevé) ; en panneau Agent latéral, le fil prend la largeur du panneau moins 2 × 16 px.

### 2.7 Densités

Deux densités sur `<html data-density>` ; « confortable » est le défaut du mode Créer, « compacte » celui du mode Expert (chacune reste réglable). Les tokens ci-dessous sont **(nouveau)** ; les composants n'utilisent jamais de hauteur littérale.

| Token | Confortable | Compacte | Concerne |
| --- | --- | --- | --- |
| `--nv-control-sm` | 30 px | 28 px | Boutons sm, chips |
| `--nv-control-md` | 36 px | 32 px | Boutons, champs |
| `--nv-row` | 32 px | 26 px | Lignes de liste, palette |
| `--nv-tree-row` | 28 px | 24 px | Arbre de fichiers |
| `--nv-tab-h` | 36 px | 32 px | Onglets d'éditeur, dock |
| `--nv-code-size` | 13 px | 12,5 px | Éditeur, diff, terminal |
| `--nv-code-line` | 20 px | 18 px | Hauteur de ligne de code |
| `--nv-diff-line` | 20 px | 18 px | Lignes de diff |
| `--nv-panel-pad` | 16 px | 12 px | Marges internes des panneaux |
| `--nv-list-gap` | 4 px | 2 px | Entre lignes |
| `--nv-statusbar-h` | 24 px | 22 px | Barre d'état |

La densité ne change ni les rayons, ni les couleurs, ni les tailles d'icônes (16 px).

### 2.8 Mouvement

| Token | Valeur | Usage |
| --- | --- | --- |
| `--nv-duration-fast` | 120 ms | Survol, focus, bascule d'onglet, chip |
| `--nv-duration-base` | 180 ms | Ouverture de menus, popovers, dépliage d'une carte d'outil |
| `--nv-duration-slow` | 220 ms | Panneaux, changement de pose de Nomi, toasts (entrée) |
| `--nv-duration-exit` **(nouveau)** | 100 ms | Toute sortie (menus, toasts, dialogues) : on disparaît plus vite qu'on n'apparaît |
| `--nv-duration-orbit` **(nouveau)** | 1 600 ms | Un tour d'orbite « travaille » (aligné sur `nv-orbit-spin` et Nomi `working`) |
| `--nv-duration-orbit-slow` **(nouveau)** | 4 200 ms | Un tour « réfléchit » (Nomi `thinking`) |
| `--nv-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Transitions courantes |
| `--nv-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrées |
| `--nv-ease-in` **(nouveau)** | `cubic-bezier(0.4, 0, 1, 1)` | Sorties |

Règles : transitions sur `transform`, `opacity`, `background-color`, `border-color`, `color` uniquement (jamais `height`/`width` animés ; utiliser `grid-template-rows: 0fr → 1fr` pour les dépliages). `data-motion="reduce"` : tout à 0 ms, poses statiques distinctes (déjà en place dans `base.css`).

### 2.9 Iconographie

- Jeu unique : lucide-react (dans `@nova/ui`) ; le renderer garde ses icônes inline (`icons.tsx`) uniquement pour les cas non couverts, dessinées sur la même grille 24, trait 2 px, bouts ronds.
- Tailles : 16 px (contrôles, lignes), 14 px (chips, badges), 20 px (rail de navigation, en-têtes), 12 px (gouttière de diff, citation inline).
- Couleur : `currentColor` ; `text-secondary` au repos, `text` au survol/actif, jamais `accent` sauf pour un état actif (rail) ou une action principale.
- Icônes de type de fichier : **monochromes**, dérivées d'une liste courte (code, style, données, image, document, config, test, verrou) — pas de logos de langages colorés, qui casseraient la palette.
- Tout bouton-icône porte un `aria-label` ; toute icône seule dans un texte est décorative.

### 2.10 Typographie

Interface Manrope (variable, embarquée) ; code JetBrains Mono (variable, embarquée — vérifier la présence du fichier dans `packages/ui/assets/fonts`, seul `Manrope-wght.ttf` y est aujourd'hui).

| Token | Taille | Interligne | Graisse | Usage |
| --- | --- | --- | --- | --- |
| `--nv-text-2xs` **(nouveau)** | 11 px | 1,25 | 560 | Numéros de ligne compacts, en-têtes de gouttière, `@@` de hunk |
| `--nv-text-xs` | 12 px | 1,25 | 450–560 | Méta, badges, barre d'état, en-têtes de section (majuscules, `letter-spacing: 0.04em`) |
| `--nv-text-sm` | 13 px | 1,45 | 450 | Listes, arbre, panneau Agent, hints |
| `--nv-text-md` | 14 px | 1,5 | 450 | Corps de l'interface |
| `--nv-text-lg` | 16 px | 1,4 | 560 | Titres de panneau, titre de conversation |
| `--nv-text-xl` | 20 px | 1,3 | 680 | Titres de section (Réglages) |
| `--nv-text-2xl` | 26 px | 1,25 | 680 | Titres de page |
| `--nv-text-3xl` | 34 px | 1,15 | 680 | Accueil, onboarding |

Code : `--nv-code-size` 13 px / `--nv-code-line` 20 px (confortable), `font-variant-ligatures: none` par défaut (option « ligatures » dans Réglages › Éditeur), `tabular-nums` partout où l'on compte (jetons, coûts, durées, numéros de ligne). Le fil de conversation garde 14 px / 1,6 ; les blocs de code du fil prennent la même taille que l'éditeur pour que « copier dans l'éditeur » ne change pas la lecture.

---

## 3. Anatomie de l'atelier

La coque garde ses trois zones (`DESIGN_SYSTEM.md`, `Workshop.tsx`) et gagne un **rail**, un **dock** et une **barre d'état**. Le centre est appelé **plan de travail** ; il accueille des *documents* (fichier, diff, aperçu, carte de mission, page de connecteurs) sous forme d'onglets. Le panneau Agent contient le fil (messages) et le journal (appels d'outils, approbations, preuves).

Deux dispositions, une seule logique, choisies par `data-layout` sur la coque :

- **`converse`** (mode Créer, et tant qu'aucun dossier n'est ouvert) : le fil est au centre (760 px de lecture), le plan de travail est à droite et peut se réduire à zéro. C'est l'état actuel des captures.
- **`build`** (mode Expert, ou dès qu'un fichier est ouvert en Créer) : le plan de travail est au centre, le panneau Agent à droite (380 px). Le basculement se fait par `⌘/Ctrl+Maj+L` et par la palette, avec une transition de 220 ms sur les largeurs (`grid-template-columns`) — pas de réordonnancement du DOM : les deux zones existent toujours, seules leurs tailles changent.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ rail 52 │ explorateur 260   │ plan de travail (1fr, min 480)               │ agent 380     │
│         │                   │ ┌─ onglets 36 ─────────────────────────────┐ │ ┌─ en-tête ─┐ │
│  ◆ nova │ ▾ mon-site        │ │ app.ts ● │ Diff (3) │ Aperçu  │ Carte   │ │ │ Nomi 28   │ │
│         │   ▸ src           │ ├──────────────────────────────────────────┤ │ ├───────────┤ │
│  ⌂      │     app.ts   M    │ │ fil d'Ariane 24 : src › app.ts › main() │ │ │ fil       │ │
│  ⧉      │     index.css     │ ├──────────────────────────────────────────┤ │ │           │ │
│  ◎      │   ▸ tests         │ │ 12 │ export function main() {           │ │ │ journal   │ │
│  ⚙      │   package.json    │ │ 13 │   const nova = "atelier";          │ │ │  ▸ outil  │ │
│         │                   │ │ 14 │   …                                │ │ │  ▸ outil  │ │
│         │                   │ │                                          │ │ │           │ │
│         │                   │ ├─ dock 36 (onglets) ──────────────────────┤ │ ├───────────┤ │
│         │                   │ │ Terminal 2 │ Problèmes 0 │ Tests ✓ │ Ports│ │ │ composer  │ │
│         │                   │ │ $ pnpm test                              │ │ │           │ │
│  Nomi   │                   │ │ ✓ 38 fichiers, 520 tests                 │ │ └───────────┘ │
│  44     │                   │ └──────────────────────────────────────────┘ │               │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ barre d'état 24 : ◐ Construire · main ✓ · 3 fichiers modifiés · 0,42 $ ▮▮▮▯ 2,00 $ · ◯ Nomi travaille · ⓘ 2 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Dimensions et contraintes :

| Zone | Défaut | Min | Max | Notes |
| --- | --- | --- | --- | --- |
| Rail | 52 px | fixe | fixe | Icônes 20 px, cible 40 × 40, `panel`. Nomi 44 px en bas (remplace le dock actuel quand l'explorateur est replié ; sinon le dock 44 px reste en bas de l'explorateur, comme aujourd'hui). |
| Explorateur (Fichiers / Conversations / Missions / Extensions selon l'icône du rail) | 260 px | 200 | 420 | Repliable (`⌘/Ctrl+B`). |
| Plan de travail | 1fr | 480 | — | Onglets 36 px, fil d'Ariane 24 px. |
| Dock | 240 px | 120 | 60 % | Repliable à sa barre d'onglets (36 px). |
| Panneau Agent | 380 px | 320 | 560 | Repliable (`⌘/Ctrl+J`). En `converse`, largeur = 1fr avec lecture 760 px. |
| Barre d'état | 24 px | fixe | fixe | Pleine largeur, `statusbar-bg`, texte `text-secondary` (9,17:1 / 6,04:1). |
| Séparateurs | 1 px `border` | — | — | Poignée 6 px de zone de saisie, accent au survol/actif/focus (déjà en place). |

Sous 900 px (relevé `NARROW_QUERY`) : barre haute 44 px, explorateur en tiroir gauche 340 px, panneau Agent en tiroir droit 380 px, dock plein écran en feuille du bas. On ne comprime pas l'éditeur : en dessous de 640 px de large, le plan de travail affiche le fil et propose « Ouvrir sur un écran plus large » pour le diff.

---

## 4. Écrans

Les wireframes sont à l'échelle 1 caractère ≈ 8 px en largeur. Les six états (vide, chargement, hors ligne, erreur, succès, refusé) sont décrits sous chaque écran.

### 4.1 Accueil

Objectif : reprendre en un clic, démarrer une idée, voir ce qui manque. Le contexte de confidentialité reste visible à droite (il l'est aujourd'hui, c'est un acquis).

```
┌ rail ┬ explorateur (Conversations) ┬──────────────────────────────────────────────┬ contexte 300 ┐
│      │                              │   (marge 64)                                 │ Confidentialité│
│      │                              │   Nomi 64   Bonjour. Nomi est disponible.    │ Conservation   │
│      │                              │                                              │ refusée · …    │
│      │                              │   ┌─ Nouvelle idée ─────────────────────────┐│ Modifier       │
│      │                              │   │ Décris ce que tu veux faire…            ││                │
│      │                              │   │ ┌ dossier : aucun ▾ ┐ ┌ modèle : … ▾ ┐  ││ Catalogue      │
│      │                              │   │                     Entrée pour envoyer ││ mis à jour …   │
│      │                              │   └─────────────────────────────────────────┘│                │
│      │                              │                                              │ Budget du mois │
│      │                              │   REPRENDRE                                  │ 3,20 $ ▮▮▯▯ 10 $│
│      │                              │   ┌ mon-site ──────────┐ ┌ facturation ─────┐│                │
│      │                              │   │ ◯ mission en cours │ │ 2 changements à   ││                │
│      │                              │   │ Corriger le formul.│ │ relire            ││                │
│      │                              │   │ il y a 12 min      │ │ hier              ││                │
│      │                              │   └────────────────────┘ └──────────────────┘│                │
│      │                              │                                              │                │
│      │                              │   À CONNECTER                                │                │
│      │                              │   ⚠ Aucun trousseau système : clé de session │                │
│      │                              │   ⚡ 1 serveur MCP hors ligne · Voir           │                │
└──────┴──────────────────────────────┴──────────────────────────────────────────────┴────────────────┘
```

- Carte « Reprendre » : 280 × 96 px, `panel`, bordure 1 px, rayon 16, titre 14/560, sous-titre 13 `text-secondary`, temps 12 `text-muted` ; si une mission est en cours, orbite 14 px active devant le statut (un seul foyer par carte).
- **États** : vide → la grille « Reprendre » disparaît (pas de carte fantôme) et le composer prend un exemple concret en placeholder ; chargement → 2 squelettes de carte, sans orbite ; hors ligne → bandeau info en haut du plan de travail « Hors ligne : les projets locaux restent ouvrables » ; erreur (base illisible) → callout danger avec le chemin du fichier ; refusé (clé absente) → bloc « À connecter » en tête, composer désactivé avec raison.

### 4.2 Atelier — plan de travail (éditeur)

Voir le schéma général en §3. Détails de l'éditeur :

```
┌ onglets ───────────────────────────────────────────────────────────────────────────┐
│ ⟨ts⟩ app.ts ●  │ ⟨css⟩ index.css ×  │ ◯ form.tsx (Nomi)  │ Diff (3) │  … │ ⊞ │ ⋯ │
├────────────────────────────────────────────────────────────────────────────────────┤
│ src › app.ts › main()                                     UTF-8 · LF · TS · 13 px │
├─────┬──────────────────────────────────────────────────────────────────────────────┤
│  11 │ import { atelier } from "./atelier";                                          │
│  12 │                                                                              │
│▌ 13 │ export function main() {                          ← ligne courante           │
│  14 │   const nova = "atelier";        ┌─ Nomi : pourquoi cette valeur ? ──┐       │
│  15 │   return atelier(nova);          │ …explication, 2 lignes           │       │
│  16 │ }                                └──────────────────────────────────┘       │
│ ~~~ │ ← diagnostic : soulignement ondulé danger, message au survol/`F8`           │
└─────┴──────────────────────────────────────────────────────────────────────────────┘
```

- Gouttière 44 px : numéros `gutter-fg` 12 px, ligne courante `text`, marqueurs de diff non validé 2 px (`accent` ajout, `amber` modif, `danger` suppression) collés au bord gauche du texte.
- Barre d'info 24 px sous le fil d'Ariane : encodage, fin de ligne, langage, taille — en `text-muted`, cliquables.
- Le panneau Agent peut « pointer » une ligne : la ligne prend `word-highlight` et une flèche 12 px `accent` dans la gouttière pendant 2 s puis reste marquée par un point 6 px jusqu'à la lecture.
- **États** : vide (aucun fichier ouvert) → page « Ouvre un fichier ou demande à Nomi » avec les 5 derniers fichiers ; chargement d'un gros fichier → squelette de 12 lignes, sans orbite ; erreur (fichier illisible/binaire) → callout dans l'onglet avec « Ouvrir avec le système » ; hors ligne → aucun effet (local) ; refusé (hors du périmètre autorisé) → onglet en lecture seule avec cadenas 14 px et raison.

### 4.3 Atelier — relecture de diff

Document « Diff » du plan de travail, ouvert automatiquement à la fin d'une mission et disponible à tout moment (`⌘/Ctrl+Maj+D`).

```
┌ Diff — 3 fichiers · +42 −7 · mission « Corriger le formulaire »   [ Tout garder ] [ Tout annuler ] ┐
├───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▾ src/form.tsx   +31 −4   ✓ test form.test.tsx passé (2,1 s)              [ Garder ] [ Annuler ]  │
│ ┌ @@ -12,7 +12,9 @@ function validate()                                    j/k · a garder · x annuler ┐
│ │  12  12 │   const email = input.value.trim();                                                      │
│ │  13     │ − if (!email) return;                                                                    │
│ │      13 │ + if (!email) {                                                                          │
│ │      14 │ +   setError("Adresse manquante");                                                       │
│ │      15 │ +   return;                                                                              │
│ │      16 │ + }                                                                                      │
│ │  14  17 │   send(email);                                                                           │
│ └ Preuve : tests › form.test.tsx:8 ✓ · Nomi : « gère le cas vide » ────────────────────────────────┘
│ ▸ src/form.css   +8 −3    aucun test                                            [ Garder ] [ Annuler ]│
│ ▸ README.md      +3 −0    —                                                     [ Garder ] [ Annuler ]│
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Unifié par défaut ; côte à côte (`⌘/Ctrl+\`) au-delà de 1 100 px de plan de travail.
- Chaque fichier porte sa preuve (test lancé, résultat) ou « aucun test » en `text-muted` ; jamais une coche sans exécution réelle.
- Garder/Annuler existe au niveau fichier **et** hunk ; une action sur un hunk marque le fichier « partiel » (pill ambre « 2 sur 3 gardés »).
- **États** : vide → « Aucun changement à relire » ; chargement → en-têtes de fichiers en squelette ; erreur (fichier modifié par l'utilisateur depuis) → hunk grisé + callout ambre « Ce fichier a changé depuis la mission · Recalculer » ; refusé (fichier hors périmètre) → cadenas.

### 4.4 Atelier — panneau Agent

```
┌ ◯ Nomi 28   Nomi travaille · Corriger le formulaire        ▮▮▮▯ 0,42 / 2,00 $   ⋯ ┐
├──────────────────────────────────────────────────────────────────────────────────┤
│ Toi                                                                    14:02     │
│ ┌ Le formulaire accepte une adresse vide, corrige ça et lance le test. ┐          │
│                                                                                  │
│ Nomi                                                                             │
│ Je lis le formulaire puis le test existant.                                      │
│ ┌ ▸ 👁 Lire  src/form.tsx:1-80                                     ✓ 0,3 s ┐      │
│ ┌ ▸ ⌕ Chercher  "validate("  · 3 résultats                         ✓ 0,1 s ┐      │
│ ┌ ▾ ✎ Modifier  src/form.tsx  +31 −4                                ✓ ─────┐      │
│ │   @@ -12,7 +12,9 @@  (aperçu 6 lignes)                     Ouvrir le diff │      │
│ └───────────────────────────────────────────────────────────────────────────┘      │
│ ┌ ▾ ⚠ Approbation  Lancer `pnpm test -- form`                                ┐      │
│ │   Portée : mon-site · réseau : aucun · durée max 2 min · coût : 0 $        │      │
│ │   [ Autoriser une fois ]  [ Pour cette mission ]  [ Refuser ]              │      │
│ └───────────────────────────────────────────────────────────────────────────┘      │
│ ┌ ▸ ▶ Terminal  pnpm test -- form                                  ◯ 4,2 s ┐      │
│                                                                                  │
│ Le cas vide est géré [form.tsx:13] et le test passe [form.test.tsx:8].           │
│ envoyés : 3 214 jetons · reçus : 410 · 0,0041 $ constaté · deepseek/… via …      │
├──────────────────────────────────────────────────────────────────────────────────┤
│ ┌ Écris à Nomi…                                                              ┐    │
│ │ ⎘ contexte : app.ts:13 ×      Construire ▾   Modèle : DeepSeek V4 Flash ▾  │    │
│ │                                            Entrée · Maj+Entrée   [ ↑ ]     │    │
│ └────────────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- En-tête 44 px : Nomi 28 px (état réel), libellé d'état, nom de la mission, jauge de budget inline 96 px, menu.
- Cartes d'outil repliées par défaut en Créer (une ligne), dépliées si erreur ; en Expert, dépliées pour patch et terminal.
- Les crochets `[form.tsx:13]` sont des chips de citation (§5.5).
- **États** : vide → invitation + 3 suggestions de mission adaptées au dossier ; chargement (attente du modèle) → orbite active dans l'en-tête + « Nomi réfléchit », pas de squelette ; hors ligne → callout info collé au-dessus du composer, texte reçu conservé ; erreur → callout danger sous le message avec action (comme aujourd'hui) ; refusé (crédit, clé) → même callout, composer actif ; succès → carte « Mission terminée » avec compte de fichiers, tests, coût, bouton « Relire les changements ».

### 4.5 Atelier — dock (terminal, problèmes, tests, ports, aperçu)

```
┌ Terminal 2 ◯ │ Problèmes 1 │ Tests ✓ 12 │ Ports 1 │ Aperçu ⧉        ⌃ agrandir · ⌄ replier · × ┐
├─ sessions ──┬────────────────────────────────────────────────────────────────────────────────┤
│ ● zsh       │ $ pnpm test -- form                                                             │
│ ◯ Nomi ·    │  ✓ src/form.test.tsx (3)                                                       │
│   pnpm test │  Test Files 1 passed · Tests 3 passed · 2,1 s                                  │
│   [Prendre  │ █                                                                               │
│    la main] │                                                                                │
└─────────────┴────────────────────────────────────────────────────────────────────────────────┘
```

- Onglets du dock 36 px, compteurs en badge `neutral` ; « Terminal » porte une orbite 12 px si une session de Nomi tourne.
- Liste de sessions 160 px (repliable) : point de statut 7 px (`accent` en cours, `text-muted` terminée, `danger` code ≠ 0), sessions lancées par Nomi identifiées par l'orbite et en lecture seule tant que « Prendre la main » n'est pas cliqué.
- **Aperçu** : iframe isolée dans le dock ou dans un onglet du plan de travail (bouton ⧉) ; barre 32 px avec URL locale, port, rechargement, capture (« Annoter » vers une demande de correction), compteur d'erreurs console (badge danger) ; jamais de barre de navigation libre.
- **États** : vide → « Aucune session · Nouveau terminal ⌘⇧` » ; chargement → curseur seul ; erreur (pty indisponible) → callout danger avec le niveau réel d'isolation ; refusé (profil lecture seule) → onglet Terminal visible mais entrée bloquée, raison affichée ; hors ligne → aucun effet.

### 4.6 Carte de mission

Document du plan de travail ; aussi vue pleine dans l'espace « Missions ».

```
┌ Mission « Corriger le formulaire »   ◯ en cours · étape 3/5 · 0,42 / 2,00 $ · 4 min   [ Suspendre ] [ Arrêter ] ┐
├───────────────────────────────────────────────────────────────────────┬─────────────────────────────┤
│                                                                       │ Étape 3 — Modifier          │
│  ┌ 1 Comprendre ┐    ┌ 2 Planifier ┐    ┌ 3 Modifier ◯ ┐              │ statut : en cours           │
│  │ ✓ 0,4 s      │───▶│ ✓ 12 s      │───▶│ src/form.tsx │──┐           │ début : 14:03:12            │
│  │ 3 fichiers   │    │ 5 étapes    │    │ +31 −4       │  │           │ fichiers : form.tsx         │
│  └──────────────┘    └─────────────┘    └──────────────┘  │           │ preuves : —                 │
│                                                           ▼           │ décisions :                 │
│                                        ┌ 4 Vérifier ⏸ ┐  ┌ 5 Livrer ┐│  « garder validate() »      │
│                                        │ attend ton OK │─▶│ prêt     ││                             │
│                                        │ pnpm test     │  │          ││ [ Ouvrir le diff ]          │
│                                        └───────────────┘  └──────────┘│ [ Voir le journal ]         │
│                                                                       │                             │
│  ── budget ── ▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯ 0,42 $ constaté · 0,15 $ réservé   │                             │
└───────────────────────────────────────────────────────────────────────┴─────────────────────────────┘
```

- Graphe gauche → droite, nœuds 220 × 64 px (§5.9), arêtes 1,5 px `border-strong`, arête active `accent` 2 px ; pas de flux animé sur les arêtes — l'orbite du nœud en cours suffit (foyer unique).
- Inspecteur droit 300 px : faits enregistrés (début, fichiers, preuves, décisions), jamais déduits.
- **États** : vide → « Aucune mission · Décris un objectif dans l'atelier » ; chargement → nœuds en squelette ; erreur (journal corrompu) → callout avec chemin ; suspendue (plafond) → bandeau ambre pleine largeur « Suspendue : plafond de 2,00 $ atteint · Relever le plafond · Arrêter » ; refusé (permission) → nœud en attente ambre + Nomi `waiting`.

### 4.7 Extensions — serveurs MCP et connecteurs

```
┌ Extensions ──────────────────────────────────────────────────────────────────────────────────┐
│ [ Serveurs MCP ] [ Skills ] [ Hooks ]                                    [ + Ajouter un serveur ] │
├───────────────────────────────────────────┬──────────────────────────────────────────────────┤
│ ● github     stdio · 12 outils · lecture  │ github                                            │
│ ● postgres   stdio · 6 outils · demander  │ ● Connecté · 12 outils · dernier test à l'instant │
│ ○ notion     https · hors ligne · —       │ Transport : stdio · commande : npx @… (masquée)   │
│ ○ figma      https · désactivé            │ Authentification : jeton dans le coffre (os)      │
│                                           │ Permissions : lecture seule ▾                     │
│                                           │  ├ read_file       autoriser                      │
│                                           │  ├ create_issue    demander                       │
│                                           │  └ delete_repo     refuser                        │
│                                           │ [ Tester la connexion ] [ Désactiver ] [ Retirer ]│
│                                           │ Journal (5 dernières entrées)                     │
│                                           │  14:01 ✓ tools/list 12 outils · 120 ms            │
└───────────────────────────────────────────┴──────────────────────────────────────────────────┘
```

- Ligne de serveur 44 px : point de statut 7 px (`accent` connecté, `text-muted` hors ligne/désactivé, `danger` erreur), nom 14/560, méta 12 `text-secondary`, profil de permission en pill.
- Les descriptions d'outils sont des données non fiables : affichées en `text-secondary`, en retrait, avec le préfixe « Décrit par le serveur : ».
- **États** : vide → « Aucun serveur · Ajouter » + lien doc ; chargement → 3 lignes en squelette ; hors ligne (distant) → point `text-muted` + « injoignable » ; erreur → ligne en `danger-soft` avec le message et « Voir le journal » ; refusé (permission refusée par l'utilisateur) → outil barré avec pill « refusé ».

### 4.8 Réglages

Structure existante (200 px de nav + contenu 1040 px max) conservée. Sections : Fournisseurs, Modèles, **Budget** (nouveau), **Permissions** (nouveau : profils Lecture seule / Assisté / Autonome / Personnalisé, table outil × opération × décision), **Éditeur** (nouveau : taille, ligatures, densité, retour à la ligne, guides), Confidentialité, Apparence (thème, densité, mouvement), Compagnon, Raccourcis, Diagnostics.

```
┌ Réglages ────────────────────────────────────────────────────────────────┐
│ Fournisseurs │ Budget                                                     │
│ Modèles      │ Plafond par mission        [ 2,00 ] $     ⓘ suspend à 100 %│
│ Budget       │ Plafond par mois           [ 10,00 ] $                     │
│ Permissions  │ Marge réservée par appel   [ 15 ] %                        │
│ Éditeur      │ ── Ce mois ──  ▮▮▮▮▯▯▯▯▯▯ 3,20 $ constaté · au moins        │
│ Confidential.│ (2 appels sans coût rapporté)                              │
│ Apparence    │                                                            │
│ Compagnon    │ Alerte à           [ 80 ] % du plafond                     │
│ Raccourcis   │                                                            │
│ Diagnostics  │ [ Enregistrer ]                                            │
└──────────────┴────────────────────────────────────────────────────────────┘
```

Un réglage = une ligne : libellé 14/560, contrôle, aide 13 `text-secondary`. Changement appliqué immédiatement (règle existante) avec toast de confirmation 3 s sauf pour Budget et Permissions, qui ont un bouton explicite.

### 4.9 Palette de commandes

Existante (cmdk), étendue par préfixes et par un mode « fichier ».

```
┌──────────────────────────────────────────────────────────────┐  ← 640 px, 12 vh du haut, E4
│ ⌕  > lancer les tests                                        │  ← champ 44 px, mono pour le préfixe
├──────────────────────────────────────────────────────────────┤
│ MISSION                                                       │
│ ▶  Lancer les tests du fichier courant           ⌘⇧T          │  ← ligne 36 px (compact 30)
│ ▶  Lancer tous les tests                                      │
│ FICHIERS                                                      │
│ ⟨ts⟩ src/form.test.tsx                                        │
│ NOMI                                                          │
│ ◯  Demander à Nomi : « lancer les tests »        ↵            │
├──────────────────────────────────────────────────────────────┤
│ >  commandes   @  fichiers   #  symboles   :  ligne   ?  aide  │  ← pied 28 px, `text-muted`
└──────────────────────────────────────────────────────────────┘
```

Sélection : `accent-soft` + barre gauche 2 px `accent` (existant). Toute requête sans résultat propose « Demander à Nomi » — la palette ne finit jamais sur un vide.

### 4.10 Onboarding

Trois étapes, une par écran, barre de progression 3 segments de 32 × 3 px ; l'étape 1 est l'écran actuel (clé, coffre, stockage), fidèle aux captures.

```
┌ ◆ NOVA                                                   ▮▮▯ étape 2 sur 3 ┐
│                                                                            │
│  Nomi 96 (idle)      Choisis un dossier                                    │
│                      NOVA lit et modifie seulement ce dossier, avec ta     │
│                      permission. Rien n'est envoyé sans que tu le voies.   │
│                                                                            │
│  ┌ ⌂ Ouvrir un dossier… ┐   ┌ ⤓ Cloner un dépôt ┐   Plus tard →            │
│                                                                            │
│  Profil de permissions pour ce dossier                                     │
│  (•) Assisté — Nomi demande avant d'écrire ou de lancer une commande       │
│  ( ) Lecture seule                                                         │
│  ( ) Autonome dans ce dossier — plafond 2,00 $ · 10 min · aucun réseau     │
│                                                                            │
│                                                       [ Continuer ]        │
└────────────────────────────────────────────────────────────────────────────┘
```

Étape 3 : « Décris une première idée » avec trois suggestions et le budget par défaut affiché avant l'envoi. **États** : hors ligne → étape 1 en « clé enregistrée non vérifiée » (existant) ; refusé (coffre absent) → consentement explicite (existant).

---

## 5. Composants — spécifications

Format : rôle, anatomie, tailles, états, clavier, accessibilité. Les états sont : repos, survol, actif (pressé), focus, sélectionné, occupé, désactivé, erreur. Toutes les tailles suivent la densité (§2.7).

### 5.1 Onglet d'éditeur (`EditorTab`, `EditorTabStrip`)

- Anatomie : icône de type 16 px · nom 13/450 (italique si aperçu) · indicateur droit 20 × 20 (× fermer, ● modifié 6 px `accent`, ◯ orbite 12 px si Nomi écrit dedans).
- Tailles : hauteur `--nv-tab-h` ; min 120 px, max 220 px, ellipsis au milieu du nom (garder l'extension) ; padding 0 12 px ; strip sur `panel`, bordure basse 1 px `border`.
- États : repos `panel` + `text-secondary` ; survol `raised-hover` + `text` ; **actif** = fond de l'éditeur (`editor-bg`) sans bordure basse, texte `text` (17,17:1), coins hauts 10 px — l'onglet actif est une encoche dans la barre, pas un surlignage ; focus anneau 2 px interne ; modifié : ● remplace × jusqu'au survol ; Nomi : ◯ active + info-bulle « Nomi modifie ce fichier » ; désactivé (fichier hors périmètre) : cadenas 12 px.
- Comportement : glisser pour réordonner (fantôme à 0,6 d'opacité, 120 ms) ; molette horizontale ; menu ⋯ « Fermer les autres / à droite / enregistrés » ; `⌘/Ctrl+W` fermer, `⌘/Ctrl+1…9`, `Ctrl+Tab` cycle.
- A11y : `role="tablist"`, `aria-selected`, nom = chemin complet ; l'état « modifié » est annoncé (« non enregistré »).

### 5.2 Ligne de l'arbre de fichiers (`TreeRow`)

- Anatomie : indentation 12 px/niveau + guide 1 px `indent-guide` · chevron 16 px (dossiers) · icône 16 · nom 13 · zone droite 56 px : lettre Git (`M` ambre, `A` accent, `D` danger, `?` `text-muted`, 11 px mono) · point Nomi 6 px si touché dans la mission courante.
- Hauteur `--nv-tree-row` ; padding gauche 8 px ; rayon 6 px sur le fond de survol/sélection.
- États : survol `raised-hover` ; sélectionné `raised` + barre gauche 2 px `accent` ; focus anneau interne ; renommage inline (champ 26 px, mono non) ; glisser-déposer avec ligne d'insertion 2 px `accent` ; ignoré (.gitignore) `text-muted` ; hors périmètre : cadenas.
- Clavier : flèches, `←/→` replier/déplier, `Entrée` ouvrir, `F2` renommer, `Suppr` (confirmation), taper pour filtrer.
- A11y : `role="tree"`/`treeitem`, `aria-level`, `aria-expanded` ; le statut Git est dans le nom accessible (« modifié »).

### 5.3 Hunk de diff (`DiffHunk`, `DiffFile`)

- En-tête de hunk 28 px : `@@` en mono 11 `text-muted`, contexte de fonction 12 `text-secondary`, actions à droite (Garder = secondaire sm, Annuler = ghost sm) visibles au survol et au focus dans le hunk, toujours visibles en Expert.
- Lignes : hauteur `--nv-diff-line` ; deux gouttières de 44 px (ancien, nouveau) en `gutter-fg` ; signe `+`/`−` en colonne 16 px colorée ; fond de ligne `diff-*-bg` ; mot à mot `diff-*-word` ; code coloré par la palette §2.3.
- En-tête de fichier 40 px, collant : chevron, chemin (dossier `text-muted`, nom `text`), `+n −m` mono, preuve (pill `jade` « test passé 2,1 s », `neutral` « aucun test », `danger` « test échoué »), actions fichier.
- États : gardé → hunk replié avec pill `jade` « gardé » ; annulé → replié pill `neutral` « annulé », lignes restaurées dans l'éditeur ; partiel → pill `amber` ; conflit (fichier changé depuis) → hunk à 0,6 d'opacité + callout ambre.
- Clavier : `j/k` hunk suivant/précédent, `a` garder, `x` annuler, `u` annuler la décision, `o` ouvrir dans l'éditeur à la ligne, `Entrée` déplier.
- A11y : chaque hunk est une `region` nommée « hunk 2 sur 3, lignes 12 à 20 » ; les lignes ajoutées/supprimées portent un préfixe textuel masqué (« ajouté », « supprimé »).

### 5.4 Carte d'appel d'outil (`ToolCallCard`)

- Replié 32 px : chevron 16 · icône du type 16 (lire, chercher, modifier, terminal, web, MCP, mémoire) · titre 13/560 (verbe + cible en mono : « Lire `src/form.tsx:1-80` ») · statut à droite : orbite 14 active (en cours), ✓ `accent` (ok), × `danger` (échec), ⏸ `amber` (attend) · durée mono 12 `text-muted`.
- Déplié : corps `editor-bg`, mono 12/18, max-height 240 px avec défilement interne, en-têtes « Arguments » / « Résultat » en 11 majuscules `text-muted` ; pour Modifier : aperçu de 6 lignes + « Ouvrir le diff » ; pour Terminal : 12 dernières lignes + « Ouvrir dans le dock » ; pour Web : domaine, titre, date de récupération ; pour MCP : serveur, outil, permission appliquée.
- Fond `panel`, bordure 1 px `border`, rayon 12, marge verticale 8 px ; échec : bordure `danger` et message + action (« Réessayer », « Ignorer cette étape »).
- Regroupement : plus de 3 cartes consécutives de même type se replient en « 7 lectures · 0,9 s » dépliable (foyer unique : l'orbite n'apparaît que sur le groupe).
- A11y : `aria-expanded`, statut dans le nom (« terminé », « en cours », « échoué ») ; `aria-live="polite"` sur le changement de statut uniquement.

### 5.5 Chip de citation (`CitationChip`)

- Inline dans le texte : hauteur 22 px (20 en compact), rayon pill, fond `info-soft`, texte `info` mono 12 (7,53:1 / 5,74:1), icône 12 (fichier, terminal, web, MCP, mémoire) ; contenu : `form.tsx:13`, `tests › 8`, `docs.site.fr`.
- Survol : bordure 1 px `info`, info-bulle avec le chemin complet ou l'URL ; clic : ouvre le fichier à la ligne (et surligne 2 s), la session de terminal, ou l'aperçu de la source dans le panneau ; `⌘/Ctrl+clic` ouvre en onglet arrière-plan.
- Obsolète (ligne déplacée, fichier supprimé) : `neutral` + barré, info-bulle « n'existe plus ».
- A11y : bouton nommé « Ouvrir form.tsx ligne 13 » ; jamais un simple `<span>`.

### 5.6 Panneau de terminal (`TerminalPanel`, `TerminalSessionList`)

- xterm.js, police JetBrains Mono 13/18 (compact 12,5/17), padding 8 × 12 px, fond `terminal-bg`, thème §2.4, `minimumContrastRatio: 4.5`, curseur bloc `accent` clignotant sauf mouvement réduit, scrollback 5 000, cloche désactivée, liens soulignés au survol.
- Barre de session 32 px (dans la ligne d'onglets du dock ou au-dessus) : nom, cwd raccourci, code de sortie en pill (`neutral` 0, `danger` autre), actions : effacer, tuer (confirmation si Nomi), scinder à droite, ouvrir dans un onglet.
- Sessions de Nomi : orbite 12 px devant le nom, ligne de commande affichée en en-tête `text-secondary`, saisie bloquée + bouton « Prendre la main » (la session devient la tienne, l'orbite disparaît, Nomi est informé).
- États : en cours (orbite), terminé (point `text-muted`, temps total), échec (point `danger`, bandeau 28 px « code 1 · Expliquer l'erreur »), tué (« arrêté par toi »), refusé (« commande refusée par le profil Lecture seule »).
- A11y : `role="application"` limité à la zone xterm, sortie du focus par `Échap`, résumé textuel de la dernière commande dans un `aria-live` séparé (pas le flux brut).

### 5.7 Demande d'approbation (`ApprovalCard`)

- Carte dans le journal + rappel dans la barre du composer (28 px ambre « Nomi attend ta réponse · Voir ») + Nomi `waiting` + badge sur la fenêtre (Electron `setBadgeCount`/`setProgressBar` indéterminé) si l'application n'a pas le focus.
- Anatomie : icône 16 `amber` · titre 14/560 « Nomi veut lancer `pnpm test -- form` » · lignes de faits (portée : dossier, réseau, durée max, coût estimé « fourchette 0,00–0,02 $ », effets irréversibles en `danger` s'il y en a) · texte de raison de Nomi 13 `text-secondary` · boutons : **Autoriser une fois** (primaire), **Pour cette mission** (secondaire), **Refuser** (ghost, texte `danger`).
- Fond `amber-soft`, bordure 1 px `amber`, rayon 12 ; irréversible : bordure `danger` et le bouton « Pour cette mission » disparaît.
- Clavier : `⌘/Ctrl+Entrée` autoriser une fois, `⌘/Ctrl+Maj+Entrée` pour la mission, `Échap` refuser ; jamais une touche seule.
- Après décision : carte repliée en 32 px « Autorisé une fois · 14:04 » / « Refusé », immuable.
- A11y : `role="alertdialog"` non modal (`aria-live="assertive"` une fois), focus déplacé sur « Autoriser une fois » seulement si l'utilisateur est dans le panneau Agent.

### 5.8 Jauge de budget (`BudgetMeter`)

- Piste 6 px (4 px en compact), rayon pill, couleur `border` ; segment constaté `accent` ; segment réservé hachuré (`repeating-linear-gradient(135deg, accent 0 2px, transparent 2px 6px)` — rayures en `accent` pur, ≥ 3:1) ; dépassement : la piste devient `danger-soft`, le remplissage `danger`, l'extrémité déborde de 2 px.
- Variantes : inline 96 px (barre d'état, en-tête Agent) avec texte « 0,42 / 2,00 $ » mono 12 ; carte (accueil, mission, réglages) avec légende « 0,42 $ constaté · 0,15 $ réservé · plafond 2,00 $ » et mention « au moins » + « (n appels sans coût rapporté) » quand un coût manque.
- Sans plafond : piste vide, texte « 0,42 $ constaté · sans plafond » ; jamais 100 %.
- Seuils : ≥ 80 % → texte `amber` ; 100 % → `danger` + pill « suspendue ».
- A11y : `role="meter"`, `aria-valuenow/max`, `aria-valuetext` en français complet.

### 5.9 Nœud de carte de mission (`MissionNode`)

- 220 × 64 px, `panel`, bordure 1 px `border`, rayon 12 ; en-tête : numéro + nom 13/560 ; ligne 2 : faits 12 `text-secondary` (« src/form.tsx · +31 −4 », « 3 fichiers », « pnpm test ») ; coin droit : statut.
- Statuts : prête (`text-muted`, bordure pointillée) ; en cours (orbite 14 active, bordure `accent`) ; en attente (⏸ `amber`, fond `amber-soft`) ; suspendue (bordure `amber`, texte « plafond ») ; réussie (✓ `accent`) ; échouée (× `danger`, fond `danger-soft`, 5,91:1) ; annulée (barré, `text-muted`) ; ignorée (opacité 0,6).
- Sélection : anneau 2 px `focus` ; survol : `raised-hover`.
- Clavier : flèches entre nœuds (ordre topologique), `Entrée` ouvre l'inspecteur, `o` ouvre la preuve.
- A11y : `role="button"` nommé « Étape 3, Modifier, en cours » ; les arêtes sont décrites dans l'inspecteur (« dépend de 2 »), pas seulement dessinées.

### 5.10 Toasts (`Toaster`, existant — étendu)

- Position : bas droite, 16 px des bords, au-dessus de la barre d'état ; 360 px ; pile de 3 max (le plus vieux se replie en « +2 »).
- Anatomie : icône 16 (tone) · titre 14/560 · détail 13 `text-secondary` (2 lignes max) · action ghost sm à droite · × 20 px.
- Tons : `neutral` (info, 6 s), `jade` (succès, 4 s), `amber` (attention, persistant), `danger` (erreur, persistant + action). Entrée 220 ms `ease-out` translateY(8px→0) + opacité ; sortie 100 ms `ease-in`.
- Règle : pas de toast pour ce qui a déjà un lieu visible (une erreur sous le message ne fait pas de toast) ; un toast = un événement que l'utilisateur ne regarde pas (« Mission terminée » quand on est ailleurs).
- A11y : `aria-live="polite"` (assertive pour `danger`), pause de la minuterie au survol et au focus.

### 5.11 États vide, chargement, erreur, hors ligne (patrons)

| Patron | Composant | Règle visuelle |
| --- | --- | --- |
| Vide | `EmptyState` (existant) | Icône 24 px `text-muted` ou marque mono 32 px, titre 16/560, phrase 14 `text-secondary`, **une** action primaire ou un raccourci. Jamais Nomi (il n'est pas une illustration). |
| Chargement | `Skeleton` (existant) | Blocs `raised` à 0,6 d'opacité, sans animation de balayage (mat) ; orbite **uniquement** si une opération réelle est en cours (réseau, processus). |
| Erreur | `Callout tone=danger` | Ce qui s'est passé · pourquoi · quoi faire ; détail repliable en mono ; action à droite. Pas de point d'exclamation. |
| Hors ligne | `Callout tone=info` collant en haut de la zone concernée + Nomi `offline` | « Hors ligne : X reste possible, Y attendra » ; disparaît seul au retour. |
| Refusé | `Callout tone=amber` ou cadenas inline | Nomme la règle (« profil Lecture seule », « hors du dossier ») et le chemin pour la changer. |
| Succès | Pill `jade` + fait chiffré | « 3 fichiers gardés · 12 tests passés » ; Nomi `success` 3 s puis `idle`. |

---

## 6. Signature « orbite » — règles d'usage

La forme : arc ouvert + satellite (`OrbitIndicator`, `viewBox 0 0 24 24`, trait 2,4). Chez Nomi : ellipse inclinée à la taille + satellite 2,7 u. Dans la marque : les extrémités du ruban et la lune.

1. **Ne bouge que sur activité réelle.** Sources autorisées : phase de flux (`waiting`, `reasoning`, `writing`), statut d'appel d'outil (`running`), processus de terminal vivant, mission `running`, vérification de clé, actualisation de catalogue. Aucun `setTimeout` décoratif.
2. **Foyer unique.** Dans une même région visuelle (une carte, une ligne, un panneau), une seule orbite tourne. Si un groupe contient des activités, l'orbite est sur le groupe ; si l'en-tête du panneau Agent tourne, les cartes du journal ne tournent pas — elles montrent leur statut par icône statique. Deux orbites côte à côte sont un bug.
3. **Emplacements** : boutons occupés (existant) ; curseur de flux (existant) ; en-tête du panneau Agent ; onglet d'éditeur écrit par Nomi ; nœud de mission en cours ; session de terminal de Nomi ; onglet « Terminal » du dock ; barre d'état (« ◯ Nomi travaille ») ; carte « Reprendre » avec mission en cours ; carte d'outil en cours ; Nomi lui-même.
4. **Tailles** : 12 px (onglets, dock, chips), 14 px (cartes, nœuds, boutons sm), 16 px (boutons md, en-têtes), 20 px (barre d'état large, palette). Trait proportionnel au `viewBox`, jamais recalculé.
5. **Couleurs** : `accent` active, `text-secondary` au repos (existant) ; `amber` seulement chez Nomi `waiting` (satellite), jamais l'arc ; `danger` seulement chez Nomi `error`.
6. **Vitesse** : 1 600 ms/tour (travail), 4 200 ms (réflexion, Nomi seulement), linéaire. Une orbite qui accélère ou ralentit est interdite : elle simulerait une progression.
7. **Repos** : immobile, satellite en haut à droite (angle du composant). Sous mouvement réduit : immobile et pleine (`accent`) pour « en cours », vide (`text-secondary`) sinon — la couleur double toujours un texte.
8. **Interdits** : fonds décoratifs, motifs répétés, chargement de page, écrans de marketing animés en boucle, curseur de souris, favicon animé.
9. **Toujours nommée** : `label` fourni dès qu'elle porte un état (« Nomi travaille ») ; décorative (`aria-hidden`) uniquement quand un texte adjacent dit la même chose.

---

## 7. Micro-interactions

Toutes désactivées sous `data-motion="reduce"` (poses statiques équivalentes).

| # | Déclencheur | Réaction | Durée · courbe |
| --- | --- | --- | --- |
| 1 | Survol d'un contrôle | fond `raised-hover`, texte `text` | 120 ms standard |
| 2 | Focus clavier | anneau 2 px `focus`, offset 2 px (interne dans onglets et lignes) | 0 ms (immédiat) |
| 3 | Bascule d'onglet | l'encoche active glisse (translateX du fond) ; contenu sans animation | 120 ms standard |
| 4 | Fichier modifié par Nomi | l'onglet gagne ◯ active ; à la fin, ◯ → ● (modifié) avec fondu | 180 ms |
| 5 | Nomi pointe une ligne | flèche de gouttière + `word-highlight` 2 s, puis point 6 px persistant | 180 ms in / 220 out |
| 6 | Dépliage d'une carte d'outil | `grid-template-rows 0fr→1fr` + opacité du corps | 180 ms standard |
| 7 | Nouvelle carte dans le journal | apparition translateY(4px→0) + opacité ; le défilement suit seulement si l'utilisateur est en bas (bouton « ↓ » collant sinon, existant) | 180 ms ease-out |
| 8 | Fin de flux | curseur-orbite s'arrête, disparaît en fondu ; ligne d'usage apparaît | 120 ms |
| 9 | Garder un hunk | lignes `del` se replient (hauteur via grid), lignes `add` perdent leur fond vers `editor-bg`, pill « gardé » | 220 ms standard |
| 10 | Annuler un hunk | inverse : `add` se replient, `del` reprennent leur fond normal | 220 ms |
| 11 | Approbation reçue | carte glisse depuis le bas de 8 px, bordure ambre ; Nomi passe en `waiting` (transition de pose 220 ms) ; rappel dans le composer | 220 ms ease-out |
| 12 | Décision d'approbation | carte se replie en une ligne ; Nomi revient à `working` | 180 ms |
| 13 | Budget ≥ 80 % | texte passe `amber`, la jauge ne clignote pas ; toast ambre une fois | 120 ms |
| 14 | Plafond atteint | jauge `danger`, bandeau « suspendue » ; Nomi `waiting` | 180 ms |
| 15 | Toast | entrée translateY(8px→0) 220 ms ease-out ; sortie 100 ms ease-in | — |
| 16 | Palette | ouverture opacité + scale(0,98→1) 180 ms ; fermeture 100 ms | — |
| 17 | Redimensionnement de zone | aucune animation pendant le glisser ; poignée `accent` ; double-clic = taille par défaut (220 ms) | — |
| 18 | Bascule `converse` ↔ `build` | colonnes animées, contenu figé | 220 ms standard |
| 19 | Réordonner un onglet | fantôme opacité 0,6, voisins se décalent | 120 ms |
| 20 | Glisser un fichier sur le composer | bordure du composer `accent` pointillée, texte « Ajouter au contexte » | 120 ms |
| 21 | Nœud de mission change d'état | icône de statut croise en fondu ; bordure animée en couleur | 180 ms |
| 22 | Terminal : fin de commande | ligne de statut 28 px apparaît (code, durée) | 120 ms |
| 23 | Copier (code, citation) | icône → ✓ 1,2 s puis retour ; texte « Copié » pour lecteurs d'écran | 120 ms |
| 24 | Succès de mission | Nomi `success` (saut 720 ms, existant), pill jade, aucun confetti | — |
| 25 | Erreur | Nomi `error` (affaissement 480 ms, existant) ; callout sans tremblement | — |
| 26 | Arrêt (Échap) | orbites s'immobilisent immédiatement ; « Génération arrêtée » 3 s puis `idle` (existant) | 0 ms |

---

## 8. Nomi dans l'interface

Nomi est un seul composant (`Nomi`, 64 u), affiché à cinq tailles selon le lieu ; il n'a jamais deux instances animées visibles en même temps (foyer unique : la plus grande instance visible anime, les autres prennent la pose statique).

| Lieu | Taille | Rôle | Comportement |
| --- | --- | --- | --- |
| Dock de navigation (existant) | 44 px | État global + accès aux réglages du compagnon | Libellé + détail (existant). |
| Rail (explorateur replié) | 32 px | Même rôle, réduit | Info-bulle avec libellé ; l'orbite reste lisible (silhouette à 32 px exigée par le brief). |
| En-tête du panneau Agent | 28 px | « Auteur » du fil ; l'état de la mission | Remplace l'avatar texte « Nomi » des messages : un seul Nomi en tête, les messages gardent le nom en texte 12/680. |
| Barre d'état | 16 px (orbite seule) | Présence quand nav et panneau sont repliés | Orbite + libellé ; Nomi complet n'apparaît pas à 16 px (illisible). |
| Accueil, onboarding | 64 / 96 px | Accueil, explication | Pose `idle`, phrase d'état en clair ; jamais un « bonjour » animé si rien ne se passe. |
| Fenêtre flottante (J4) | 96–160 px | Compagnon hors application | Même états ; opacité réglable, mise en pause hors écran. |

Règles :

- Nomi **ne parle pas dans le fil** par bulles décoratives : ses interventions sont des messages (texte), des cartes d'approbation, ou des toasts quand l'utilisateur est ailleurs.
- Nomi **agit** visiblement : quand il modifie un fichier, c'est l'onglet qui le montre (◯) ; quand il lance une commande, c'est la session de terminal ; Nomi lui-même ne « tape » pas et ne « court » pas vers les panneaux.
- Ses couleurs sont celles de l'interface (`nomi-*` existants) ; le satellite prend `accent` / `amber` (waiting) / `danger` (error) — aucune autre couleur.
- Compagnon masqué (`companion.visible = false`) : partout où Nomi serait, une `StatusPill` avec le même libellé (existant dans le dock ; à généraliser à l'en-tête Agent et à l'accueil).
- Chaque état a un nom en français (`NOMI_STATE_LABELS`) et une pose statique distincte (existant, `nomi.css`) ; `listening`/`speaking` arrivent en J4 avec l'indicateur de micro permanent (point rouge `danger` 8 px + « Micro actif » dans la barre d'état, jamais masquable).

---

## 9. Icône d'application, installeur, marketing

- **Marque** : le ruban jade (`MARK_PATH`, viewBox 256, marge 8 %), un seul tracé plein. Couleur : `#86D8BB` sur `#111619` ; version claire `#216B56` sur `#F5F3EC` ; mono `currentColor` dans l'interface (lockup 20 px en `text`, comme aujourd'hui).
- **Icône d'application** : la marque à 66 % de la tuile, centrée optiquement (décalée de 2 % vers le haut à cause de la lune), sur fond `#111619` plat — pas de dégradé, pas de bordure. macOS : squircle système (masque fourni par l'OS, tuile 1024 avec marge 10 %) ; Windows : carré à coins 0, tailles 16/24/32/48/64/128/256 ; Linux : 512 et 1024 PNG, coins 18 %. **Coupe dédiée 16 px** (les pointes disparaissent : la note du logo-lab le constate) : ruban simplifié à deux courbes épaisses + lune de 3 px, à produire dans `packages/ui/assets` et à brancher dans `pnpm icons`.
- **Barre des tâches / dock** : badge numérique pour les approbations en attente ; barre de progression indéterminée du système pendant une mission (Electron `setProgressBar(2)` ou équivalent), jamais un pourcentage inventé.
- **Installeur** : fond `#F5F3EC`, marque `#216B56` à 96 px, mot-symbole en Manrope 680 (le wordmark de référence est géométrique et large : le vecteur `wordmark.svg` fait foi), texte d'étape en `#4B5A5D`. Aucune image de fond, aucun dégradé. DMG : disposition icône → dossier Applications sur le même fond.
- **Site / captures** : mêmes deux thèmes, captures réelles de l'application (jamais de maquette « embellie »), une seule couleur d'accent, titres Manrope 680, corps 450, code JetBrains Mono. Les vidéos montrent l'orbite en mouvement uniquement sur une activité réelle capturée ; les visuels fixes montrent l'orbite immobile.
- **Interdits de marque** : marque en contour, marque multicolore, ombre portée, lune détachée redimensionnée, orbite décorative autour du logo, mascotte Nomi en héros de page de vente (Nomi apparaît à sa taille d'interface, dans son contexte).

---

## 10. Checklist d'implémentation

Ordre proposé : tokens → primitives → coque → documents → agent → finitions. Chaque ligne cite le fichier propriétaire ; aucune valeur littérale ne vit dans le renderer.

### 10.1 `packages/ui` — tokens

- [ ] `src/tokens.ts` : étendre `Palette` avec `editorBg`, `terminalBg`, `lineHighlight`, `statusbarBg`, `textMuted`, `gutterFg`, `indentGuide`, `matchBg`, `matchCurrentBg`, `bracketBg`, `wordHighlight`, `diffAddBg/Fg/Word`, `diffDelBg/Fg/Word`, `diffModBg/Fg`, `syn*` (14 rôles), `ansi*` (16), `shadowPopover` ; valeurs §2.
- [ ] `src/styles/tokens.css` : miroir des nouvelles variables ; ajouter `--nv-text-2xs`, `--nv-space-0-5`, `--nv-space-8`, `--nv-radius-none`, `--nv-duration-exit`, `--nv-duration-orbit`, `--nv-duration-orbit-slow`, `--nv-ease-in`.
- [ ] `src/styles/tokens.css` : bloc `[data-density="compact"]` / `[data-density="comfortable"]` (défaut) pour `--nv-control-*`, `--nv-row`, `--nv-tree-row`, `--nv-tab-h`, `--nv-code-size`, `--nv-code-line`, `--nv-diff-line`, `--nv-panel-pad`, `--nv-list-gap`, `--nv-statusbar-h`.
- [ ] `src/tokens.test.ts` : garder la vérification de miroir TS ↔ CSS pour toutes les nouvelles clés.
- [ ] `src/contrast.test.ts` : asserter les paires de §2 (syntaxe × 6 surfaces, diff, ANSI, `text-muted`, `gutter-fg`, chips, approbation, nœuds) — seuils 4,5 / 3.
- [ ] `src/styles/code.css` **(nouveau)** : classes `.nv-syn-*` mappées aux tags Lezer, `.nv-diff-*`, thème xterm en variables ; importé par `index.css`.

### 10.2 `packages/ui` — composants

- [ ] `components/OrbitIndicator.tsx` : prop `speed: "work" | "think"` (durées tokens) ; pose « pleine » sous mouvement réduit quand `active`.
- [ ] `components/Tabs.tsx` **(nouveau)** : `EditorTabStrip`, `EditorTab` (§5.1) ; `components/Tabs.test.tsx` (rôles, clavier, réordonnancement).
- [ ] `components/TreeRow.tsx` **(nouveau)** (§5.2) + test `tree`/`treeitem`.
- [ ] `components/Diff.tsx` **(nouveau)** : `DiffFile`, `DiffHunk`, `DiffLine` (§5.3) ; rendu de lignes virtualisé au-delà de 400 lignes ; test clavier `j/k/a/x/u`.
- [ ] `components/ToolCallCard.tsx` **(nouveau)** (§5.4) + regroupement.
- [ ] `components/CitationChip.tsx` **(nouveau)** (§5.5).
- [ ] `components/ApprovalCard.tsx` **(nouveau)** (§5.7) ; test des raccourcis à modificateur.
- [ ] `components/BudgetMeter.tsx` **(nouveau)** (§5.8) ; test `aria-valuetext` avec « au moins ».
- [ ] `components/MissionNode.tsx` **(nouveau)** (§5.9).
- [ ] `components/StatusBar.tsx` **(nouveau)** : slots gauche/droite, hauteur token.
- [ ] `components/Toast.tsx` : pile max 3, pause au survol/focus, sortie 100 ms.
- [ ] `components/EmptyState.tsx` : variante `icon` mono 24 px ; pas d'illustration.
- [ ] `components/Badge.tsx` : ton `info` (chips) si absent.
- [ ] `nomi/Nomi.tsx` : prop `presence: "lead" | "static"` pour le foyer unique (la version statique garde la pose sans animation).
- [ ] `src/index.ts` : exporter les nouveaux composants et types.
- [ ] `gallery/ComponentGallery.tsx` : sections Éditeur, Diff, Agent, Mission, Terminal avec tous les états et les deux densités.
- [ ] `assets/` : `app-icon-16.svg` (coupe dédiée), `fonts/JetBrainsMono-wght.ttf` + licence OFL ; `pnpm icons` régénéré.

### 10.3 `apps/desktop/src/renderer`

- [ ] Éclater `styles/app.css` (1 282 lignes) en `styles/layout.css` (coque, rail, dock, barre d'état, dispositions `converse`/`build`), `styles/agent.css`, `styles/editor.css`, `styles/terminal.css`, `styles/home.css`, `styles/settings.css`, `styles/palette.css` ; l'entrée `app.css` ne fait qu'importer. Aucune couleur ni hauteur littérale : tout en `--nv-*`.
- [ ] `components/layout/Workshop.tsx` : ajouter rail, dock, barre d'état, `data-layout`, `data-density` posés sur `<html>` depuis les réglages ; tailles §3 ; raccourcis `⌘/Ctrl+B`, `⌘/Ctrl+J`, `⌘/Ctrl+Maj+L`.
- [ ] `components/layout/NomiDock.tsx` : variante rail 32 px ; foyer unique avec l'en-tête Agent.
- [ ] `components/agent/` **(nouveau)** : `AgentPanel.tsx` (en-tête + fil + journal + composer), `ToolTimeline.tsx`, `ApprovalBanner.tsx` ; réutiliser `chat/Composer.tsx` avec un slot « contexte » (chips).
- [ ] `components/editor/` **(nouveau)** : `EditorGroup.tsx` (onglets + fil d'Ariane + CodeMirror), `EditorSurface.tsx` (thème via classes `nv-syn-*`, `EditorView.cspNonce` avec le nonce de la CSP), `FileTree.tsx`.
- [ ] `components/diff/DiffReview.tsx` **(nouveau)** : document « Diff » du plan de travail.
- [ ] `components/dock/` **(nouveau)** : `Dock.tsx`, `TerminalView.tsx` (xterm, thème ANSI, `minimumContrastRatio: 4.5`, vérifier que xterm n'injecte que des styles CSSOM compatibles CSP), `Problems.tsx`, `Tests.tsx`, `Ports.tsx`, `Preview.tsx` (iframe sandbox).
- [ ] `components/missions/MissionMap.tsx` **(nouveau)** + inspecteur.
- [ ] `components/extensions/McpManager.tsx` **(nouveau)**.
- [ ] `components/settings/SettingsView.tsx` : sections Budget, Permissions, Éditeur, densité dans Apparence.
- [ ] `components/palette/CommandPalette.tsx` : préfixes `> @ # :`, groupe « Nomi » de repli, pied d'aide.
- [ ] `components/home/HomeView.tsx` : composer d'idée, cartes « Reprendre », bloc « À connecter », jauge du mois.
- [ ] `components/setup/Onboarding.tsx` : étapes 2 (dossier + profil) et 3 (première idée), barre de progression.
- [ ] `copy/fr.ts` : libellés des nouveaux composants (verbe unique par bouton, « inconnu », « au moins », messages d'approbation « Cette action enverra ces fichiers au fournisseur choisi »).
- [ ] `icons.tsx` : n'ajouter que ce que lucide ne couvre pas ; sinon passer par `@nova/ui`.
- [ ] E2E `e2e/ui-journey.spec.ts` : captures des nouveaux écrans dans les deux thèmes et les deux densités vers `e2e/artifacts/screens/` ; axe-core sur chaque.

### 10.4 Documentation

- [ ] `docs/DESIGN_SYSTEM.md` : remplir « Tokens validés » depuis `packages/ui` avec les ratios de `contrast.test.ts` ; référencer ce document ; ajouter les composants J2–J3 au tableau.
- [ ] `docs/DECISIONS.md` : ADR « moteur d'édition » (CodeMirror 6 vs Monaco, CSP, taille du bundle) et ADR « une seule coloration » (Lezer pour l'éditeur et le fil).
- [ ] `docs/STATUS.md` : ligne « design » avec ce qui est intégré et ce qui reste.

---

## Annexe A — Contrastes calculés (résumé)

Méthode : formule WCAG 2.x (luminance relative sRGB), identique à `packages/ui/src/contrast.ts`, exécutée sur l'ensemble des paires de ce document ; seuils 4,5:1 (texte), 3:1 (composants, gouttières, focus). Résultat : **0 échec sur les valeurs finales**. Valeurs ayant nécessité une correction pendant le calcul et retenues : commentaires/`text-muted` nuit `#8C9EA0` (au lieu de `#7E9093`, 4,07 sur `raised`), papier `#556668` (au lieu de `#66777A`, 3,93 sur `panel`) ; gouttière nuit `#7A8B8E` (5,30), papier `#5F7073` (4,96). ANSI 0 en nuit reste un fond ; la lisibilité des premiers plans faibles envoyés par les programmes est déléguée à `minimumContrastRatio: 4.5` d'xterm.js. Rayures de réservation en `accent` pur (une teinte intermédiaire `#7FA99A` tombait à 2,19 sur `panel` en papier).

## Annexe B — Décisions ouvertes pour le propriétaire

1. Disposition `build` : le panneau Agent à droite (proposé) ou à gauche, à la place de l'explorateur ?
2. Densité compacte par défaut en mode Expert : confirmer.
3. Onglet actif « en encoche » (fond de l'éditeur, sans soulignement) : confirmer, c'est le choix le plus mat mais le moins conventionnel.
4. Raccourcis d'approbation à modificateur (`⌘/Ctrl+Entrée`) plutôt que `Y`/`N` : confirmer.
5. Coupe 16 px dédiée de la marque : à produire dans le logo-lab avant la prochaine génération d'icônes.

---

**Fichiers lus** : `docs/DESIGN_SYSTEM.md`, `docs/PRODUCT.md`, `docs/STATUS.md`, `docs/ROADMAP.md` (J2–J3), `packages/ui/src/{tokens.ts,index.ts}`, `packages/ui/src/styles/{tokens,components,nomi,base}.css`, `packages/ui/src/components/{OrbitIndicator,Button}.tsx`, `packages/ui/src/nomi/{Nomi.tsx,states.ts,geometry.ts}`, `apps/desktop/src/renderer/styles/app.css`, `apps/desktop/src/renderer/components/layout/{Workshop,NomiDock}.tsx`, `apps/desktop/src/renderer/components/icons.tsx`, captures `01, 03, 04, 11, 12, 13, 20, 30, 40`, `.devdeps/logo-lab/final/{notes.md,preview-512.png,preview-512-light.png,preview-32.png}`, `.devdeps/logo-lab/ref/*.png`, brief `.orca/drops/NOVA_Prompt_Developpement_Complet.md` §1–4 et §8–14. Script de contrôle des contrastes conservé dans le scratchpad de session (`contrast.mjs`), à porter dans `contrast.test.ts` lors de l'intégration.
