# NOVA — Expérience utilisateur de référence

Version 1 · 27 septembre 2026 · `docs/design/UX.md`

Ce document décrit l'expérience cible de NOVA : un atelier personnel d'IA qui devient un éditeur de code avec un agent autonome (Internet, terminal, connecteurs MCP, aperçus) et un compagnon, Nomi, qui agit. Il complète `PRODUCT.md` (promesse, périmètre), `DESIGN_SYSTEM.md` (tokens, composants, ton) et `ACCEPTANCE.md` (scénarios). Quand un point est déjà livré en J1, il est repris tel quel ; quand il est à construire (J2+), il est marqué du jalon proposé.

**Sources** : `docs/PRODUCT.md`, `docs/ACCEPTANCE.md`, `docs/ROADMAP.md`, `docs/DESIGN_SYSTEM.md`, `docs/DECISIONS.md`, `docs/SECURITY.md`, `apps/desktop/src/renderer/copy/fr.ts`, captures `apps/desktop/e2e/artifacts/screens/*.png`, brief maître du 27 septembre 2026.

**Hypothèses de rédaction**

- Forme d'adresse : tutoiement, comme la copie actuelle (question Q7 ouverte ; si le vouvoiement est retenu, toute la microcopie ci-dessous se convertit mécaniquement).
- Toute microcopie entre guillemets « » est un texte proposé, prêt à entrer dans `copy/fr.ts`. Les textes déjà en production sont repris à l'identique.
- « Inconnu » s'écrit « inconnu ». Jamais 0, jamais une estimation présentée comme une mesure.
- Aucun modèle, prix ou capacité n'est codé en dur dans ce document : ce qui est affiché vient du catalogue en direct.

---

## Sommaire

1. Principes UX
2. Personas et jobs-to-be-done
3. Les 10 premières minutes, minute par minute
4. Modèle mental et architecture d'écran
5. Parcours de bout en bout (13 parcours)
6. Créer et Expert
7. Confiance et contrôle
8. Catalogue des états (vide, chargement, hors ligne, erreur, succès, refusé)
9. Stratégie de notification
10. Parcours d'accessibilité
11. Internationalisation
12. Métriques et protocole de test d'utilisabilité
13. Les 30 détails qui font la différence
14. Annexes : vocabulaire, questions pour le propriétaire

---

## 1. Principes UX

Dérivés des principes produit, formulés comme des règles de conception vérifiables.

| # | Principe | Règle de conception | Comment on le vérifie |
| --- | --- | --- | --- |
| 1 | Un résultat visible avant tout | Chaque action de l'utilisateur ou de l'agent se termine par un état visible ou par une raison enregistrée. Une action qui ne produit rien de visible est le pire défaut. | Test : aucun clic, aucune commande vocale, aucune fin de mission sans changement d'état affiché. |
| 2 | Preuves, pas promesses | NOVA n'écrit « Le test passe » qu'après l'avoir lancé. Ce qu'il n'a pas vérifié est « non vérifié ». Ce qu'il ne sait pas est « inconnu ». | Relecture de toute microcopie affirmative : chaque affirmation a une preuve cliquable. |
| 3 | La main reste à l'utilisateur | Fichiers, dépenses, permissions, données envoyées : quatre curseurs toujours visibles, jamais modifiés en silence. | Chaque écran de mission montre les quatre. |
| 4 | Simple d'abord, avancé à portée | Mode Créer par défaut ; toute information détaillée est à un clic (« Voir le détail ») sans changer de mode. | Aucune fonction n'exige le mode Expert pour être atteinte. |
| 5 | Demander peu, demander bien | Une confirmation porte sur une décision réelle, dans son contexte, avec sa provenance. Jamais deux fois la même chose dans une mission. | Métrique « interruptions inutiles ». |
| 6 | Annulable par défaut | Tout changement local se restaure à la granularité du fichier. Ce qui ne peut pas s'annuler (e-mail, déploiement, paiement) est annoncé avant. | Scénarios 4, 5, 11. |
| 7 | Nomi reflète le réel | Aucun état, animation ou message sans événement du runtime. Nomi informe et interrompt seulement quand il le faut. | Scénario 14 ; audit des états. |
| 8 | Calme | Pas de badge rouge décoratif, pas de compteur, pas de culpabilisation, pas de manipulation d'attention. | Section 9. |
| 9 | Accessible par construction | Clavier, lecteur d'écran, contraste, mouvement réduit : sur chaque parcours livré, pas après. | Scénario 15 par jalon. |
| 10 | Les mots du quotidien | Créer : « changements », « dossier », « ce qui part sur Internet ». Expert : « diff », « workspace », « jetons ». Même logique, deux densités. | Glossaire (annexe A). |

---

## 2. Personas et jobs-to-be-done

Les trois personas de `PRODUCT.md` sont conservées. Une quatrième est ajoutée pour couvrir le public « développeur » du brief, et une anti-persona cadre ce que NOVA ne cherche pas à servir.

### 2.1 Léa, 34 ans — graphiste indépendante (mode Créer)

**Contexte.** Copie du code depuis un assistant dans le navigateur, ne sait pas le vérifier, a déjà cassé son site une fois.

**Jobs-to-be-done**

- Quand j'ai une idée de site ou d'outil, je veux la décrire avec mes mots et voir quelque chose qui marche, pour savoir vite si ça vaut le coup de continuer.
- Quand quelque chose a changé, je veux comprendre ce qui a changé sans lire le code, pour décider de garder ou non.
- Quand je fais une erreur, je veux revenir en arrière sans y perdre une heure, pour oser essayer.

**Peurs** : casser ce qui marche ; payer sans comprendre ; envoyer ses fichiers clients « quelque part ».

**Moments de vérité** : le premier aperçu ; le premier « Annuler » qui restaure vraiment ; le premier résumé de changements lisible.

**Signal de succès** : elle modifie son portfolio seule une deuxième fois, sans aide.

### 2.2 Karim, 47 ans — gérant d'une entreprise de plomberie (mode Créer)

**Jobs-to-be-done**

- Quand mes devis dorment dans un tableur, je veux automatiser les relances, pour ne plus en oublier.
- Quand NOVA lit mes fichiers, je veux savoir exactement lesquels partent sur Internet et combien ça coûte, pour rester dans mes règles.
- Quand un outil me demande quelque chose, je veux une question en français, avec ce qui se passe si je dis oui ou non.

**Peurs** : perte de données clients ; coût qui dérape ; jargon.

**Moments de vérité** : la carte « Ce qui part sur Internet » avant la mission ; la jauge de budget ; la confirmation « Cette action enverra 3 fichiers à … ».

**Signal de succès** : une automatisation qui tourne trois semaines sans intervention et qu'il a pu suspendre lui-même.

### 2.3 Sofia, 28 ans — chargée d'études, scripts Python et petit site (mode Expert)

**Jobs-to-be-done**

- Quand mon site a un bug, je veux que NOVA le trouve, lance le test, et me montre un diff par fichier, pour accepter seulement ce qui est juste.
- Quand j'ouvre un dépôt inconnu, je veux une carte du projet, pour savoir par où commencer.
- Quand une tâche est simple, je veux un modèle économique ; quand elle est difficile, un modèle fort — sans y penser à chaque message.

**Peurs** : trop de fichiers modifiés d'un coup ; retour arrière impossible ; le modèle qui affirme avoir testé.

**Moments de vérité** : l'acceptation partielle ; le terminal contrôlé avec sa sortie brute ; les profils de modèles.

### 2.4 Marc, 41 ans — développeur indépendant (mode Expert, ajouté)

**Contexte.** Utilise déjà un IDE et des agents en ligne de commande. Vient pour l'agent autonome, les connecteurs MCP, le budget par mission et le rollback fiable.

**Jobs-to-be-done**

- Quand je délègue une tâche longue, je veux fixer le cadre (dossier, commandes, réseau, budget, durée) une fois, puis ne plus être dérangé sauf décision réelle.
- Quand l'agent tourne en rond, je veux le voir tout de suite et intervenir (indice, changement de modèle, arrêt) sans perdre le travail fait.
- Quand je branche GitHub ou Notion, je veux voir quels outils arrivent, avec quelles permissions, et les couper un par un.

**Peurs** : approbations en rafale ; commande destructrice passée en douce ; outil MCP qui s'auto-accorde des droits.

**Moments de vérité** : le contrat de mission ; la détection de boucle ; la carte d'approbation qui montre la provenance.

### 2.5 Anti-persona

Une équipe de dix développeurs cherchant un IDE complet avec débogueur intégré, revue de code multi-utilisateurs et CI. NOVA ne remplace pas un IDE professionnel (non-objectif) ; le projet reste utilisable avec ses outils standards hors de NOVA.

### 2.6 Carte des jobs communs

| Job | Léa | Karim | Sofia | Marc | Surface NOVA |
| --- | --- | --- | --- | --- | --- |
| Décrire une intention et obtenir un plan compréhensible | ●●● | ●●● | ●● | ● | Atelier, mode Planifier |
| Voir un résultat qui tourne | ●●● | ●● | ●●● | ●●● | Aperçu |
| Comprendre ce qui a changé | ●●● | ●● | ●●● | ●● | Changements (résumé + diff) |
| Revenir en arrière | ●●● | ●● | ●●● | ●●● | Restauration ciblée, annulation de mission |
| Savoir ce qui part et ce que ça coûte | ●● | ●●● | ●● | ●● | Trajet des données, jauge de budget |
| Déléguer longtemps sans être dérangé | ● | ●● | ●● | ●●● | Contrat de mission, profils |
| Brancher un service externe | ● | ●● | ●● | ●●● | Extensions, MCP |
| Parler plutôt qu'écrire | ●● | ●●● | ● | ● | Nomi, voix |

---

## 3. Les 10 premières minutes

Objectif : de l'installation au premier résultat visible et gardé en moins de 10 minutes, sans compte, sans GitHub, sans lire de documentation. Le chronomètre part au double-clic sur l'installeur. Léa sert de fil rouge ; les variantes Karim/Sofia/Marc sont notées.

Ce qui existe déjà (J1) est signalé « livré » ; le reste est la cible J2.

### Minute 0 — Télécharger et installer

**Site de téléchargement** (hors application, mais partie du parcours)

- Un bouton par plateforme, détectée : « Télécharger pour Linux (x64) · 84 Mo ». Sous le bouton : « Somme de contrôle SHA-256 · Afficher ».
- Matrice de support honnête, reprise de `STATUS.md` : « Testé sur : Linux x64. Construit, non testé manuellement : Windows, macOS. »
- Tant que la signature de code (Q3) n'est pas en place, un encadré avant le téléchargement, pas après :
  « Sans signature éditeur pour l'instant. Windows affichera un avertissement SmartScreen, macOS demandera d'autoriser l'ouverture dans Réglages › Confidentialité et sécurité. Voici comment faire, capture à l'appui. »

**Installeur**

- Aucun choix à faire sauf l'emplacement (valeur par défaut correcte). Pas de case « lancer au démarrage », pas de barre d'outils, pas de newsletter.
- Dernière page : « NOVA est installé. Tes données resteront dans `~/.config/NOVA` (Linux). Rien n'est envoyé tant que tu n'as pas ajouté de clé. » Bouton : « Ouvrir NOVA ».

### Minute 1 — Premier lancement (livré, ajustements proposés)

Écran de bienvenue actuel (capture 01) : « Bienvenue dans NOVA · Connecte OpenRouter pour commencer ». Il est bon. Ajustements :

1. Ajouter, sous le titre, une ligne de cadrage qui répond à la question « pourquoi une clé ? » sans jargon :
   « NOVA n'a pas de compte ni d'abonnement. Il parle aux modèles d'IA avec ta clé OpenRouter : c'est toi qui choisis les modèles et qui paies directement, au jeton près. »
2. Le lien « Créer une clé sur openrouter.ai » ouvre le navigateur et affiche, dans NOVA, un mini-guide de trois lignes qui reste à l'écran :
   « 1. Crée un compte OpenRouter. 2. Ajoute quelques euros de crédit (2 € suffisent pour commencer). 3. Clés › Créer une clé, puis colle-la ici. »
   Avec la mention « Le montant est une suggestion, pas un prérequis : le crédit gratuit d'OpenRouter, quand il existe, fonctionne aussi. »
3. Niveau de coffre : garder l'encadré actuel. Quand le coffre système est disponible, il n'y a rien à lire ; « Coffre du système (recommandé) » est présélectionné. Sur coffre faible, la copie actuelle est exacte ; ajouter un lien « Comment installer un trousseau ? » vers une page d'aide par distribution.

**Microcopie (livrée)** : « Ta clé reste sur cet appareil. Chaque message est envoyé à OpenRouter puis au fournisseur qui sert le modèle. »

**Nomi** (bas de la navigation) : « Pas encore connecté · Ajoute une clé OpenRouter pour commencer. » (livré)

**Cas limites minute 1**

| Cas | Comportement | Microcopie |
| --- | --- | --- |
| Clé collée avec espace ou retour à la ligne | Nettoyée silencieusement ; aucun message. | — |
| Clé qui ne commence pas par `sk-or-` | Avertissement non bloquant avant l'envoi. | « Ce texte ne ressemble pas à une clé OpenRouter (elles commencent par sk-or-). Tu peux quand même tester. » |
| Clé invalide (capture 12) | Livré. | « La clé OpenRouter est refusée · OpenRouter ne reconnaît pas cette clé : elle a peut-être été révoquée ou mal copiée. » |
| Hors ligne à la vérification | Livré : enregistrée non vérifiée. | « Clé enregistrée, mais pas encore vérifiée · OpenRouter est injoignable pour l'instant. Elle est bien enregistrée : teste-la quand tu veux. » |
| Crédit à 0 | Clé valide, écran suivant, avec un avis. | « Clé vérifiée · Reste : 0,00 $. Les messages échoueront tant que le crédit n'est pas rechargé. » Bouton « Ouvrir la page des crédits ». |

### Minute 2 — Clé vérifiée, choisir un modèle (livré, ajustements proposés)

Capture 02 : « Clé vérifiée · Libellé, Limite, Reste, Consommé, Offre » puis « Choisis un modèle ». La phrase « NOVA ne choisit pas à ta place » est fidèle au principe 2 du produit. Pour éviter la paralysie du choix (dix modèles minimum, plusieurs centaines en réel) sans coder un modèle en dur :

1. Un bloc « Pour commencer » calculé à partir du catalogue en direct, jamais d'une liste figée :
   « Pour commencer · Trois modèles du catalogue actuel qui savent utiliser des outils (nécessaire pour les missions), triés par prix d'entrée. Tu pourras en changer à tout moment. »
   Chaque carte : nom, prix entrée/sortie, contexte, capacités, et une ligne « Pourquoi ici : outils oui · parmi les moins chers · disponible avec ta politique de confidentialité ».
2. Le filtre « Outils » est activé par défaut sur ce premier écran seulement, avec un texte : « Filtre actif : modèles capables d'utiliser des outils. Retire-le pour tout voir. »
3. Le prix est traduit une fois en ordre de grandeur, calculé, pas deviné :
   « À ce prix, 1 000 messages courts coûtent environ 0,04 $ (estimation d'après le tarif affiché). »

**Nomi** : « Nomi est disponible · Connecté à OpenRouter · clé vérifiée à l'instant » (livré).

**Variante Sofia/Marc** : lien discret « Voir tout le catalogue en tableau » qui affiche identifiants, contexte, prix, capacités, date de retrait — c'est la vue Expert du sélecteur.

### Minute 3 — Accueil : une idée ou un dossier

Écran Atelier actuel (capture 03) : « Une idée, une question, un brouillon : Nomi t'aide à en faire quelque chose. » En J2, l'accueil gagne une seconde entrée. Deux cartes côte à côte, même poids visuel :

- **Nouvelle idée** — champ libre (livré). Placeholder mis à jour : « Par exemple : un site portfolio avec mes projets, ou : relance automatique de mes devis en retard… »
- **Ouvrir un dossier** — « Choisir un dossier sur cet ordinateur · NOVA n'y touchera pas sans te le dire. »

Sous les cartes, « Reprendre » (vide au premier lancement : « Tes projets et conversations apparaîtront ici. »).

L'avis bleu actuel « Fichiers, terminal et missions arrivent au prochain jalon… » disparaît en J2 ; il est remplacé par la ligne de trajet des données, toujours visible dans la zone de saisie : « Ce message partira vers OpenRouter → [fournisseur]. Aucun fichier joint. »

Léa écrit : « Je veux un site portfolio simple avec mes projets et un formulaire de contact. »

### Minute 4 — Clarifier, deux questions maximum

NOVA passe en mode **Planifier**. Il ne construit rien encore. Nomi : « Nomi réfléchit… ».

Règle : au plus deux questions bloquantes, posées ensemble, avec des réponses par défaut visibles ; tout le reste devient une hypothèse annoncée dans le plan.

« Deux points avant de planifier :
1. **Où créer le projet ?** — Dossier proposé : `~/Documents/NOVA/portfolio` · [Changer]
2. **Le formulaire de contact doit envoyer un e-mail ?** — Ça demande un service externe (à configurer plus tard). Pour commencer, je peux enregistrer les messages dans un fichier local. · (●) Fichier local pour l'instant ( ) Service d'e-mail, on verra ensemble

[Continuer avec ces réponses] »

Note pour Karim (tableur) : la question 1 devient « Quel fichier contient tes devis ? » avec un sélecteur de fichier et l'avis « Ce fichier sera lu par le modèle : il partira vers OpenRouter → [fournisseur]. »

### Minute 5 — Le plan et le contrat de mission

Un seul écran, deux blocs.

**Le plan** (mode Créer)

« **Plan : portfolio de Léa**
1. Créer la structure du site (page d'accueil, page projets, page contact) — 6 fichiers
2. Ajouter trois projets d'exemple que tu remplaceras — 1 fichier
3. Formulaire de contact qui enregistre localement — 2 fichiers
4. Lancer l'aperçu et vérifier que les trois pages s'ouvrent — 1 commande

Hypothèses : site statique, sans base de données, sans hébergement pour l'instant.
Ce que ça ne fait pas encore : envoi d'e-mail, mise en ligne. »

Chaque étape est dépliable : ce qu'elle lit, ce qu'elle écrit, ce qu'elle lance. Expert voit en plus les chemins de fichiers et les commandes exactes.

**Le contrat** (voir section 7.1 pour la définition complète)

« **Ce que Nomi peut faire seul pendant cette mission**
- Lire et modifier : `~/Documents/NOVA/portfolio` uniquement
- Lancer : le serveur d'aperçu, l'installation des dépendances du projet
- Internet : OpenRouter (modèle) · aucune autre adresse
- Durée : jusqu'à 10 min · Budget : jusqu'à 0,50 $ (estimation 0,05 – 0,20 $)
- Te demandera avant : supprimer un fichier, installer un outil hors du projet, toute autre adresse Internet

Profil : Assisté · [Modifier le contrat] »

Boutons : « **Lancer la mission** » (principal) · « Essai à blanc » (J3) · « Modifier le plan ».

Sofia/Marc : « Modifier le plan » ouvre le plan en texte éditable ; le contrat expose les motifs de chemins, hôtes, commandes autorisées.

**Cas limites**

| Cas | Comportement |
| --- | --- |
| Modèle choisi sans capacité « outils » | Bouton « Lancer » désactivé avec raison : « Ce modèle ne sait pas utiliser d'outils, nécessaire pour une mission. [Choisir un modèle avec outils] ». Le filtre s'ouvre pré-appliqué. |
| Estimation impossible (prix inconnu) | « Coût : inconnu (le catalogue ne donne pas le prix de ce modèle). Le plafond de 0,50 $ s'applique quand même, sur ce qui sera rapporté. » |
| Dossier cible non vide | « Ce dossier contient déjà 12 fichiers. Nomi ne les modifiera pas sans te le montrer. Continuer ici, ou choisir un autre dossier ? » |
| Crédit restant inférieur au plafond | « Ton crédit OpenRouter (0,30 $) est inférieur au plafond (0,50 $). La mission s'arrêtera au crédit. » |

### Minute 6 à 8 — La mission tourne

L'écran devient la **carte de mission vivante** (centre) et le **panneau de travail** (droite, onglet Aperçu prêt à s'ouvrir).

Carte (Créer) :

« **Mission en cours** · étape 2 sur 4 · 0,03 $ constaté · 1 min 40 s
✓ Structure du site — 6 fichiers créés
● Projets d'exemple — écriture de `projets.html`
○ Formulaire de contact
○ Aperçu et vérification

[Arrêter] [Mettre en pause] »

Chaque ✓ ouvre sa preuve : la liste des fichiers, ou la sortie de la commande. Expert voit en plus le fil des appels d'outils en temps réel (nom, arguments résumés, durée, résultat) et la sortie du terminal.

Nomi : « Nomi travaille · Étape 2 : projets d'exemple ». L'orbite tourne parce qu'un flux est réellement actif.

Règle de silence : pendant la mission, aucune notification tant que la fenêtre est au premier plan. Si Léa change de fenêtre, une notification système seulement à la fin, ou si une décision est attendue.

### Minute 8 — Le premier résultat visible

L'aperçu s'ouvre seul dans le panneau de travail (c'est l'étape 4 du plan, donc dans le contrat). Bannière au-dessus de l'aperçu :

« Aperçu local · `http://127.0.0.1:5173` · visible seulement sur cet ordinateur · [Ouvrir dans le navigateur] »

La carte passe à :

« **Mission terminée** · 2 min 50 s · 0,07 $ constaté (estimation : 0,05 – 0,20 $)
9 fichiers créés, 0 modifié, 0 supprimé · 1 commande lancée
Vérifié : les trois pages répondent (code 200). Non vérifié : affichage sur mobile, envoi du formulaire.

[Relire les changements] [Garder tout] [Annuler tout] »

Le mot « Vérifié » n'apparaît que pour ce qui a été exécuté ; « Non vérifié » liste explicitement ce qui ne l'a pas été. C'est la « relecture par preuves » du produit.

### Minute 9 — Relire et garder

« Relire les changements » ouvre l'onglet **Changements** :

Créer : « 9 nouveaux fichiers. Aucun de tes fichiers existants n'a été touché. » puis la liste, chaque fichier avec « Voir » et un résumé d'une ligne écrit à partir du diff réel (« page d'accueil : titre, présentation, trois cartes de projets »).

Expert : diff par fichier, par bloc, avec cases à cocher ; « Garder » / « Restaurer » par fichier.

Léa clique « Garder tout ». Confirmation immédiate, sans dialogue : bandeau vert « 9 fichiers gardés · Point de reprise créé · Tu peux revenir en arrière depuis l'historique du projet. »

### Minute 10 — Corriger en pointant (J6) ou en écrivant (J2)

Léa voit que le titre est trop petit. J2 : elle écrit « Le titre de la page d'accueil est trop petit ». J6 : elle clique sur le titre dans l'aperçu, l'entoure, écrit la même phrase.

NOVA : « Petite correction (1 fichier). Pas besoin de nouveau contrat : c'est dans le cadre de la mission précédente, encore valable 7 min. » → modifie, l'aperçu se recharge, carte « 1 fichier modifié · [Garder] [Annuler] ».

**Fin des 10 minutes** : Léa a un site local qui tourne, sait ce qui a été créé, sait combien ça a coûté (0,07 $), sait ce qui n'a pas été vérifié, et sait comment revenir en arrière. Elle n'a répondu qu'à deux questions et n'a validé qu'un contrat.

### Variantes des 10 minutes

| Persona | Différence principale |
| --- | --- |
| Karim | Minute 3 : « Ouvrir un dossier » puis « Quel fichier contient tes devis ? ». Minute 5 : le contrat affiche « Fichiers qui partiront vers le modèle : `devis.xlsx` (feuille 1, 40 lignes) » et l'option « Masquer les colonnes : e-mail, téléphone » avant l'envoi. Résultat visible : un tableau des devis en retard avec le brouillon de relance, rien d'envoyé. |
| Sofia | Minute 3 : ouvre son dépôt. Minute 4 : « Décris le bug » ; NOVA propose « Corriger » comme mode. Minute 8 : la preuve est la sortie de `pytest` réellement lancée. Minute 9 : diff par fichier, acceptation partielle. |
| Marc | Minute 2 : vue tableau du catalogue. Minute 5 : passe en Expert (Ctrl+Maj+E), édite le contrat (commande `pnpm test` autorisée, hôte `registry.npmjs.org` autorisé). Minute 6 : suit le terminal en direct. |

---

## 4. Modèle mental et architecture d'écran

### 4.1 Les objets que l'utilisateur manipule

| Objet | Mot Créer | Mot Expert | Définition en une phrase |
| --- | --- | --- | --- |
| Projet | projet | workspace | Un dossier de ton ordinateur sur lequel NOVA travaille. |
| Conversation | conversation | conversation | Un échange avec un modèle, avec ou sans projet. |
| Mission | mission | mission | Un travail confié à Nomi avec un plan, un contrat et un résultat. |
| Changements | changements | diff | Ce qu'une mission a modifié sur le disque, fichier par fichier. |
| Point de reprise | point de reprise | checkpoint | Un état enregistré du projet auquel on peut revenir. |
| Preuve | preuve | preuve | Ce qui a été réellement exécuté pour vérifier une étape. |
| Contrat | ce que Nomi peut faire seul | contrat de mission | Le cadre d'autonomie d'une mission. |
| Connexion | service connecté | serveur MCP | Un service externe (GitHub, Notion…) branché à NOVA. |
| Skill | savoir-faire | skill | Une méthode réutilisable que Nomi peut suivre. |

### 4.2 Trois zones

Livrée en J1 : navigation (gauche), conversation (centre), panneau Contexte (droite). En J2 le panneau droit devient le **panneau de travail** à onglets : **Aperçu · Fichiers · Changements · Terminal · Preuves · Contexte**. Un onglet n'apparaît que s'il a du contenu ou que le projet le rend possible (pas d'onglet Terminal sans projet ouvert).

- Redimensionnables à la souris et au clavier (poignée focalisable : flèches = 16 px, Maj+flèches = 64 px, Début/Fin = réduire/étendre).
- Chaque zone est une région ARIA nommée : « Navigation principale », « Conversation », « Panneau de travail ».
- Sous 960 px de large : navigation en tiroir (livré), panneau de travail en feuille dépliable depuis le bas avec sa barre d'onglets visible.

### 4.3 Espaces

Reprise de `PRODUCT.md`. Un espace n'apparaît dans la navigation que lorsqu'il fonctionne.

| Espace | Ce qu'on y fait | Entrée principale |
| --- | --- | --- |
| Accueil | Reprendre, nouvelle idée, ouvrir un dossier, connexions manquantes | Nav |
| Atelier | Conversation ou mission sur un projet, avec le panneau de travail | Nav, palette |
| Missions | Carte des missions (en cours, en attente, suspendues, terminées), historique, points de reprise | Nav (J2) |
| Bibliothèque | Mémoire, documents, productions, exports | Nav (J3) |
| Extensions | Skills, services connectés (MCP), hooks, permissions | Nav (J3) |
| Compagnon | Nomi : apparence, voix, présence, confidentialité | Nav (J4) |
| Réglages | Fournisseurs, modèles, budget, confidentialité, apparence, raccourcis, diagnostics | Nav, Ctrl+, |

### 4.4 Modes de travail

Les modes changent les outils et permissions disponibles, pas seulement un prompt. Ils sont affichés comme un contrôle segmenté au-dessus de la zone de saisie quand un projet est ouvert.

| Mode | Peut lire | Peut écrire | Peut lancer | Sortie attendue | Quand NOVA le propose |
| --- | --- | --- | --- | --- | --- |
| Discuter | rien du projet (sauf fichiers joints) | non | non | réponse | pas de projet, ou question générale |
| Comprendre | le projet | non | commandes de lecture (`ls`, `git status`, tests en lecture seule) | carte du projet, explications avec liens vers les fichiers | nouveau dossier ouvert |
| Planifier | le projet | non | non | plan + contrat | intention de construire ou corriger |
| Construire | le projet | oui, dans le contrat | selon contrat | changements + preuves | plan validé |
| Corriger | le projet | oui, ciblé | tests | changements + test qui repasse | mot « bug », « erreur », « ne marche plus » |
| Vérifier | le projet | non | tests, lint, build | rapport de preuves | avant « Garder », ou sur demande |

Passage automatique proposé, jamais imposé : « Ça ressemble à un bug. Passer en mode Corriger ? [Oui] [Rester en Discuter] ». Le choix est mémorisé pour la conversation.

### 4.5 Barre de commande (Ctrl+K)

Livrée. Elle devient l'accès universel : actions, conversations, projets, missions, fichiers du projet (`>` pour les commandes, `@` pour un fichier, `#` pour une mission, `/` pour un mode). Toute action présente dans l'interface y figure avec son raccourci.

### 4.6 Nomi dans l'atelier

Pastille en bas de navigation (livré). En J2+, elle gagne une ligne de contexte cliquable : « Nomi attend ta réponse · 1 approbation en attente » ouvre directement la carte concernée. Nomi n'a jamais de bulle de dialogue qui flotte au-dessus du travail ; il parle dans la conversation.

---

## 5. Parcours de bout en bout

Format de chaque parcours : déclencheur, préconditions, étapes avec l'état visible, cas limites, microcopie, critère de réussite, scénario d'acceptation lié.

### 5.1 Idée → application construite et prévisualisée

**Déclencheur** : texte libre à l'accueil ou dans l'Atelier, en mode Discuter ou Planifier.
**Préconditions** : clé valide, modèle avec outils, dossier cible choisi ou proposé.

| Étape | Ce que voit l'utilisateur | État de Nomi | État de mission |
| --- | --- | --- | --- |
| 1. Intention | Message envoyé ; NOVA reformule en une ligne : « Tu veux : un outil de prise de rendez-vous avec calendrier et tableau de bord. C'est ça ? » [Oui] [Préciser] | réfléchit | — |
| 2. Clarification | Deux questions max, réponses par défaut (section 3, minute 4). | attend ta réponse | — |
| 3. Plan | Étapes, fichiers, commandes, hypothèses, « ce que ça ne fait pas ». | disponible | prête |
| 4. Contrat | Périmètre, actions, réseau, durée, budget, ce qui demandera confirmation. | disponible | prête |
| 5. Lancement | Carte de mission vivante ; panneau de travail. | travaille | en cours |
| 6. Question bloquante (éventuelle) | Carte d'approbation dans la conversation, mission en pause ; Nomi « attend ta réponse ». | attend | en attente d'autorisation |
| 7. Aperçu | Onglet Aperçu, adresse locale, bannière « visible seulement sur cet ordinateur ». | travaille | en cours |
| 8. Fin | « Mission terminée » : durée, coût constaté vs estimé, compteurs (créés/modifiés/supprimés), Vérifié / Non vérifié. | terminé, puis disponible | réussie |
| 9. Relecture | Changements (résumé ou diff), Preuves. | disponible | réussie |
| 10. Décision | Garder tout / garder une partie / annuler tout. | disponible | réussie (gardée) |

**Cas limites**

| Cas | Comportement | Microcopie |
| --- | --- | --- |
| Le plan dépasse le budget | Plan réduit proposé avant lancement. | « Ce plan coûterait entre 0,80 et 2,10 $, au-dessus de ton plafond (0,50 $). Je peux commencer par les étapes 1 à 2 (0,10 – 0,30 $), ou tu relèves le plafond pour cette mission. » |
| Besoin d'un service externe (e-mail, paiement, hébergement) | Jamais présenté comme fait ; étape « à configurer » explicite. | « L'envoi d'e-mail demande un service externe. Je prépare le code avec un exemple local ; la connexion réelle sera une mission à part, avec sa propre confirmation. » |
| Dépendances à installer | Dans le contrat par défaut si le projet a déjà un fichier de dépendances ; sinon demande. | « Installer 12 paquets depuis registry.npmjs.org (≈ 40 Mo) ? C'est nécessaire pour l'aperçu. [Installer] [Voir la liste] [Refuser] » |
| Port déjà pris | Choix automatique d'un autre port, annoncé. | « Le port 5173 est occupé : aperçu lancé sur 5174. » |
| Aperçu qui plante | Erreurs collectées, affichées dans Preuves, mission continue ou se suspend selon gravité. | « L'aperçu a rencontré 2 erreurs (console). Nomi va tenter une correction (itération 2 sur 5). » |
| Résultat partiel à la limite de durée | Mission suspendue, pas échouée ; état gardé. | « Temps écoulé (10 min). Étapes 1 à 3 terminées, étape 4 en cours. [Prolonger de 5 min] [Garder ce qui est fait] [Annuler tout] » |
| Modèle qui affirme sans exécuter | Impossible par construction : « Vérifié » ne s'affiche que depuis un événement d'outil. | Sinon : « Non vérifié : le modèle l'affirme, mais aucune commande n'a été lancée. » |

**Critère de réussite** : aperçu qui s'ouvre, décision Garder/Annuler prise, coût affiché, temps jusqu'au premier aperçu mesuré. Scénarios 4, 5, 6.

### 5.2 Corriger un bug dans un dépôt existant

**Déclencheur** : « Ouvrir un dossier » puis description du bug, ou message contenant une erreur collée.
**Préconditions** : dossier ouvert ; Git facultatif.

1. **Ouverture** — NOVA indexe localement (texte d'abord). Bandeau : « Dossier ouvert : `~/dev/site-asso` · 214 fichiers · Git détecté (branche `main`, 2 fichiers modifiés non enregistrés) · Rien n'a été envoyé. » Fichiers sensibles détectés (`.env`, clés) listés comme « Jamais envoyés au modèle » avec possibilité d'ajouter.
2. **Comprendre (proposé)** — « Veux-tu d'abord une carte du projet ? (lecture seule, ≈ 0,02 $) » [Oui] [Aller directement au bug]. Carte : structure, points d'entrée, commandes de test détectées, pièges connus.
3. **Décrire le bug** — Le texte collé (trace, erreur) est présenté comme donnée. NOVA reformule : « Symptôme : la page /membres affiche 500. Piste : `views/membres.py` ligne 42. Test concerné : `tests/test_membres.py::test_liste`. » Chaque référence est un lien qui ouvre le fichier.
4. **Plan Corriger** — « 1. Reproduire : lancer `pytest tests/test_membres.py` (attendu : échec). 2. Corriger. 3. Relancer le test (attendu : succès). 4. Lancer toute la suite. » Contrat : écriture limitée aux fichiers listés + tests ; commande `pytest` autorisée.
5. **Mission** — Preuve 1 : sortie brute de pytest en échec (repliée en Créer, dépliée en Expert). Modification. Preuve 2 : sortie en succès.
6. **Changements** — Diff par fichier. Les 2 fichiers modifiés par Sofia avant la mission sont marqués « Contient aussi tes modifications non enregistrées » ; le diff distingue ses lignes (grises) de celles de la mission.
7. **Décision** — Restauration ciblée : « Restaurer `utils.py` » remet exactement l'état d'avant la mission, y compris les modifications de Sofia.

**Cas limites**

| Cas | Comportement |
| --- | --- |
| Test introuvable / pas de commande de test | « Aucune commande de test détectée. Je peux corriger sans preuve automatique, et te montrer comment vérifier à la main. » — le résultat sera marqué « Non vérifié par un test ». |
| Le test ne reproduit pas le bug | « Le test passe déjà : le bug n'est pas reproduit. Je ne modifie rien tant que je ne l'ai pas vu. Peux-tu préciser comment le déclencher ? » |
| Correction qui casse un autre test | « Le test visé passe, mais 2 autres échouent maintenant. [Voir] · Nomi propose de continuer (itération 2 sur 5) ou d'arrêter ici. » |
| Conflit avec une modification utilisateur faite pendant la mission | Jamais écrasé : « Tu as modifié `membres.py` pendant la mission. Garder ta version, celle de Nomi, ou voir les deux ? » |
| Accès hors du dossier | Refusé par le moteur, visible : « Accès refusé : `../config/secrets.yml` est hors du projet. Rien n'a été lu. » |

**Critère** : test réellement lancé avant et après, diff identique au disque, restauration ciblée exacte. Scénarios 4, 5, 6.

### 5.3 Rechercher sur le Web avec sources

**Déclencheur** : question factuelle, ou étape de mission qui exige une information externe (version d'une bibliothèque, doc d'API).
**Préconditions** : outil « Recherche Web » activé dans le contrat ou dans le mode Discuter avec confirmation.

1. **Avant la première recherche** (une fois par projet) : « Pour répondre, Nomi veut chercher sur Internet. Ta question (et rien d'autre) sera envoyée au moteur de recherche configuré, puis les pages consultées seront lues et envoyées au modèle. [Autoriser pour ce projet] [Une seule fois] [Non] »
2. **Pendant** : carte « Recherche · 3 requêtes · 5 pages lues » avec la liste en direct : requête exacte, pages ouvertes (domaine, titre, taille), date de la page si connue.
3. **Réponse** : chaque affirmation appuyée sur une source porte un numéro ; la liste des sources en bas (titre, domaine, date de consultation, extrait cité). « Sources consultées mais non utilisées » repliées.
4. **Confiance** : « D'après 2 sources concordantes » / « Une seule source, non recoupée » / « Les sources se contredisent : … ». Jamais de synthèse sans mention de l'accord.
5. **Contenu hostile** : une page contenant des instructions (« ignore tes consignes… ») est présentée comme donnée ; si le modèle propose une action à cause d'elle, la carte d'approbation montre : « Demandé par le modèle après lecture de exemple.com/page — cette page contient des instructions. Vérifie avant d'accepter. »

**Cas limites** : hors ligne (« Recherche impossible : hors ligne. Je réponds avec ce que je sais, sans source vérifiée — à prendre avec prudence. ») ; moteur configuré injoignable ; page en paywall (« Page inaccessible (accès payant) : ignorée ») ; PDF volumineux (« Document de 240 pages : seules les 20 premières et la table des matières sont lues, pour rester dans le budget. »).

**Critère** : chaque source cliquable, requêtes exactes visibles, aucune affirmation « d'après Internet » sans source.

### 5.4 Connecter un service MCP (GitHub, Notion)

**Déclencheur** : Extensions › « Connecter un service », ou une mission qui en a besoin (« Pour créer l'issue, il faut connecter GitHub »).

1. **Choix** — Liste des connecteurs vérifiés par NOVA (avec version, provenance, licence) et « Ajouter un serveur MCP manuel » (Expert : commande stdio ou URL distante, transport de la spécification stable).
2. **Avant connexion** — Carte de prévisualisation : « GitHub · 14 outils · Ce que ce service pourra faire : lire tes dépôts, créer des issues, créer des pull requests. Ce qu'il ne pourra pas faire sans ta confirmation : fusionner, supprimer, publier. Authentification : compte GitHub (OAuth) dans ton navigateur. NOVA ne verra pas ton mot de passe. »
3. **Authentification** — Navigateur système. Dans NOVA : « En attente de ton autorisation dans le navigateur… [Annuler] ». Retour : « GitHub connecté · compte @sofia · accès : dépôts publics et privés. »
4. **Permissions par outil** — Tableau à trois positions par outil : Autoriser / Demander / Refuser. Défaut : lecture = Autoriser, écriture = Demander, destruction = Refuser. Bouton « Tester la connexion » qui liste les outils réels.
5. **Descriptions d'outils** — Affichées comme données, dans un cadre « Texte fourni par le serveur, non vérifié par NOVA ». Une description qui contient des instructions est signalée : « Cette description contient des consignes adressées au modèle : traitée comme du texte, jamais comme une règle. »
6. **Utilisation en mission** — Chaque appel apparaît dans Preuves : « GitHub › créer une issue · dépôt sofia/site-asso · titre : … · résultat : #42 ». Un appel à effet externe est précédé d'une approbation qui dit « Cette action ne pourra pas être annulée par NOVA. »

**Cas limites** (scénario 8)

| Cas | Microcopie |
| --- | --- |
| Serveur arrêté pendant une mission | « GitHub ne répond plus (serveur arrêté). La mission est en pause à l'étape 3. [Reconnecter] [Continuer sans GitHub] [Arrêter] » |
| Délai dépassé | « GitHub › lister les issues : pas de réponse en 30 s. Abandonné. La mission continue avec l'étape suivante. » |
| Outil désactivé demandé par le modèle | « Le modèle a voulu utiliser GitHub › supprimer un dépôt, que tu as refusé. Rien n'a été fait. » |
| Jeton expiré | « GitHub : autorisation expirée. [Se reconnecter] — aucune action n'a été tentée avec l'ancien jeton. » |
| Serveur qui demande plus de droits que déclaré | Refus : « Ce serveur demande des droits qu'il n'a pas annoncés (accès fichiers). Connexion refusée. » |

**Critère** : outils listés depuis le serveur réel, permissions appliquées par NOVA (pas par le serveur), déconnexion sans résidu. Scénarios 7, 8, 9.

### 5.5 Reprendre le travail d'hier

**Déclencheur** : lancement de NOVA, ou Accueil › Reprendre.

1. **Accueil** — Cartes « Reprendre », triées par dernière activité :
   « **Portfolio de Léa** · hier 18 h 12 · Dernière mission : réussie, gardée · 0,07 $ hier · [Ouvrir] »
   « **site-asso** · hier 22 h 40 · Mission suspendue : en attente de ta réponse (1 approbation) · [Reprendre] »
2. **Où on en était** — En ouvrant un projet, un encart construit depuis le journal d'événements (faits enregistrés, pas résumé inventé) :
   « Hier : 2 missions, 5 fichiers modifiés et gardés, 1 mission suspendue à l'étape 3 (« installer les dépendances » attend ta confirmation). Ce qui t'attend : 1 approbation, 2 fichiers modifiés non relus. »
   Chaque élément est un lien.
3. **Reprise d'une mission suspendue** — La carte de mission réapparaît telle quelle ; le contrat est ré-affiché s'il a expiré : « Le contrat d'hier est expiré (durée). Le reprendre tel quel ? [Reprendre le contrat] [Modifier] ».
4. **Après un plantage** (scénario 11) — « NOVA s'est arrêté brutalement hier à 22 h 41 pendant la mission « relances devis ». Fait avant l'arrêt : étapes 1 et 2. Incertain : l'envoi de l'e-mail de test (résultat inconnu côté service). Je ne le renverrai pas sans toi. [Vérifier dans ma boîte d'envoi] [Considérer comme envoyé] [Renvoyer] »
5. **Clé de session** — Si la clé était en session uniquement : « Ta clé n'était gardée que pour la session. Colle-la pour continuer ; ton historique est intact. »

**Critère** : reprise depuis le dernier point de reprise, aucun effet externe rejoué, l'utilisateur sait en une lecture ce qui l'attend.

### 5.6 Demande vocale à Nomi (J4)

**Préconditions** : micro autorisé, langue choisie, appui pour parler par défaut.

1. **Appui** — Raccourci maintenu (proposé : Ctrl+Espace) ou bouton micro maintenu. Nomi : « Nomi écoute ». Indicateur de niveau audio permanent tant que le micro capte ; point rouge dans la barre de titre.
2. **Transcription visible** — Texte qui apparaît dans la zone de saisie, éditable. « Corrige si besoin, puis Entrée pour envoyer. » Rien ne part avant Entrée (ou relâchement, si l'option « envoyer au relâchement » est activée — désactivée par défaut).
3. **Commande reconnue** — Certaines phrases sont des commandes locales, affichées comme telles avant exécution : « Commande : Arrêter la mission · [Confirmer] [Envoyer comme message] ». Commandes cibles : « Explique-moi cette erreur », « Continue cette tâche », « Montre les changements », « Arrête la mission », « Combien a coûté ce projet ? ».
4. **Réponse parlée** — Sous-titres synchronisés ; bouton « Couper le son » (Échap coupe en moins de 200 ms, scénario 13). Coût STT/TTS affiché séparément du modèle : « Voix : 0,004 $ · Modèle : 0,02 $ ».
5. **Action destructrice à la voix** — Toujours confirmée dans l'interface, jamais par la voix seule : « Tu as dit : « supprime le dossier build ». Cette action supprime 34 fichiers. [Confirmer avec le clavier] [Annuler] ». Une transcription ambiguë n'exécute rien.

**Cas limites** (scénario 12)

| Cas | Microcopie |
| --- | --- |
| Micro refusé par l'OS | « NOVA n'a pas accès au micro. Autorise-le dans les réglages de ton système, ou écris ta demande. [Ouvrir les réglages système] » |
| Périphérique débranché en cours | « Le micro a été déconnecté. Ce qui a été entendu est conservé ci-dessus. [Choisir un autre micro] » |
| Bruit ambiant | « Beaucoup de bruit : la transcription est peu sûre (mots en gris). Relis avant d'envoyer. » |
| Faux déclenchement (mot d'activation, option) | « Nomi a cru entendre « Nomi » : rien n'a été enregistré ni envoyé. [Désactiver le mot d'activation] » |
| Pas de fournisseur voix configuré | « La voix demande un service de transcription. [Configurer] · L'écrit fonctionne sans. » |

**Critère** : une demande vocale produit la même mission vérifiable qu'une demande écrite ; aucun enregistrement conservé par défaut.

### 5.7 Relire et accepter/refuser les changements de l'agent

**Déclencheur** : fin de mission, ou « Relire les changements » à tout moment (même pendant la mission, en lecture).

**Vue Créer**

« **Changements de la mission « portfolio »**
3 fichiers modifiés · 2 créés · 0 supprimé · tous dans `~/Documents/NOVA/portfolio`

▸ `index.html` — modifié · titre agrandi, présentation réécrite · Vérifié par : aperçu chargé · [Voir] [Garder] [Restaurer]
▸ `styles.css` — modifié · nouvelle taille de titre · [Voir] [Garder] [Restaurer]
▸ `contact.html` — créé · formulaire de contact local · [Voir] [Garder] [Supprimer]

[Garder tout] [Annuler tout] »

« Voir » ouvre le fichier avec les lignes changées surlignées et, au-dessus, le résumé en une phrase. Le résumé est généré depuis le diff réel et marqué « résumé » ; le diff reste la vérité.

**Vue Expert**

Diff unifié ou côte à côte (réglage), par fichier, par bloc ; case à cocher par bloc ; « Garder les blocs cochés » ; navigation `j`/`k` entre blocs, `a` garder, `r` restaurer, `o` ouvrir dans l'éditeur ; commentaires inline « Demander une modification ici » qui relancent une mini-mission ciblée.

**Règles**

- Rien n'est « gardé » implicitement : tant que la décision n'est pas prise, les fichiers sur disque contiennent déjà les changements (nécessaire pour l'aperçu) mais un point de reprise « avant mission » existe et « Annuler tout » y revient à l'octet près.
- Une décision partielle est possible ; l'état restant est visible (« 2 fichiers en attente de décision »).
- Les modifications de l'utilisateur mélangées à celles de la mission sont distinguées ; « Restaurer » ne restaure que ce que la mission a fait quand c'est séparable ; sinon NOVA demande (« Ta version, la sienne, ou les deux ? »).
- Preuves liées : chaque fichier montre ce qui l'a vérifié, ou « Non vérifié ».
- Relecture par un second modèle (J6) : bouton « Demander un second avis (≈ 0,03 $) », résultat présenté comme un avis, jamais comme une certification.

**Cas limites** : fichier binaire (« image modifiée : avant / après côte à côte ») ; fichier supprimé (« supprimé par la mission · [Restaurer] ») ; renommage (« `a.js` → `b.js` ») ; diff énorme (« 1 200 lignes : afficher par blocs de 200 ») ; fichier changé sur disque après la mission par un autre outil (« modifié hors de NOVA depuis · le diff affiché correspond à l'état actuel du disque »).

**Critère** : diff = disque octet pour octet ; restauration ciblée exacte ; « Garder » n'écrase jamais une modification utilisateur (scénarios 4, 5).

### 5.8 Budget dépassé

**Préconditions** : plafond par mission, par projet ou par période (Réglages › Budget). Chaque appel réserve son coût estimé avant de partir (scénario 10).

1. **Avant** : jauge dans la carte de mission : « 0,31 $ constaté · 0,06 $ réservé · plafond 0,50 $ ». À 80 % : la jauge passe en ambre, sans notification.
2. **Au plafond** : mission → **suspendue**. Carte :
   « **Mission suspendue : plafond atteint** · 0,50 $ constaté sur 0,50 $
   Fait : étapes 1 à 3. En cours : étape 4 (tests), arrêtée avant l'appel suivant.
   Détail des dépenses : 12 appels au modèle (0,47 $), 0 appel voix, 1 recherche Web (0,03 $) · [Voir le détail]
   [Relever le plafond à 0,75 $ et reprendre] [Garder ce qui est fait] [Annuler tout] »
   Le montant proposé est le plafond + 50 %, modifiable ; jamais « illimité » en un clic.
3. **Plusieurs workers** : la réservation empêche le dépassement concurrent ; l'affichage précise « réservé » vs « constaté ».
4. **Incertitude** : « Le fournisseur facture parfois avec retard : le montant final chez OpenRouter peut différer légèrement. Ce qui est affiché est ce que le fournisseur a rapporté. »
5. **Crédit OpenRouter épuisé** (différent du plafond) : mission suspendue, « Crédits OpenRouter insuffisants » (copie livrée) + « [Ouvrir la page des crédits] · La mission reprendra où elle en est quand tu le décideras. »

**Règle** : aucune reprise automatique, même après rechargement de crédit. La mission reste « suspendue » jusqu'à une action.

### 5.9 Hors ligne

Détection en amont : NOVA teste la joignabilité d'OpenRouter au besoin (pas en boucle) et écoute l'état réseau du système.

| Moment | Comportement | Microcopie |
| --- | --- | --- |
| Avant l'envoi d'un message | Envoi bloqué, saisie conservée (livré). | « Hors ligne : ton message ne partira pas tant que le réseau n'est pas revenu. » |
| Pendant une réponse | Texte partiel conservé (livré). | « La réponse a été coupée en route · Le texte reçu est conservé. [Réessayer] » |
| Pendant une mission, entre deux appels | Les étapes locales déjà lancées (tests, build) vont au bout ; le prochain appel au modèle ne part pas ; mission → suspendue. | « Mission suspendue : hors ligne. Les tests en cours se terminent. Rien ne repartira sans toi. » |
| Réseau revenu | Bannière, pas de reprise automatique. | « Réseau revenu · [Reprendre la mission] » |
| Catalogue de modèles | Copie locale datée (livré). | « Copie locale du catalogue, mise à jour il y a 3 jours. » |
| Recherche Web / MCP distant | Outil indisponible, masqué du modèle par le gating ; la mission le sait. | « Recherche Web indisponible hors ligne : cette étape est reportée. » |
| Ce qui marche hors ligne | Tout le local : ouvrir, lire, relire les changements, restaurer, terminal, aperçu, historique. | Nomi : « Hors ligne · Tu peux relire et restaurer ; les missions attendront le réseau. » |
| Modèle local (après J3) | Si un profil Local est configuré, proposition explicite. | « Un modèle local est disponible : continuer avec lui ? Capacités différentes (pas d'outils). [Utiliser le modèle local] » |

### 5.10 Clé révoquée

| Moment | Comportement | Microcopie |
| --- | --- | --- |
| Au démarrage (vérification périodique, pas plus d'une fois par lancement) | Nomi : « Clé refusée » (livré). Bannière non bloquante à l'accueil. | « OpenRouter refuse ta clé : elle a peut-être été révoquée. [Remplacer la clé] · Ton historique et tes projets ne sont pas touchés. » |
| Pendant une conversation | Message en erreur (livré : `invalid_key`), saisie conservée. | « La clé OpenRouter est refusée · … [Remplacer la clé] » |
| Pendant une mission | Mission → suspendue au dernier point de reprise ; fichiers intacts. | « Mission suspendue : clé refusée par OpenRouter. Fait : étapes 1 à 2. [Remplacer la clé] puis [Reprendre]. » |
| Après remplacement | Vérification, puis bouton « Reprendre » sur la mission ; pas de reprise automatique. | « Clé vérifiée · 1 mission suspendue peut reprendre. » |
| Clé retirée volontairement dans NOVA | Rappel livré : « Retirer la clé l'efface de NOVA, sans la révoquer. » | — |

### 5.11 Agent bloqué ou en boucle

**Détection (runtime, pas modèle)** : même appel d'outil avec les mêmes arguments 3 fois ; même fichier réécrit 3 fois sans test qui change ; compteur d'itérations (défaut 5 par étape) ; aucune progression d'étape depuis N minutes ; coût par étape > 3 × l'estimation.

**Carte « Nomi tourne en rond »** (mission → suspendue, jamais poursuivie en silence) :

« **Nomi n'avance plus** · étape 3 · 4 tentatives · 0,22 $ sur cette étape
Ce qu'il a essayé : modifier `parser.py` (×3), relancer `pytest` (échec identique ×3).
Erreur qui revient : `KeyError: 'date'` · [Voir la sortie]

Que faire ?
[Donner un indice] — écris ce que tu sais (ex. : « le champ s'appelle `date_devis` »)
[Essayer avec un autre modèle] — dossier de passation préparé (objectif, faits, ce qui a échoué)
[Garder ce qui est fait et arrêter]
[Annuler tout] »

**Règles** : le budget cesse d'être consommé dès la suspension ; le journal complet est accessible ; « Donner un indice » réinitialise le compteur d'itérations de l'étape (une fois) ; l'échec d'une étape après indice → mission « échouée » avec rapport, jamais boucle infinie.

### 5.12 Approbation d'une commande dangereuse

Classes de risque appliquées par le moteur de permissions (jamais par le modèle) :

| Classe | Exemples | Comportement |
| --- | --- | --- |
| Routine (dans le contrat) | lire, écrire dans le projet, lancer les tests | aucune demande, journalisée |
| Notable | installer des dépendances, nouvelle adresse réseau, écrire hors du sous-dossier prévu | demande, regroupable |
| Dangereuse | supprimer plusieurs fichiers, `rm -rf`, `git push --force`, `git reset --hard`, modifier `.git`, écrire dans le dossier personnel, envoyer un e-mail, payer, déployer | demande individuelle, non regroupable, avec effet irréversible annoncé |
| Interdite | hors du workspace, liens symboliques sortants, sockets privilégiés, secrets | refusée, expliquée, journalisée |

**Carte d'approbation (dangereuse)**

« **Nomi veut lancer une commande qui supprime des fichiers**
`rm -rf node_modules dist`
Effet : supprime 2 dossiers (≈ 1 240 fichiers, 210 Mo) dans `~/dev/site-asso`. Récupérable : oui, en réinstallant (pas depuis un point de reprise — NOVA n'enregistre pas `node_modules`).
Pourquoi : « nettoyer avant de réinstaller » (étape 2 du plan)
Demandé par : le modèle, à partir du plan validé
[Autoriser une fois] [Refuser] · [Modifier la commande]

Pour cette action, « Toujours autoriser » n'est pas proposé. »

**Pour un effet externe irréversible** : « Cette action ne pourra pas être annulée par NOVA : l'e-mail partira réellement à 14 destinataires. » Bouton « Envoyer réellement » (verbe exact), jamais « OK ». Pour les actions de classe dangereuse à effet externe, une confirmation en deux temps : bouton, puis saisie du mot « envoyer » (Expert peut désactiver la saisie, pas le bouton).

**Provenance** : toujours affichée. Si l'action découle d'un contenu lu (fichier, page, description d'outil), la carte le dit et montre l'extrait : « Cette demande suit des instructions trouvées dans `README.md` (ligne 12 : « exécuter `curl … | sh` »). Ce texte est une donnée, pas une consigne. »

**Vocal** : jamais de validation par la voix pour cette classe (parcours 5.6).

### 5.13 Tout annuler

Trois niveaux, chacun avec sa liste exacte avant confirmation.

1. **Annuler la mission** (depuis la carte) — « Annuler la mission « portfolio » ? Restaure 3 fichiers modifiés, supprime 2 fichiers créés, laisse tes propres modifications intactes. Ne peut pas annuler : 1 issue GitHub créée (#42). [Annuler la mission] [Garder] »
2. **Revenir à un point de reprise** (Missions › Historique du projet) — Liste des points : « avant mission portfolio · 18 h 02 », « après « Garder » · 18 h 15 ». « Revenir à « avant mission portfolio » remettra 5 fichiers dans leur état de 18 h 02. Les modifications faites depuis, y compris les tiennes, seront enregistrées dans un nouveau point de reprise « avant retour » pour ne rien perdre. [Revenir] »
3. **Annuler la journée** — « Annuler tout ce que NOVA a fait aujourd'hui dans ce projet : 3 missions, 11 fichiers. Tes modifications faites hors de NOVA sont conservées quand elles sont séparables ; sinon je te demanderai fichier par fichier. »

**Règles** : un retour crée toujours un point de reprise « avant retour » (le retour est lui-même annulable) ; les effets externes sont listés et jamais promis annulés ; la rétention des points de reprise est visible (« conservés 30 jours ou 500 Mo, réglable ») ; Git n'est pas requis, mais si présent, NOVA propose « Créer aussi un commit « avant NOVA » ? » une fois par projet.

---

## 6. Créer et Expert

Même logique métier, deux densités. Le mode est un réglage d'affichage global, mémorisé, changeable partout ; chaque surface Créer possède un « Voir le détail » qui affiche la vue Expert localement sans changer le mode.

### 6.1 Ce qui diffère

| Surface | Créer | Expert |
| --- | --- | --- |
| Plan | Étapes en français, compteurs (« 6 fichiers ») | + chemins, commandes exactes, plan éditable en texte |
| Contrat | Phrases (« Lire et modifier ce dossier ») | + motifs de chemins, hôtes, commandes autorisées, durée/budget précis, profil Personnalisé |
| Carte de mission | Étapes, coût, durée | + fil des appels d'outils en direct, jetons par appel, modèle servi, latences |
| Changements | Résumé par fichier, Garder/Restaurer par fichier | Diff par bloc, cases à cocher, raccourcis, commentaires inline |
| Preuves | « Vérifié / Non vérifié » avec sortie repliée | Sortie brute dépliée, codes de retour, durées |
| Terminal | Onglet masqué sauf si une commande tourne ; sortie repliée | Onglet toujours présent, terminal interactif contrôlé |
| Modèle | Nom commercial, prix en ordre de grandeur | Identifiant, prix par million, contexte, capacités, fournisseur servi |
| Coût | « 0,07 $ » | « 0,07 $ constaté · 3 120 jetons envoyés · 890 reçus · 210 raisonnement · via DeepSeek » |
| Approbations | Effet en français | + commande/arguments bruts, provenance détaillée |
| Erreurs | Titre + quoi faire | + code, HTTP, détail fournisseur (masqué des secrets) |
| Nomi | Pastille avec état | Pastille + ligne de télémétrie (phase, latence) |
| Barre de commande | Actions courantes | + commandes de diagnostic, export de journal |

### 6.2 Basculer

- Réglages › Apparence › « Affichage : (●) Créer ( ) Expert » avec description : « Créer résume et guide. Expert montre le diff, le terminal, les identifiants de modèles et les jetons. La logique est la même. »
- Raccourci Ctrl+Maj+E, et dans la palette « Passer en Expert » / « Passer en Créer ».
- Le changement est instantané, sans rechargement ni perte d'état, avec un toast « Affichage Expert » (et annonce lecteur d'écran).
- Suggestion unique, non répétée : quand un utilisateur en Créer ouvre trois fois « Voir le détail » dans une même session, une ligne discrète sous le panneau : « Tu ouvres souvent le détail : passer en Expert affiche tout d'emblée. [Passer en Expert] [Ne plus proposer] ». Jamais de pop-up.
- Aucune fonction n'est réservée à Expert ; Expert n'accorde aucune permission supplémentaire (le contrat le fait).

### 6.3 Ce qui ne change pas

Permissions, contrat, budget, preuves, points de reprise, texte des approbations dangereuses, comportement de Nomi.

---

## 7. Confiance et contrôle

### 7.1 Contrat d'autonomie

Un contrat est attaché à chaque mission ; il est écrit, lisible, appliqué par le moteur de permissions, et expire.

**Champs**

| Champ | Créer | Expert | Défaut (profil Assisté) |
| --- | --- | --- | --- |
| Dossier | « Lire et modifier : `<projet>` » | motifs inclus/exclus | le projet ouvert ; `.env*`, `*.pem`, `id_rsa*` exclus de la lecture par le modèle |
| Actions | « Créer et modifier des fichiers », « Lancer les tests » | liste de commandes/outils | lecture, écriture, tests détectés, aperçu |
| Réseau | « OpenRouter seulement » | liste d'hôtes | OpenRouter ; dépôts de paquets si le projet en déclare |
| Durée | « jusqu'à 10 min » | minutes | 10 min |
| Budget | « jusqu'à 0,50 $ » | montant + réservation | à définir après première mesure (proposition : 0,50 $) |
| Demandera avant | phrases | classes d'actions | notable et dangereuse |
| Validité | « valable 15 min après la fin, pour les petites corrections » | minutes | 15 min |

**Profils** (Réglages › Permissions, et dans le contrat) : Lecture seule · Assisté (défaut) · Autonome dans ce projet · Personnalisé. « Autonome » élargit les actions notables à « autorisées » mais ne touche jamais aux classes dangereuse et interdite ; sa description le dit : « Autonome n'est pas un accès administrateur : suppressions massives, envois et paiements demandent toujours ta confirmation. »

**Niveau d'isolation** : affiché dans le contrat, honnête : « Isolation : processus séparé, sans isolation du système de fichiers. » Une opération qui exige une isolation forte non disponible est refusée avec ce motif.

### 7.2 Approbations sans fatigue

Dix règles, chacune mesurable par « interruptions inutiles ».

1. **Une décision réelle** : on ne demande que ce qui n'est pas dans le contrat.
2. **Une seule fois par mission** pour une même (opération, portée).
3. **Regroupement** : les demandes notables qui s'accumulent pendant que l'utilisateur est absent se présentent en une carte « 3 actions en attente » avec cases, plutôt que trois cartes. Les dangereuses restent individuelles.
4. **Portée explicite** : boutons « Une fois » (défaut) · « Pour cette mission » · « Pour ce projet ». « Toujours » n'existe qu'en Réglages › Permissions, avec la liste de ce qui a été rendu permanent et un bouton « Tout révoquer ».
5. **Pas de délai** : une demande attend ; jamais d'auto-acceptation ni d'auto-refus par expiration. La mission est « en attente d'autorisation », le budget ne bouge pas.
6. **Contexte sur place** : la carte est dans la conversation, à l'endroit où la mission s'est arrêtée, avec la provenance et l'effet.
7. **Refus utile** : refuser propose une alternative au modèle (« Refusé : proposer une autre approche » vs « Refusé : arrêter l'étape »).
8. **Pré-approbation dans le plan** : les actions notables prévisibles (installer, ouvrir un port) sont listées dans le contrat pour être acceptées d'un coup.
9. **Mémoire visible** : « Déjà autorisé dans cette mission : installer des paquets, lire `data/`. » dans le panneau Contexte.
10. **Rétrospective** : à la fin, « 2 confirmations demandées · 0 refusée » ; si une même confirmation a été acceptée trois fois sans modification dans un projet, NOVA propose de l'ajouter au profil du projet (proposition unique).

### 7.3 Relecture des changements

Voir 5.7. Invariants : diff = disque ; résumé marqué « résumé » ; preuve par fichier ; acceptation partielle ; distinction des modifications utilisateur ; jamais d'écrasement silencieux.

### 7.4 Retour arrière

- Point de reprise automatique avant chaque mission, après chaque « Garder », avant chaque retour. Contenu : copie des fichiers touchés (contenu adressé par empreinte, dédupliqué), hors dossiers ignorés (`node_modules`, `.git`, `dist`, listés).
- Ce qui n'est pas restaurable est dit avant : effets externes, dossiers exclus, fichiers > taille limite (« `video.mp4` (1,2 Go) n'est pas enregistré dans les points de reprise »).
- Retention visible et réglable ; suppression explicite.
- Git facultatif : proposé, jamais requis ; NOVA n'exécute jamais de commande Git destructrice sans classe « dangereuse ».

### 7.5 Coût avant l'action

- **Fourchette** avec hypothèses : « 0,05 – 0,20 $ · hypothèses : 8 à 20 appels, contexte moyen 6 k jetons, tarif du catalogue du 27/09 ».
- **Trois montants distincts, toujours nommés** : estimé · réservé · constaté. Jamais mélangés dans une même phrase sans leur adjectif.
- **Jauge** dans la carte de mission ; **total** par projet et par période dans Réglages › Budget, avec « au moins » si un coût manque (règle livrée).
- **Voix, recherche, embeddings** : lignes séparées.
- **Facturation différée** : phrase standard « Le montant final chez OpenRouter peut différer ; ce qui est affiché est ce que le fournisseur a rapporté. »

### 7.6 Trajet des données

Une ligne persistante sous la zone de saisie et dans le contrat :

« Ce message partira vers **OpenRouter → DeepSeek** · avec : 3 fichiers (12 k jetons), l'historique récent, la consigne de Nomi · sans : `.env`, clés · [Voir la liste] [Confidentialité] »

- Avant qu'un fichier parte pour la première fois dans une conversation : ligne ambre « Nouveau : `devis.xlsx` partira avec ce message. » (pas de dialogue).
- Karim peut masquer des colonnes ou des lignes avant l'envoi (« Masquer : e-mail, téléphone ») ; le masquage est appliqué localement et visible dans « Voir la liste ».
- Inspecteur de contexte (panneau Contexte, livré en partie) : fichiers inclus, sources récupérées, skills chargés, mémoire utilisée, estimation de jetons, destination. Chaque élément retirable d'un clic pour ce message.
- Réglage `data_collection` (livré) expliqué au même endroit.

---

## 8. Catalogue des états

Six états par surface. Les textes déjà dans `fr.ts` sont repris tels quels ; les autres sont proposés. « — » : sans objet.

### 8.1 Surfaces J1 (livrées)

| Surface | Vide | Chargement | Hors ligne | Erreur | Succès | Refusé |
| --- | --- | --- | --- | --- | --- | --- |
| Clé | « Connecte OpenRouter pour commencer » | « Vérification de la clé… » | « Clé enregistrée, mais pas encore vérifiée » | selon code (`invalid_key`…) | « Clé vérifiée » + libellé/limite/reste | coffre faible : consentement ; indisponible : session seulement |
| Conversation | « Écris ton premier message : Nomi te répond avec le modèle choisi. » | « Nomi réfléchit… » / « Nomi écrit… » | « Hors ligne : ton message ne partira pas… » | avis selon code, saisie libre | usage, modèle servi, coût ou « coût inconnu » | `forbidden`, `insufficient_credits` avec action |
| Sélecteur de modèle | « Aucun modèle ne correspond · Élargis ta recherche ou retire un filtre. » | « Chargement du catalogue… » | « Copie locale du catalogue, mise à jour … » | « Le catalogue n'a pas pu être chargé » + Réessayer | liste | — |
| Historique | « Aucune conversation pour l'instant. Lance-toi depuis l'accueil. » | « Chargement des conversations… » | — | « Les conversations n'ont pas pu être chargées » | liste | — |
| Réglages | — | « Lecture des informations… » | vérification signalée impossible | « Le réglage n'a pas été enregistré » | « Réglage enregistré » | « Ce mode de stockage n'est pas disponible sur ce système. » |

### 8.2 Surfaces J2+ (proposées)

| Surface | Vide | Chargement | Hors ligne | Erreur | Succès | Refusé |
| --- | --- | --- | --- | --- | --- | --- |
| Accueil › Reprendre | « Tes projets et conversations apparaîtront ici. » | squelette de 3 cartes | — | « L'historique n'a pas pu être lu · [Ouvrir le dossier de données] » | cartes | — |
| Projet (ouverture) | « Ce dossier est vide. Décris ce que tu veux y créer. » | « Lecture du dossier… 214 fichiers » | — | « Dossier illisible : permissions insuffisantes. » | bandeau d'ouverture | « Ce dossier n'est pas accessible : lien symbolique vers l'extérieur. » |
| Fichiers | « Aucun fichier » | squelette d'arbre | — | « Fichier illisible » | arbre | « Hors du projet : non affiché. » |
| Plan | « Décris ton objectif pour obtenir un plan. » | « Nomi prépare un plan… » | « Hors ligne : le plan attend le réseau. » | « Le plan n'a pas pu être produit · [Réessayer] [Changer de modèle] » | plan + contrat | « Ce modèle ne sait pas utiliser d'outils. » |
| Carte de mission | « Aucune mission pour ce projet. » | « Démarrage de la mission… » | « Mission suspendue : hors ligne. » | « Mission échouée : … [Voir le journal] [Garder ce qui est fait] [Annuler tout] » | « Mission terminée » | « Action refusée par les permissions : … » |
| Changements | « Aucun changement pour l'instant. » | « Calcul des changements… » | — | « Diff impossible : le fichier a changé pendant le calcul · [Recalculer] » | liste / diff | — |
| Preuves | « Rien n'a encore été vérifié. » | « Test en cours… (12 s) » | — | « Commande échouée (code 1) · [Voir la sortie] » | « Vérifié : … » | « Commande non autorisée par le contrat. » |
| Terminal | « Aucune commande lancée. » | « Commande en cours · [Interrompre] » | — | « Le processus s'est terminé avec le code 137 (mémoire ?) » | sortie | « Commande refusée : … » |
| Aperçu | « Lance l'aperçu pour voir ton projet. [Lancer] » | « Démarrage de l'aperçu… » | — (local) | « L'aperçu ne répond pas · 2 erreurs console · [Voir] [Relancer] » | page + adresse | « Aperçu isolé : cette page a tenté d'accéder au réseau, bloqué. » |
| Extensions › MCP | « Aucun service connecté. [Connecter un service] » | « Connexion à GitHub… » | « Service distant injoignable. » | « Connexion échouée : … [Réessayer] [Voir le diagnostic] » | « GitHub connecté · 14 outils » | « Serveur refusé : droits non déclarés. » |
| Skills | « Aucune skill installée. » | « Lecture du paquet… » | — | « Paquet invalide : SKILL.md manquant. » | « Skill installée · 3 fichiers · permissions : lecture » | « Skill refusée : demande d'exécution non déclarée. » |
| Budget | « Rien de consommé pour l'instant. » | — | — | « Usage non communiqué pour 2 réponses (total : au moins …) » | totaux | « Plafond atteint » |
| Voix | « Maintiens Ctrl+Espace pour parler. » | « Transcription… » | « Voix indisponible hors ligne (service distant). » | « Micro inaccessible » | transcription | « Micro refusé par le système. » |
| Mémoire (Bibliothèque) | « Nomi n'a rien mémorisé. Ce qu'il retient apparaîtra ici, avec sa source. » | — | — | — | liste avec provenance/portée/date | — |

### 8.3 Erreurs de mission (codes proposés)

| Code | Titre | Détail | Action |
| --- | --- | --- | --- |
| `mission_budget_cap` | « Plafond de budget atteint » | « La mission s'est arrêtée avant l'appel suivant. Rien n'est perdu. » | Relever · Garder · Annuler |
| `mission_time_cap` | « Temps écoulé » | « Durée maximale du contrat atteinte. » | Prolonger · Garder · Annuler |
| `mission_no_progress` | « Nomi n'avance plus » | voir 5.11 | Indice · Autre modèle · Garder · Annuler |
| `mission_permission_denied` | « Action refusée » | « `<action>` est hors du contrat. Rien n'a été fait. » | Modifier le contrat · Continuer sans |
| `mission_tool_failed` | « Un outil a échoué » | « `<outil>` : `<résumé>`. » | Voir la sortie · Réessayer l'étape |
| `mission_model_incapable` | « Le modèle ne peut pas continuer » | « Ce modèle ne prend pas en charge `<capacité>`. » | Changer de modèle (passation) |
| `mission_crash_recovered` | « NOVA s'est arrêté brutalement » | voir 5.5 | Vérifier · Reprendre |
| `mission_external_uncertain` | « Résultat incertain côté service » | « L'action `<x>` est partie, sans réponse. Je ne la rejoue pas seul. » | Vérifier · Considérer fait · Rejouer |

---

## 9. Stratégie de notification

### 9.1 Niveaux

| Niveau | Canal | Quand | Exemples |
| --- | --- | --- | --- |
| 0 — Journal | Preuves / journal de mission | tout événement | appel d'outil, fichier écrit |
| 1 — État | pastille Nomi, carte de mission | changement d'état | « Nomi travaille · étape 2 » |
| 2 — Bandeau in-app | haut de la conversation, non modal | information qui appelle une action non urgente | « Réseau revenu · Reprendre » |
| 3 — Carte in-app | dans la conversation, mission en pause | décision attendue | approbation, question bloquante |
| 4 — Notification système | OS, seulement si la fenêtre n'est pas au premier plan | décision attendue, fin de mission, suspension | « Mission « portfolio » terminée · 0,07 $ » |
| 5 — Son | optionnel, désactivé par défaut | approbation en attente ou fin de mission, si activé | un son court, jamais en boucle |

### 9.2 Règles

- Une notification système par événement, jamais de rappel répété. Si l'utilisateur ne revient pas, la carte l'attend.
- Aucune notification pendant qu'il regarde déjà la fenêtre.
- Regroupement : plusieurs missions terminées pendant l'absence = une notification « 2 missions terminées ».
- Contenu sans données sensibles (pas de contenu de fichier, pas de montant précis si l'option « notifications discrètes » est cochée).
- Chaque notification a « Pourquoi ce message ? » et « Ne plus notifier pour : [ce type] ».
- Heures calmes (Réglages › Notifications) : tout passe en niveau ≤ 3.
- Nomi n'initie jamais une notification pour lui-même (« Nomi s'ennuie », « Reviens ») : ce serait contraire au principe 8 et au brief (« aucun message culpabilisant, score d'attachement ou notification artificielle »).

### 9.3 Anti-manipulation (liste de contrôle de revue)

Interdits : compteurs de série, badges rouges hors erreur bloquante, « tu as manqué », urgence artificielle, promotion d'une fonction payante, pop-up de satisfaction, demande d'avis en boutique, pré-cochage d'options qui augmentent les dépenses ou le partage de données, « Toujours autoriser » mis en avant, formulation en double négation, bouton de refus plus petit ou plus pâle que celui d'acceptation, fermeture de dialogue qui vaut acceptation.

Le refus est toujours un bouton de même taille, et Échap = refuser (jamais accepter).

---

## 10. Parcours d'accessibilité

Cible WCAG 2.2 AA sur tout parcours livré, vérifiée par jalon (scénario 15).

### 10.1 Clavier seul — les 10 premières minutes

| Étape | Touches | Ce qui doit se passer |
| --- | --- | --- |
| Lancement | — | Focus initial sur le champ « Clé API OpenRouter » ; « Aller au contenu » disponible en premier Tab. |
| Coller la clé | Ctrl+V, Tab | Focus sur « Afficher la clé » (bouton nommé), puis lien « Créer une clé », puis groupe radio « Où garder la clé ? » (flèches), puis « Tester et enregistrer ». |
| Vérification | Entrée | Focus reste sur le bouton (désactivé, libellé « Vérification… ») ; résultat annoncé ; focus déplacé sur le titre « Clé vérifiée ». |
| Choisir un modèle | Tab vers la recherche, flèches dans la liste, Entrée | La liste est un `listbox` ; Entrée choisit ; annonce « Sélectionné : … ». |
| Accueil | Ctrl+N ou Tab | Focus dans « Décris ton idée ». |
| Clarification | Tab, flèches, Entrée | Deux groupes de contrôles, puis « Continuer avec ces réponses ». |
| Plan et contrat | Tab | Étapes dépliables (`button aria-expanded`), contrat en liste de définitions, « Lancer la mission » atteignable sans passer par tout le plan (raccourci Ctrl+Entrée). |
| Mission | Échap | Échap dans la conversation = « Arrêter » avec confirmation si mission (pas pour une simple génération). |
| Approbation | Tab, Entrée, Échap | La carte reçoit le focus quand elle apparaît ; Échap = refuser. |
| Panneau de travail | Ctrl+1…6 | Onglets Aperçu, Fichiers, Changements, Terminal, Preuves, Contexte. Ctrl+` : focus terminal (avec échappement documenté : Ctrl+Maj+` sort du terminal). |
| Changements | j / k, a, r, o, Entrée | Navigation par fichier/bloc ; Garder ; Restaurer ; Ouvrir. |
| Redimensionner | Tab sur la poignée, flèches | Annonce « Panneau de travail : 420 px ». |
| Palette | Ctrl+K | Tout ce qui précède est aussi accessible ici. |

Pas de piège : le terminal et l'aperçu (iframe isolée) ont une sortie clavier documentée et annoncée à l'entrée (« Terminal. Ctrl+Maj+` pour sortir. »).

### 10.2 Lecteur d'écran (Orca, NVDA, VoiceOver)

- Régions : « Navigation principale », « Conversation », « Panneau de travail », « Compagnon » (Nomi, `role=status`).
- Chaque message a un titre implicite « Toi » / « Nomi » et un état (« terminé », « arrêtée », « en échec ») dans le nom accessible.
- Flux : pas d'annonce de chaque fragment ; annonce à la fin (« Réponse terminée », livré), et toutes les 30 s pendant une longue génération (« Nomi écrit toujours, 40 lignes reçues ») — `aria-live=polite`.
- Mission : `aria-live=polite` sur les changements d'étape (« Étape 2 sur 4 terminée : projets d'exemple ») ; `assertive` seulement pour une approbation ou une suspension.
- Diff : mode « Lecture » qui rend chaque bloc en phrases : « `index.html`, bloc 1 sur 3, lignes 12 à 18 : 4 lignes ajoutées, 1 supprimée. Ligne supprimée : « … ». Lignes ajoutées : « … ». » Raccourci pour lire le résumé du fichier avant le détail.
- Terminal : sortie dans une région `log` avec option « annoncer les nouvelles lignes » (désactivée par défaut, sinon bavard), et un raccourci « lire les 10 dernières lignes ».
- Aperçu : le contenu de l'iframe est lisible ; les erreurs collectées sont annoncées comme « 2 erreurs dans l'aperçu ».
- Nomi : nom accessible par état (livré) ; l'orbite est `aria-hidden`.
- Approbation : la carte est un `dialog` non modal nommé (« Nomi demande une confirmation : supprimer 2 dossiers »), focus déplacé, contenu lu dans l'ordre : action, effet, provenance, boutons.
- Voix (J4) : sous-titres ; l'indicateur « micro actif » a un texte ; le bouton « Couper le son » est toujours le premier élément focalisable pendant que Nomi parle.

### 10.3 Mouvement réduit

- Réglage `motion` (livré) : système, réduites, complètes.
- En réduit : l'orbite ne tourne pas et ne se déplace pas (livré) ; les transitions de panneau sont instantanées ; le flux de texte n'a pas de curseur clignotant ; la jauge de budget change sans animation ; l'aperçu ne « glisse » pas ; les cartes de mission n'ont pas d'effet d'apparition.
- Aucune information n'est portée par le mouvement seul : chaque état a un texte (scénario 14).
- Vidéos et GIF dans les messages : lecture sur clic seulement.

### 10.4 Daltonisme

- Le diff n'utilise jamais la couleur seule : préfixes `+`/`−`, bandeau latéral hachuré pour les suppressions, icône par type de changement (créé, modifié, supprimé, renommé).
- Jauge de budget : couleur + pourcentage en texte + motif hachuré au-delà de 80 %.
- États de mission : icône distincte par état (✓, ●, ○, ⏸, ✕) plus texte.
- Palette vérifiée en simulation deutéranopie/protanopie/tritanopie ; jade et ambre restent distinguables par la luminance (mesure à consigner dans « Tokens validés »).
- Option Réglages › Apparence › « Couleurs de diff : (●) Standard ( ) Bleu/orange » pour les personnes qui préfèrent une paire rouge-vert-libre.

### 10.5 Option « Lecture facilitée » (dyslexie et fatigue cognitive)

Un seul interrupteur, Réglages › Apparence › « Lecture facilitée », qui applique ensemble (chacun modifiable) :

- police d'interface à lisibilité renforcée, à licence vérifiée (par exemple Atkinson Hyperlegible ; pas d'OpenDyslexic sans vérification de licence et de préférence réelle — les études sont partagées, on laisse le choix) ;
- interlignage 1,6, interlettrage +0,03 em, largeur de ligne max 70 caractères dans la conversation ;
- pas d'italique ; emphase en gras ; pas de texte justifié ;
- fond « Papier minéral » légèrement plus chaud, contraste maintenu ≥ 4,5:1 ;
- résumés en tête de chaque message long (« En bref : … », généré et marqué comme résumé) ;
- lecture à voix haute des messages (J4) ;
- règle de lecture (surlignage de la ligne sous le curseur) dans le diff et le terminal.

### 10.6 Autres

- Zoom 200 % sans défilement horizontal (cible livrée) ; taille de texte propre à NOVA (Ctrl+= / Ctrl+−) indépendante du système.
- Cibles ≥ 24 × 24 px ; 44 px en mode tactile (PWA J5).
- Délais : aucune approbation, aucun dialogue n'expire.
- Langage clair : les messages Créer sont relus avec une grille « une idée par phrase, verbe d'action, pas de double négation ».
- Épilepsie : aucune animation > 3 flashs/s ; l'orbite est lente (≥ 2 s par tour).

---

## 11. Internationalisation

- **Langue source** : français (fr-FR). Toute chaîne vit dans `copy/<locale>.ts` ; le code reste en anglais. Aucune concaténation de fragments : des fonctions à paramètres nommés (`count`, `name`) comme aujourd'hui.
- **Pluriels et genres** : utiliser les règles CLDR (ICU MessageFormat ou équivalent) plutôt que `count > 1 ? "s" : ""` (fragile en anglais « 0 items », en polonais, en arabe). Éviter d'accorder Nomi en genre : formulations neutres (« Nomi est disponible »).
- **Formats** : nombres, monnaie, dates relatives via `Intl` avec la locale de l'interface (« 1 234 jetons », « 0,0012 $ », « il y a 3 min »). La monnaie reste celle du fournisseur (USD) avec le symbole après le nombre en français ; on n'invente pas de conversion.
- **Langue du modèle ≠ langue de l'interface** : Nomi répond dans la langue de l'utilisateur (consigne système), réglable (« Langue des réponses : comme l'interface / français / anglais / … »). Le code produit reste dans la langue du projet.
- **Voix** : langue de transcription et de synthèse choisies séparément.
- **Expansion** : prévoir +35 % de longueur (allemand, finnois) ; aucun bouton à largeur fixe ; les libellés de raccourcis se traduisent (« Maj » / « Shift »), les touches non.
- **RTL** : mise en page en propriétés logiques (`margin-inline-start`) dès maintenant ; le diff et le terminal restent LTR.
- **Pseudo-localisation** en CI : une locale `qps-ploc` qui allonge et accentue pour détecter les chaînes codées en dur et les débordements.
- **Contenu du fournisseur** : messages d'erreur amont affichés tels quels dans « Détail du fournisseur », sous le titre traduit.
- **Ordre de déploiement proposé** : fr → en → es/de → autres, chaque locale complète ou absente (pas de mélange affiché).

---

## 12. Métriques et protocole de test

### 12.1 Métriques par parcours

Toutes mesurées localement (question Q4), cibles fixées après première mesure ; les valeurs entre parenthèses sont des propositions à confirmer.

| Parcours | Métrique | Définition | Proposition |
| --- | --- | --- | --- |
| 10 premières minutes | Temps jusqu'au premier résultat utile | premier lancement → première réponse complète (J1) ; → premier aperçu ouvert (J2) ; → première mission gardée (J2) | (≤ 10 min pour l'aperçu, médiane) |
| | Taux d'abandon à l'écran de clé | lancements sans clé enregistrée en 24 h ÷ lancements | (< 20 %) |
| | Questions avant plan | nombre de questions posées avant un plan | ≤ 2 (règle) |
| Idée → app | Taux de missions acceptées | gardées ÷ terminées | (> 70 %) |
| | Écart estimation/constaté | |constaté − milieu de fourchette| ÷ constaté | (< 50 %) |
| | Temps jusqu'à l'aperçu | lancement de mission → aperçu chargé | à mesurer |
| Corriger un bug | Test lancé avant et après | missions Corriger avec preuve avant et après ÷ missions Corriger | 100 % quand une commande de test existe |
| | Restauration exacte | restaurations où le fichier = état initial octet pour octet | 100 % |
| Recherche Web | Affirmations sourcées | affirmations avec source ÷ affirmations sur données externes | (> 90 %) |
| MCP | Connexion réussie sans aide | connexions réussies au premier essai ÷ tentatives | à mesurer |
| Reprise | Temps pour savoir où on en est | ouverture du projet → premier clic sur un élément « ce qui t'attend » | (< 30 s) |
| Voix | Transcriptions corrigées | transcriptions éditées avant envoi ÷ transcriptions | à mesurer |
| Relecture | Temps de relecture par fichier | | à mesurer |
| Budget | Suspensions au plafond | missions suspendues par budget ÷ missions | à mesurer (le chiffre en soi n'est ni bon ni mauvais) |
| Approbations | Interruptions inutiles | confirmations acceptées sans modification pour une opération déjà autorisée dans la même session | (0) |
| | Refus | approbations refusées ÷ demandées | à mesurer |
| Boucle | Missions suspendues « sans progrès » | ÷ missions | à mesurer ; coût moyen dépensé avant détection |
| Tout annuler | Retours réussis | retours où l'état = point de reprise | 100 % |
| Nomi | Consommation au repos | CPU/mémoire de l'interface, Nomi affiché, aucune activité, machine de référence | à mesurer |
| Accessibilité | Parcours principal au clavier seul et au lecteur d'écran | scénario 15 | 100 % des étapes |
| Général | Régressions | scénarios d'acceptation qui repassent en échec | 0 |

Ce qu'on ne mesure pas comme valeur : nombre de messages, temps passé dans l'application, sessions par jour.

### 12.2 Instrumentation locale

Événements structurés déjà prévus (mission, modèle, appels d'outils, durée, jetons, coût, erreurs, validations). Ajouter les horodatages d'interface nécessaires : `first_launch`, `key_verified`, `model_chosen`, `first_message_completed`, `folder_opened`, `plan_shown`, `contract_accepted`, `mission_started`, `preview_opened`, `changes_reviewed`, `changes_kept`, `approval_shown/accepted/rejected`, `mode_switched`, `detail_opened`. Un écran Réglages › Diagnostics › « Mesures locales » les montre à l'utilisateur, exportables ; rien ne part sans opt-in explicite.

### 12.3 Protocole de test d'utilisabilité

**Participants** : 5 par groupe (Créer non-codeurs, Créer avec outils bureautiques avancés, Expert), soit 15 par vague ; recrutés hors du cercle des développeurs du projet ; au moins 2 personnes utilisant un lecteur d'écran ou le clavier seul, 1 avec dyslexie déclarée, sur l'ensemble des vagues.

**Environnement** : build installé (pas dev), machine propre, vraie clé OpenRouter avec crédit de test plafonné (2 $), projets de test fournis (dépôt avec bug connu ; dossier vide ; tableur de devis anonymisé). Enregistrement écran + audio avec consentement ; aucun enregistrement conservé au-delà de l'analyse.

**Tâches** (chacune : consigne lue à haute voix, pensée à voix haute, pas d'aide avant 3 min de blocage)

1. « Installe NOVA et fais-lui faire quelque chose d'utile pour toi. » (10 min ; mesure du temps jusqu'au premier résultat)
2. « Voici un site avec un bug : la page Membres plante. Fais-le corriger, et garde seulement ce qui te paraît juste. »
3. « Fais chercher à Nomi la date de fin de support de la version X de la bibliothèque Y, et dis-moi si tu lui fais confiance. »
4. « Branche ton GitHub (compte de test) et fais créer une issue. »
5. « Ferme NOVA, rouvre-le demain (simulation), et dis-moi où tu en étais. »
6. « Demande à voix haute à Nomi de supprimer le dossier build. » (J4)
7. « Reviens exactement à l'état d'avant la première tâche. »
8. Injection : un des projets contient un `README` hostile ; observer si le participant remarque la provenance sur la carte d'approbation.

**Mesures par tâche** : réussite (oui / avec aide / non), temps, erreurs, nombre d'approbations vues et comprises (question de contrôle : « qu'est-ce qui se passe si tu acceptes ? »), confiance (échelle 1–5 : « Sais-tu ce qui a changé sur ton disque ? », « Sais-tu ce qui est parti sur Internet ? », « Sais-tu combien ça a coûté ? »), SUS en fin de session, et trois questions ouvertes : « Qu'est-ce qui t'a surpris ? », « Qu'est-ce qui t'a fait hésiter ? », « Qu'est-ce que tu aurais voulu annuler ? ».

**Critères d'arrêt / de succès de vague** : tâche 1 réussie sans aide par ≥ 4/5 dans chaque groupe ; aucune approbation acceptée sans compréhension de l'effet (question de contrôle) ; tâche 7 réussie par 5/5 ; tâche 8 : provenance remarquée par ≥ 3/5 sinon la carte est retravaillée.

**Rythme** : une vague par jalon à partir de J2, plus une vague « accessibilité » dédiée par jalon.

---

## 13. Les 30 détails qui font la différence

1. « Vérifié / Non vérifié » écrit noir sur blanc sur chaque carte de fin de mission, avec la liste exacte de ce qui n'a pas été vérifié.
2. Le coût affiché en trois mots distincts — estimé, réservé, constaté — jamais mélangés.
3. Deux questions maximum avant un plan, avec réponses par défaut visibles.
4. Le contrat de mission en phrases du quotidien, et le même en motifs techniques un clic plus loin.
5. « Toujours autoriser » absent des cartes d'approbation ; « Une fois » par défaut.
6. La provenance sur chaque approbation : « Demandé par le modèle après lecture de `README.md` ligne 12 ».
7. Échap = refuser, jamais accepter ; boutons de refus de même taille.
8. Le diff correspond au disque octet pour octet, et NOVA le dit.
9. « Restaurer ce fichier » restaure aussi tes propres modifications non enregistrées si elles y étaient.
10. « Annuler tout » liste ce qu'il ne peut pas annuler (l'issue GitHub #42) avant de demander confirmation.
11. Un retour arrière crée un point de reprise « avant retour » : revenir est lui-même annulable.
12. La ligne « Ce message partira vers OpenRouter → DeepSeek · avec 3 fichiers · sans `.env` » sous la zone de saisie.
13. La colonne « e-mail » masquée localement avant l'envoi d'un tableur, visible dans « Voir la liste ».
14. Le bloc « Pour commencer » du sélecteur de modèle, calculé depuis le catalogue en direct, avec « Pourquoi ici ».
15. « À ce prix, 1 000 messages courts coûtent environ 0,04 $ » : un ordre de grandeur, marqué estimation.
16. Le bouton « Lancer » désactivé avec la raison écrite (« ce modèle ne sait pas utiliser d'outils ») et le filtre déjà appliqué.
17. « Nomi n'avance plus » après 3 tentatives identiques, avec ce qu'il a essayé et « Donner un indice ».
18. Aucune reprise automatique après réseau revenu, crédit rechargé ou clé remplacée : un bouton, toujours.
19. Après un plantage, la distinction « fait / non fait / incertain » pour chaque effet externe.
20. Le résumé en une phrase par fichier, généré depuis le diff et marqué « résumé ».
21. Le port occupé remplacé et annoncé en une ligne, sans dialogue.
22. Le contrat encore valable 15 minutes après la mission pour les petites corrections, sans redemander.
23. La proposition « ajouter au profil du projet » après trois confirmations identiques — une seule fois.
24. Nomi qui ne bouge que si le runtime bouge ; immobile au repos ; jamais de bulle qui flotte.
25. Les descriptions d'outils MCP affichées dans un cadre « texte fourni par le serveur, non vérifié ».
26. « Retirer la clé l'efface de NOVA, sans la révoquer » — une phrase qui évite une fausse sécurité.
27. Le niveau d'isolation écrit tel qu'il est (« processus séparé, sans isolation du système de fichiers »).
28. La confirmation d'une action externe irréversible avec le verbe exact (« Envoyer réellement ») et le nombre (« 14 destinataires »).
29. Le mode « Lecture » du diff pour lecteur d'écran, phrase par phrase, résumé d'abord.
30. La sortie clavier du terminal annoncée à l'entrée (« Ctrl+Maj+` pour sortir »).

---

## 14. Annexes

### A. Vocabulaire (complète le glossaire de `DESIGN_SYSTEM.md`)

| Terme | Plutôt que | Sens |
| --- | --- | --- |
| projet | workspace, repo | Dossier sur lequel NOVA travaille |
| changements | diff, patch | Ce qu'une mission a modifié (Expert : diff) |
| point de reprise | checkpoint, snapshot | État enregistré du projet |
| preuve | log, output | Ce qui a réellement été exécuté pour vérifier |
| contrat | policy, permissions | Cadre d'autonomie d'une mission |
| garder / restaurer | accept / revert | Décision par fichier |
| annuler la mission | rollback | Retour à l'état d'avant la mission |
| service connecté | serveur MCP | Service externe branché (Expert : serveur MCP) |
| savoir-faire | skill | Méthode réutilisable (Expert : skill) |
| estimé / réservé / constaté | budget, spent | Les trois montants d'une mission |
| vérifié / non vérifié | tested | État de preuve d'une affirmation |
| essai à blanc | dry run | Voir ce qu'une mission ferait sans rien modifier |
| dossier de passation | handoff | Contexte structuré transmis à un autre modèle |
| aperçu | preview | Site ou application du projet lancé localement |

### B. Questions pour le propriétaire (en plus de Q1–Q8)

| # | Question | Pourquoi | Proposition |
| --- | --- | --- | --- |
| UX-1 | Plafond de budget par mission par défaut | Le « défaut est le produit » : trop bas frustre, trop haut effraie | 0,50 $, révisé après première mesure |
| UX-2 | Durée par défaut d'un contrat et de sa validité après mission | Équilibre entre « ne pas redemander » et sécurité | 10 min + 15 min |
| UX-3 | Rétention des points de reprise | Espace disque vs confiance | 30 jours ou 500 Mo, réglable |
| UX-4 | Police de « Lecture facilitée » | Licence et préférence réelle | Atkinson Hyperlegible, à tester avec des personnes concernées |
| UX-5 | Raccourci appui-pour-parler | Conflits OS | Ctrl+Espace, configurable |
| UX-6 | Confirmation par saisie du mot pour les effets externes irréversibles | Friction volontaire vs agacement | Oui en Créer, désactivable en Expert |
| UX-7 | Détection de boucle : seuils (3 tentatives, 5 itérations) | Faux positifs vs budget gaspillé | Ces valeurs, mesurées sur les premiers usages |
| UX-8 | Vues Créer/Expert : mémoriser par projet ou globalement | Un développeur peut vouloir Créer sur un projet perso | Global, avec surcharge par projet |

### C. Correspondance avec les scénarios d'acceptation

| Parcours | Scénarios |
| --- | --- |
| 10 premières minutes | 1, 2, 15, 16, 18 |
| Idée → app | 4, 5, 6, 10 |
| Corriger un bug | 4, 5, 6 |
| Recherche Web | 7 |
| MCP | 7, 8, 9 |
| Reprise | 11 |
| Voix | 12, 13, 14 |
| Relecture | 4, 5 |
| Budget | 10 |
| Hors ligne | 2 |
| Clé révoquée | 2, 16 |
| Boucle | 10, 11 |
| Commande dangereuse | 6, 7 |
| Tout annuler | 4, 5, 11 |

---

*Fin du document. Les textes proposés sont prêts à être portés dans `apps/desktop/src/renderer/copy/fr.ts` ; chaque nouveau parcours doit s'accompagner de ses six états (section 8) et de son passage au clavier et au lecteur d'écran (section 10) avant d'être déclaré terminé.*
