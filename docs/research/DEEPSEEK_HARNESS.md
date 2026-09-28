# Rapport : l'« app » DeepSeek de septembre 2026, et les écarts avec NOVA

Recherche en lecture seule, sans aucune modification de dépôt. La section 5, ajoutée le 2026-09-28, fait le point sur ce que NOVA couvre après J2-B. Pour vérifier les fonctions, j'ai cloné le dépôt officiel de DeepSeek Harness (`deepseek-ai/deepseek-harness`) dans mon dossier temporaire et j'en ai lu le code.

## 0. De quelle « app » parle-t-on ?

Deux sorties récentes correspondent à « DeepSeek a sorti une app ». La plus probable est la deuxième.

1. **La refonte de l'app de chat DeepSeek**, le 10 septembre 2026, sur mobile et web. Ce n'est pas une nouvelle app, c'est une mise à jour.
2. **DeepSeek Harness Desktop**, une nouvelle application de bureau Electron pour Windows et Mac. Elle est apparue le 25 septembre 2026 sur `download.deepseek.com` en préversion (versions 0.1.7-rc.1 et rc.2). C'est un agent de bureau pour le code et le travail de bureau (Office). Il repose sur le harness open source `dsh`, sous licence MIT, publié le 13 août 2026.

## 1. Chronologie avec sources

| Date | Événement | Niveau | Source |
|---|---|---|---|
| 31/07/2026 | V4-Flash en bêta publique : format Responses API, adaptation à Codex | Officiel | [api-docs changelog](https://api-docs.deepseek.com/updates/) |
| 13/08/2026 | V4-Pro en version finale, disponible dans l'app et le web via le « Mode Expert ». Trois niveaux de réflexion (low, high, max). Tarifs heures pleines / heures creuses à partir du 16/08 | Officiel | [news260813](https://api-docs.deepseek.com/news/news260813/) |
| 13/08/2026 | Dépôt `deepseek-ai/deepseek-harness` créé (GitHub : `created_at` 2026-08-13). Préversion développeur v0.1, licence MIT | Officiel | [GitHub](https://github.com/deepseek-ai/deepseek-harness), [deepseek.com/harness](https://deepseek.com/harness/en/) |
| 21/08/2026 | Modèle expérimental V4-Flash-Vision-Exp dans l'API | Officiel | changelog |
| 10/09/2026 | Refonte de l'app : les modes Rapide, Expert et Vision fusionnent en un seul mode intelligent. Le modèle V4.1 Flash sort (multimodal natif) | Officiel pour l'API, presse pour le détail de l'app | changelog, [IT之家](https://www.ithome.com/1/000/602.htm), [凤凰网](https://tech.ifeng.com/c/8wIzoVxyeZH), [什么值得买](https://post.smzdm.com/p/a70nwd9g/) |
| 15/09/2026 | Le code de l'app de bureau Harness est fusionné dans la branche principale | Presse, vérifié dans le code | [KuCoin/flash](https://www.kucoin.com/news/flash/deepseek-harness-desktop-app-enters-main-branch-preparing-for-release) |
| 17/09/2026 | Mise à jour de l'app mobile (fiche Play Store) | Presse (agrégateur) | [blog.mean.ceo](https://blog.mean.ceo/deepseek-news-september-2026/) |
| 22–24/09/2026 | Préversions GitHub `dsh-v0.1.7-alpha.1` jusqu'à `rc.2` (toutes marquées préversion) | Officiel | `gh api repos/deepseek-ai/deepseek-harness/releases` |
| ~25/09/2026 | Paquets de bureau Windows x64 (.exe) et Mac arm64 (.dmg) sur `download.deepseek.com`. Pas encore annoncés sur le site ni dans les Releases GitHub. Pas de version Linux | Presse | [36Kr](https://eu.36kr.com/en/p/3998199345500040), [Pandaily](https://pandaily.com/deepseek-harness-desktop-preview-electron-win-mac-nightly) |

## 2A. App de chat (refonte du 10/09) : fonctions visibles par l'utilisateur

| Fonction | Comportement | Niveau |
|---|---|---|
| Mode unique « intelligent » | Remplace les boutons Rapide, Expert et Vision. Le système juge lui-même la difficulté de la question et active au besoin la réflexion approfondie et la recherche web. | Officiel (annonce reprise par [IT之家](https://www.ithome.com/1/000/602.htm) et [凤凰网](https://tech.ifeng.com/c/8wIzoVxyeZH)) |
| Vision intégrée | On envoie une image sans changer de mode. La vision n'est plus expérimentale. | Presse ([smzdm](https://post.smzdm.com/p/a70nwd9g/)) |
| Repli automatique du raisonnement | Le texte de réflexion se replie tout seul. | Presse (résumé de recherche, non vérifié sur une source primaire) |
| Modèle V4.1 Flash | Contexte de 1 million de jetons, vision native, plus rapide que V4 Pro. V4 Pro devait être redirigé vers V4.1 Flash le 14/09, mais l'API V4 Pro est finalement maintenue. | Officiel (changelog) |
| Gratuit, mobile et web | Mise à jour automatique, pas d'abonnement payant. | Presse |

## 2B. DeepSeek Harness Desktop : fonctions visibles par l'utilisateur

Tout ce qui est marqué « officiel » ci-dessous vient du dépôt `deepseek-ai/deepseek-harness`, que j'ai lu directement.

| Fonction | Ce qu'elle fait et comment elle se comporte | Limites | Niveau |
|---|---|---|---|
| **App de bureau Electron** | Enveloppe l'interface web complète de `dsh` (`apps/desktop/README.md`). Port par défaut 19387 (le web utilise 3080). Icône dans la barre système sous Windows : fermer la fenêtre laisse les tâches tourner. Avant de quitter, l'app avertit si des tâches sont en cours. | Préversion. Pas de Linux. | Officiel (code) ; mise à disposition en téléchargement : presse |
| **Mises à jour obligatoires signées** | Le shell, le runtime `dsh` et pnpm forment un seul paquet signé. Une politique de mise à jour obligatoire existe. Vérification des mises à jour depuis le menu. | L'installation d'une mise à jour interrompt les tâches, après confirmation. | Officiel |
| **Parcours d'accueil** | L'utilisateur choisit « Office & creative work » ou « Coding & development ». Il règle ensuite le niveau de détail affiché : « Results only », « Key details » ou « Full details » (`ui-settings-account/.../onboarding.ts`). | Ce réglage change seulement l'affichage, pas les capacités. | Officiel |
| **Compte et crédits** | Facturation au jeton, avec des crédits prépayés (« can't start new tasks without credits »). Une clé API est aussi acceptée. | Pas gratuit. L'exigence d'identité réelle est rapportée par 36Kr mais je ne l'ai pas trouvée dans le code. | Officiel pour les crédits ; presse pour l'identité réelle |
| **Quatre modes d'agent** | Standard (fichiers, shell, recherche, skills, plan, objectifs, sous-agents, workflows). Code/PTC : les outils sont exposés comme une SDK TypeScript, et le modèle écrit un seul programme qui enchaîne plusieurs étapes. Minimal (bash et éditeur, pour évaluer un modèle). Creator (inspection du runtime, création de préréglages). | | Officiel ([deepseek.com/harness](https://deepseek.com/harness/en/)) |
| **Outils** | Lire, écrire et modifier des fichiers, lire des images, glob et grep, bash ou pwsh (aussi en mode persistant), terminaux interactifs (ouvrir, envoyer, lire, signal), LSP, `web_search` et `web_fetch`, `todo_write`, `ask_user_question`, `present` (déclare les fichiers livrés), tâches en arrière-plan (`job_*`), recherche dans l'historique des sessions (`session_*`) (`docs/tool-catalog.md`). | | Officiel |
| **Sous-agents et équipes d'agents** | Sous-agents lancés à neuf ou en « fork » avec l'historique du parent. Un sous-agent peut aussi être **Claude Code, Codex ou un agent ACP**. Outils pour envoyer un message à un agent, l'interrompre ou lister les agents. Les « Agent Team » (coéquipiers et tâches d'équipe) sont expérimentales. | Les équipes d'agents sont expérimentales. | Officiel |
| **Workflows et boucle « ralph »** | Le modèle écrit un script d'orchestration qui répartit le travail entre sous-agents. `ralph` enchaîne une suite d'agents neufs. | Le workflow s'exécute dans le runtime PTC. | Officiel |
| **Objectif persistant** | Un seul objectif durable par session, commande `/goal`. Continuation automatique optionnelle en « Rounds ». Survit aux redémarrages et aux forks. | Continuation désactivée par défaut. | Officiel |
| **Mode plan** | Planifier puis quitter le mode plan (`exit_plan_mode`). | | Officiel |
| **Permissions et sandbox** | Trois modes : lecture seule, écriture limitée à l'espace de travail, accès complet. Isolation Linux par bwrap puis Landlock, macOS par Seatbelt, Windows par jeton restreint et ACL. Des préréglages combinent sandbox et politique d'approbation. Approbation ponctuelle, refusée par défaut si personne ne répond. « Auto review » (le modèle relit chaque appel) est expérimental. | | Officiel |
| **Trajectoire et journal** | Journal en ajout seul de tout ce que voit le modèle (prompts, raisonnement, outils, injections de contexte). Une vue Trajectoire permet de reprendre, forker, chercher et rejouer. | | Officiel |
| **Compaction** | Automatique à l'approche de la limite de contexte, ou manuelle avec `/compact`. Élagage des gros résultats d'outils. Images retirées si nécessaire. | Activée par défaut. | Officiel |
| **Skills** | Skills au niveau projet et utilisateur, chargées à la demande par l'outil `skill`. Skills Office fournies (Word, PowerPoint, Excel, avec vérification structurelle). Conversion Office vers PDF (LibreOffice/WASM). | | Officiel |
| **Livrables et changements** | Fin de tour avec la liste des fichiers livrés et des fichiers modifiés (instantanés git, nombre de lignes, diff). | | Officiel |
| **MCP** | Client stdio et Streamable HTTP. Outils nommés `mcp__serveur__outil`. Ressources MCP. Exemples de mémoire via des serveurs MCP tiers (Memorix, reference memory…), désactivés par défaut. | Pas de mémoire intégrée : elle passe par MCP. | Officiel |
| **Tâches planifiées (« Automation tasks »)** | Le modèle crée des rappels : unique, intervalle d'au moins 1 minute, quotidien ou hebdomadaire avec fuseau IANA, ou cron. Une page liste les tâches et l'historique des livraisons. | Bundle expérimental, désactivé dans le profil web. Tourne seulement si l'hôte est lancé. Pas de pause. Livraison exactement une fois non garantie. | Officiel (`docs/user/guide/schedule.md`) |
| **Webhook GitHub** | Une PR qui passe « ready for review » crée une session de relecture en lecture seule. | Optionnel (opt-in), demande un tunnel TLS. | Officiel |
| **Navigateur et computer use** | Pilotage de navigateur par Stagehand, Playwright MCP ou Chrome DevTools MCP. Pilotage du bureau par Cua Driver. | Tout est expérimental et doit être activé explicitement. | Officiel |
| **Voix** | Dictée par microphone avec SenseVoice en local. | Expérimental, désactivé. | Officiel |
| **Hooks** | Protocole de hooks compatible avec les hooks de Claude Code et de Codex. | | Officiel |
| **SSH et SDK Python** | Fichiers et sandbox à distance par SSH. SDK Python. | | Officiel |
| **Fournisseurs de modèles** | DeepSeek par défaut. Autres fournisseurs et URL compatibles OpenAI acceptés. | | Officiel (`providers.md`) |

**Rumeurs et points non confirmés :** une date de sortie finale (GA), une version Linux, et l'exigence d'identité réelle. Les chiffres d'étoiles GitHub cités par la presse varient : l'API affiche 238 266 aujourd'hui.

## 3. Tableau d'écarts avec NOVA

L'état de NOVA vient de `docs/STATUS.md` (J2-A fonctionne contre un faux serveur OpenRouter, branche `feat/j2a-atelier` non poussée) et de `docs/FEATURES.md`. Pour le support côté fournisseur : DeepSeek V4.1 Flash est sur OpenRouter avec `tools` et les sorties structurées ([openrouter.ai](https://openrouter.ai/deepseek/deepseek-v4.1-flash)).

Effort : S ≤ 2 jours, M ≤ 1 semaine, L ≤ 3 semaines, XL > 3 semaines.

| Fonction DeepSeek | NOVA l'a ? | Équivalent NOVA proposé (original) | Effort | Supporté par OpenRouter / les API |
|---|---|---|---|---|
| Mode unique qui choisit seul réflexion et recherche | Partiel : six modes appliqués par le moteur (A12), profils de routage Mo1 | Un « pilote automatique » optionnel dans Discuter : un petit appel classe la demande et règle `reasoning.effort` et `web` en conséquence, avec le choix affiché et modifiable | S | Oui (`reasoning`, plugin web) |
| Vision sans changer de mode | Oui : V1 dans J2-A, filtré par `inputModalities` | Proposer automatiquement un modèle vision quand on colle une image | S | Oui |
| Repli du raisonnement | À vérifier dans l'UI (non cité dans les docs) | Bloc « réflexion » repliable, avec son coût | S | Oui (`reasoning` dans le flux) |
| App de bureau, barre système, les tâches continuent fenêtre fermée | Partiel : Electron oui ; barre système = N12 (J7) ; fenêtre flottante N5 (J4) | Nomi dans la barre système qui garde les missions en vie et avertit avant de quitter si une mission tourne | M | Sans objet |
| Mises à jour signées obligatoires | Non (S8, question Q3 : pas de certificat) | Mises à jour signées via electron-updater, jamais forcées pendant une mission | M (bloqué par Q3) | Sans objet |
| Accueil par usage et niveau de détail | Non | À l'accueil, choisir un profil (code ou documents) et une densité d'affichage (résultat / étapes clés / tout), réglable ensuite dans la carte de mission | S | Sans objet |
| Crédits prépayés | Sans objet : clé OpenRouter ; garde-fous budget Mo5 et A13 (J2-A) | Avantage NOVA : budget par mission avec réservation. Ajouter l'affichage du solde OpenRouter (`/api/v1/credits` ou `/key`) | S | Oui |
| Quatre modes d'agent | Oui, en mieux sur le contrôle : six modes (A12) | Un mode « script » (voir PTC ci-dessous) | — | — |
| Mode Code / PTC (un programme qui enchaîne les outils) | Non | Mode « Chaîne » : le modèle écrit un script JS qui s'exécute dans un worker isolé et appelle les outils NOVA via un proxy soumis aux permissions S1 | L | Oui (tool calling classique) |
| Outils fichiers, shell, recherche, web | Oui : A1–A5, W1, W2 (J2-A) | — | — | Oui |
| Terminal piloté par l'agent | Partiel : node-pty oui, mais `createAgentSession` n'a aucun appelant (STATUS « non fait ») | Brancher les commandes de mission sur le pty-host, en lecture seule avec « Prendre la main » | M | Sans objet |
| Tâches en arrière-plan (`job_*`) | Non : `process_list`/`process_stop` non faits (STATUS) | Outils de suivi des processus lancés par la mission | S | Sans objet |
| LSP | Non : E5 prévu en J2-B | Déjà conçu (`@codemirror/lsp-client`) ; ajouter un outil `lsp` pour l'agent | L | Sans objet |
| Sous-agents, fork, équipes | Non : A14 en P2, J6 | Sous-missions bornées, profondeur 1, budget partagé, worktree séparé, intégration après tests | L | Oui |
| Sous-agent externe (Claude Code, Codex, ACP) | Non | Déléguer une mission à un CLI d'agent installé via ACP, sous contrat et journal d'audit | L | Hors OpenRouter (CLI tiers) |
| Workflows et boucle d'agents neufs | Non | « Recette de mission » : suite de sous-missions déclarées en YAML, chaque étape ayant son critère de preuve | L | Oui |
| Objectif persistant + continuation auto | Partiel : A9 (missions avec critères, reprise après plantage) | Mission « jusqu'à preuve » : relance automatique bornée par budget et nombre de tours tant que le critère n'est pas rempli | M | Oui |
| Mode plan | Oui : Planifier (A12), plan éditable (A9) | — | — | — |
| Sandbox OS (bwrap, Seatbelt, ACL Windows) | Partiel : L0 seulement ; bubblewrap détecté mais jamais présenté comme actif (STATUS) | Activer S3 L1 (J3), afficher le niveau réel | L | Sans objet |
| Préréglages de permission + approbation | Oui : S1 (4 profils), carte d'approbation (J2-A) | « Relecture auto » optionnelle : un second modèle bon marché commente chaque appel risqué, la décision reste humaine | M | Oui |
| Trajectoire : rejouer, forker, chercher | Partiel : `mission_events` en ajout seul + journal d'audit S5 | Vue « Chronologie » : reprendre ou forker une mission depuis un événement, recherche FTS (Pr7) | M | Sans objet |
| Compaction auto et `/compact` | Non : C7 prévu en J3, jamais silencieux | Dossier de passation (A15) proposé à 80 % du contexte, affiché comme résumé | S–M | Oui (`contextLength` du catalogue) |
| Skills + skills Office | Non : M8 en J3 | Format Agent Skills déjà spécifié ; en plus, skills « documents » (docx/xlsx/pptx) en local | M | Oui |
| Livrables et fichiers modifiés en fin de tour | Oui : A11 (relecture, acceptation partielle), F7 (Bibliothèque) | Ajouter un outil `deliver` qui ajoute les fichiers livrés à la Bibliothèque | S | Sans objet |
| MCP | Oui : M1, M3–M5 (J2-A, sans OAuth) | OAuth M2 (J3), ressources M6 | M | Sans objet |
| Mémoire | Partiel : C3 (`.nova/MEMORY.md`, `memory_items`), C4 en J4 | Mémoire explicite et révocable (C4). Avantage NOVA : pas de mémorisation implicite | S | Sans objet |
| Tâches planifiées | Non : Pr5 en J4 | Missions planifiées (`croner`) avec contrat persistant, sous la voix de Nomi | M | Oui |
| Webhook GitHub → relecture de PR | Non | Déclencheur « PR prête » : mission Vérifier en lecture seule (Pr5 étendu, J7) | M | Oui |
| Navigateur agent | Non : A7 en J2-B | Déjà conçu (WebContentsView + CDP, session isolée) | L | Sans objet |
| Computer use (piloter le bureau) | Non (hors catalogue) | Mode « Montre-moi » limité : captures V2 + actions sur une seule fenêtre choisie, chaque clic approuvé | XL | Modèles vision oui ; pas d'outil natif via OpenRouter |
| Voix (dictée locale) | Non : V4 en J4 | Déjà conçu (Whisper ONNX local) | L | Option `input_audio` à vérifier |
| Hooks compatibles Claude/Codex | Non : M9 en J3 | Hooks `.nova/hooks.json` ; import optionnel des hooks de Claude Code | M | Sans objet |
| SSH distant | Non | Espace de travail distant (sftp + exec) derrière les mêmes permissions | L | Sans objet |
| SDK Python / mode sans interface | Non : M7 en P2 | `nova mcp` / CLI sans interface (M7, décision D9) | M | Sans objet |
| Fournisseurs multiples | Partiel : OpenRouter seulement ; Mo4 en P2 | DeepSeek est déjà joignable via OpenRouter ; un adaptateur direct n'est pas prioritaire | L | Oui |

## 4. Priorités suggérées pour NOVA

Les écarts qui comptent le plus vis-à-vis de DeepSeek Harness :

1. **Brancher le terminal de l'agent et le suivi des processus** : petits manques déjà connus dans STATUS.
2. **Compaction et dossier de passation** (C7 et A15).
3. **Skills**, y compris pour les documents Office.
4. **Mode « Chaîne »** (équivalent PTC).
5. **Sous-missions bornées.**
6. **Missions planifiées.**

Là où NOVA a déjà un avantage : budget par mission avec réservation, preuves par critère, retour arrière fichier par fichier, compagnon Nomi.

Le computer use et le sous-agent externe restent coûteux et expérimentaux chez DeepSeek aussi.
## 5. Ce que NOVA couvre après J2-B

Mise à jour du 2026-09-28, après la vérification finale de la branche `feat/j2b-parite-harness` (tête `65fce37`, non poussée). Tout ce qui est marqué « couvert » a été vérifié sur Linux x64 contre le faux serveur OpenRouter (lint, types, 2 239 tests unitaires, Playwright 46/46 deux fois ; détail dans [`../STATUS.md`](../STATUS.md)). Rien n'a encore tourné avec un vrai compte OpenRouter, ni sur Windows ou macOS. Les équivalents sont des conceptions propres à NOVA (noms, parcours, interface en français), pas des copies de l'app DeepSeek.

| Fonction DeepSeek Harness (§2B) | État dans NOVA | Voie et preuve | Ce qui manque encore |
|---|---|---|---|
| Terminaux interactifs pilotés par l'agent | Couvert | L1 : processus de mission dans une session d'agent du pty-host, en lecture seule ; « Prendre la main » la rend à l'utilisateur et la détache de la mission (`j2b-terminal-agent.spec.ts`) | Windows : chemin pty testé seulement avec un faux spawn |
| Tâches en arrière-plan (`job_*`) | Couvert | L1 : `process_list`, `process_output`, `process_stop` (approuvé), plafond par mission, aucun orphelin à la sortie | — |
| Compaction auto et `/compact` | Couvert, jamais silencieux | L2 : résumé proposé à 80 % du contexte, appliqué seulement par l'utilisateur ; « /compact » en Discuter (`j2b-compaction.spec.ts`) | Pas de compaction automatique sans accord (choix NOVA) ; un résumé proposé ne s'applique plus après un redémarrage |
| Changement de modèle en cours de session | Couvert | L2 : dossier de passation (A15), requête suivante sur le nouveau modèle | — |
| Skills (outil `skill`, projet et utilisateur) | Couvert en partie | L3 : aperçu avant installation, activation par projet, chargement à la demande, désinstallation sans résidu, 3 skills livrées (`j2b-skills.spec.ts`) | Installation depuis Git, mises à jour, scripts des skills hors projet, skills Office |
| Mode Code / PTC | Couvert (mode « Chaîne ») | L4 : un programme JS dans l'hôte `chain-host` ; chaque appel passe par le moteur de permissions dans le main et par les approbations, imbriqué sous sa carte ; un refus lève une erreur dans le programme (`j2b-chain.spec.ts`) | `vm` n'est pas une frontière de sécurité (ADR-022) |
| Sous-agents (neufs ou « fork ») | Couvert en partie (sous-missions) | L5 : `start_submission`, profondeur 1, worktree séparé, budget du parent réservé et refusé au-delà, intégration après tests (`j2b-submissions.spec.ts`) | Intégration manuelle ; conflits non listés ; pas d'équipes d'agents ; pas de sous-agent externe (Claude Code, Codex, ACP) |
| Workflows et boucle « ralph » | Non couvert | — | « Recette de mission » (§3) non commencée |
| Tâches planifiées (« Automation tasks ») | Couvert | L6 : unique, intervalle, quotidien, hebdomadaire, cron ; exécution comme une mission normale avec contrat persistant, historique, **pause** (absente chez DeepSeek) (`j2b-schedules.spec.ts`) | Le modèle ne crée pas lui-même de planification ; exécution seulement quand NOVA tourne |
| App de bureau : barre système, tâches qui continuent fenêtre fermée, avertissement avant de quitter | Couvert | L7 : option « garder en marche », menu de la barre avec l'état réel de Nomi et les missions en cours, « Quitter NOVA » qui avertit (`j2b-desktop.spec.ts`) ; NOVA tourne aussi sous Linux | Icône parfois invisible sous certains bureaux Linux ; mises à jour signées non faites (Q3) |
| Parcours d'accueil (usage et niveau de détail) | Couvert | L7 : profil code ou documents, densité « résultat / étapes clés / tout », réglable ensuite | — |
| Mode unique qui choisit seul réflexion et recherche | Couvert en option | L7 : pilote automatique de Discuter, choix affiché et modifiable avant l'envoi | Absent de l'accueil ; coût du classement affiché, pas enregistré |
| Vision sans changer de mode | Couvert | L7 : image collée avec un modèle texte → modèle vision du catalogue proposé ; image envoyée une fois, jamais stockée | « Relancer » ne renvoie pas les images |
| Objectif persistant + continuation en « Rounds » | Couvert (« jusqu'à preuve ») | L8 : tours bornés par nombre (10 au plus) et par un plafond dans le budget de la mission, arrêt dès que les critères sont prouvés ou au plafond (`j2b-proof-timeline.spec.ts`) | Un tour déjà lancé peut dépasser le plafond de poursuite d'au plus ce tour |
| Trajectoire : chercher, forker, reprendre | Couvert en partie | L8 : recherche FTS dans le journal des missions, « Bifurquer d'ici » (mission liée, rien de rejoué) | Pas de rejeu ; le raisonnement n'est jamais conservé ni affiché (ADR-008), à la différence du journal DeepSeek |
| Repli du raisonnement | Écart volontaire | ADR-008 : le raisonnement est signalé (phase « réflexion »), jamais conservé ni affiché | — |
| LSP, navigateur agent, webhook GitHub, computer use, voix, hooks, SSH, SDK, mises à jour signées, sandbox OS | Non couverts par J2-B | Voir le tableau §3 et `FEATURES.md` (E5, A7, Pr5 étendu, V4, M9, S3 L1, S8) | Inchangé |

Avantages NOVA conservés et renforcés par J2-B : budget par mission avec réservation, désormais partagé avec les sous-missions ; preuves par critère qui arrêtent la poursuite ; permissions évaluées dans le main avant tout effet, y compris pour chaque appel d'un programme « Chaîne » ; contenu non fiable (W5) suivi à travers sous-missions, bifurcations et index de skills.
