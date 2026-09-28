# Sécurité

Modèle de menaces et contrôles de NOVA. Chaque contrôle porte un statut : **J1** = exigence du jalon en cours (son état vérifié est dans [`STATUS.md`](STATUS.md)), **prévu Jx** = n'existe pas encore. Rien dans ce document ne vaut preuve de fonctionnement.

## Signaler une vulnérabilité

Canal à définir par le propriétaire (question Q8 de [`DECISIONS.md`](DECISIONS.md)). D'ici là, ne publiez pas de détail d'exploitation dans un ticket public.

## Ce qu'on protège

| Actif | Pourquoi |
| --- | --- |
| Clé OpenRouter | Donne accès au crédit de l'utilisateur. |
| Contenu des conversations | Peut contenir des données personnelles ou professionnelles. |
| Dépenses | Chaque requête est facturée ; une boucle ou une relance cachée coûte de l'argent. |
| Fichiers de l'utilisateur (J2+) | Un outil mal contrôlé peut écraser ou exfiltrer du travail. |
| Audio (J4) | Le micro capte plus que la commande voulue. |

## Menaces considérées

| Menace | Exemple | Réponse principale |
| --- | --- | --- |
| Contenu hostile affiché | Réponse de modèle contenant du HTML, un lien piégé ou une image distante servant à exfiltrer des données | Renderer isolé, Markdown sans HTML brut, aucun réseau dans le renderer, liens externes filtrés |
| Renderer compromis | Faille dans une dépendance de l'interface | Le renderer n'a ni Node, ni réseau, ni clé ; seules des requêtes typées et validées atteignent le main |
| Injection d'instructions (J2+) | Un fichier, une page ou une description d'outil MCP demande au modèle de lire `~/.ssh` | Contenus traités comme des données ; permissions décidées hors du modèle |
| Fuite de secret | Clé dans un journal, un message d'erreur, un export, une capture | Masquage systématique, clé jamais renvoyée au renderer |
| Vol de l'ordinateur ou copie du disque | Lecture du dossier de données | Clé chiffrée par le coffre du système ; niveau réel affiché ; données supprimées effacées dans la base (voir [Effacement des données](#effacement-des-données)) |
| Dépendance malveillante | Version compromise publiée sur npm | ADR-009 : délai de 3 jours, scripts d'installation limités, verrouillage |
| Dépense non voulue | Relance automatique, boucle d'agent | Aucune relance automatique en J1 ; budgets avec réservation prévus en J3 |

Hors périmètre : un logiciel malveillant qui s'exécute déjà avec le compte de l'utilisateur. Il peut demander au coffre du système de déchiffrer la clé comme NOVA le fait ; NOVA ne prétend pas s'en protéger.

## Frontières de confiance

Diagramme : [`ARCHITECTURE.md` → Frontières de confiance](ARCHITECTURE.md#frontières-de-confiance).

| Frontière | Ce qui la traverse | Contrôles | Statut |
| --- | --- | --- | --- |
| B1 renderer → main | Requêtes IPC | Schéma zod par canal, vérification de l'origine de l'émetteur, API fixe, enveloppe `IpcResult` | J1 |
| B2 main → OpenRouter | Contexte de la conversation, clé en en-tête `Authorization` | HTTPS ; clé envoyée uniquement à l'adresse OpenRouter configurée ; `data_collection: deny` par défaut | J1 |
| B3 main → coffre | Clé en clair (chiffrement, déchiffrement) | `safeStorage` ; niveau réel exposé (`VaultStatus`) | J1 |
| B4 main → disque | État produit, journaux | Aucun secret en clair ; masquage avant écriture | J1 |
| B5 main → outils, MCP, fichiers de projet | Commandes, chemins, contenus | Moteur de permissions, processus isolés | Prévu J2–J3 |
| B6 client Web → compagnon local | Commandes à distance | Appairage explicite, jeton révocable, origines restreintes | Prévu J5 |

## Secrets

**Cycle de vie de la clé OpenRouter.**

1. L'utilisateur la colle dans le renderer. C'est le seul passage de la clé dans le renderer : elle part vers le main par `connection.setKey` et n'en revient jamais.
2. Le main la vérifie (`GET /api/v1/key`) et l'enregistre selon le mode choisi :
   - `vault` : chiffrée par le coffre du système ; texte chiffré dans la table `secrets`, référencé par identifiant ;
   - `weak-vault` : même chose avec le backend `basic_text`, uniquement après consentement explicite ;
   - `session` : en mémoire du main, perdue à la fermeture.
3. Le renderer ne voit que `ProviderConnectionView` : état, mode, **4 derniers caractères** (`keyHint`), résultat de vérification.
4. `connection.remove` supprime la connexion et le secret chiffré (voir [Effacement des données](#effacement-des-données)).

**Linux sans trousseau (coffre faible).** Electron se rabat sur `basic_text`, chiffré avec une clé codée en dur : n'importe qui ayant le fichier peut le déchiffrer. NOVA :

- affiche le niveau « faible » et explique ce que cela signifie ;
- propose par défaut une clé de session ;
- n'écrit en coffre faible qu'après un consentement explicite ;
- conseille d'installer ou de déverrouiller un trousseau (gnome-keyring, KWallet).

**Jamais** : clé dans SQLite en clair, dans les journaux, dans le renderer, dans les exports, dans les diagnostics, dans les captures d'écran de tests.

## Isolation du renderer (J1, ADR-005)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, pas de `<webview>`.
- Interface servie par le protocole privilégié `nova://` (fichiers construits uniquement), jamais par `file://`.
- CSP stricte : pas de script en ligne ni d'`eval`, ressources limitées à l'application. Une image distante dans une réponse de modèle n'est donc pas chargée.
- Navigation verrouillée (`will-navigate` bloqué) et ouverture de fenêtres refusée.
- Liens externes : `https` uniquement (`OpenExternalRequestSchema`), domaines en liste d'autorisation dans le main, ouverts dans le navigateur du système.
- Demandes de permission (micro, caméra, notifications, géolocalisation, lecture du presse-papiers…) refusées. **Exception** : `clipboard-sanitized-write`, l'écriture de texte dans le presse-papiers, accordée uniquement aux pages de l'application (`nova://app`, ou le serveur de développement en `pnpm dev`) pour les boutons « Copier » et l'action explicite « Copier l'adresse » d'un lien refusé — rien n'est copié sans geste de l'utilisateur (`apps/desktop/src/main/security.ts`). Sans elle, `navigator.clipboard.writeText` échoue sous Electron 44. Conséquence acceptée : un renderer compromis pourrait écrire du texte dans le presse-papiers sans demande, mais pas le lire. Le micro sera autorisé en J4, explicitement et uniquement pour la fonction voix.
- Fuses Electron à la mise en paquet (`apps/desktop/electron-builder.yml`) : `RunAsNode` désactivé, variable `NODE_OPTIONS` et options d'inspection Node ignorées, chargement depuis `app.asar` uniquement, validation d'intégrité de l'archive activée. **Limite** : Electron n'applique cette validation d'intégrité que sous macOS et Windows ; sous Linux (plateforme de référence, AppImage), une archive `app.asar` modifiée n'est pas détectée.

En mode `pnpm dev`, le renderer est servi par le serveur de développement de Vite. Ces garanties se vérifient sur le build (`pnpm build`), celui qu'utilisent les E2E.

## Validation de l'IPC (J1)

- Un schéma zod par requête (`packages/shared/src/ipc.ts`), appliqué dans le main avant toute action ; objets stricts pour les réglages ; identifiants UUID ; tailles bornées (message de 100 000 caractères maximum, recherche de 200, titre de 120).
- Identifiants de modèle validés par forme (`auteur/modèle`), jamais comparés à une liste codée en dur.
- Origine de l'émetteur vérifiée : seule la fenêtre de l'application servie par `nova://` est acceptée.
- Erreurs renvoyées sous forme d'enveloppe ; le message est court et masqué.

## Permissions : refus par défaut

| Portée | Règle | Statut |
| --- | --- | --- |
| Permissions du navigateur | Toutes refusées, sauf `clipboard-sanitized-write` (écriture de texte dans le presse-papiers) pour les pages de l'application | J1 |
| Outils du modèle | Aucun outil n'est donné au modèle en J1 : il ne peut que répondre du texte | J1 |
| Moteur de permissions | allow / ask / deny par espace de travail, outil, opération, chemin, hôte et durée ; évalué dans le main, jamais par le modèle | Prévu J2 |
| Profils | Lecture seule, Assisté, Autonome dans ce projet, Personnalisé | Prévu J2 |
| Actions destructrices | Confirmation explicite, y compris à la voix | Prévu J2 (J4 pour la voix) |

**Honnêteté sur l'isolation.** NOVA dit exactement quel niveau d'isolation s'applique (par exemple « processus séparé, sans isolation du système de fichiers ») et ne présente jamais comme « sandbox » ce qui n'en est pas une.

## Parité Harness (J2-B)

- **Chaîne** : un programme tourne dans un hôte `utilityProcess` créé pour lui, contexte V8 sans Node ni génération de code, tas, durée et nombre d'appels bornés ; chaque appel d'outil repasse par le moteur de permissions et les approbations (ADR-022).
- **Processus de l'agent** : argv sans shell, environnement nettoyé, dossier confiné ; session de terminal en lecture seule jusqu'à « Prendre la main » ; sortie envoyée au modèle expurgée et bornée ; tous tués à la sortie de NOVA.
- **Skills** : les permissions déclarées n'accordent rien ; leur contenu est une donnée balisée (`skill`) ; les scripts ne passent que par `run_command` ; aucune écriture hors `<données>/skills` ; une skill de projet n'est jamais activée sans aperçu de son contenu actuel.
- **Sous-missions** : profondeur 1, budget réservé sur le parent, contrat jamais plus large ; un enfant qui écrit travaille dans un worktree git (hooks et filtres neutralisés) ; rien n'entre dans le projet sans tests verts, point de reprise et clic « Intégrer ».
- **Missions planifiées** : seulement quand NOVA tourne ; une approbation attend l'humain (jamais d'auto-approbation).
- **Compaction** : un résumé n'est appliqué qu'après « Appliquer » ; l'historique stocké n'est jamais réécrit ; le raisonnement d'un modèle n'est ni stocké ni transmis au suivant (ADR-008).
- **Images collées** : jamais stockées ; refusées si le modèle ne lit pas d'images.

## Réseau

| Émetteur | Destination | Quand | Statut |
| --- | --- | --- | --- |
| Renderer | Aucune | Jamais | J1 |
| Main | `openrouter.ai` : `/api/v1/models`, `/api/v1/key`, `/api/v1/chat/completions` | Catalogue, vérification de clé, conversation | J1 |
| Navigateur du système | Lien `https` autorisé | Sur clic de l'utilisateur | J1 |
| Mises à jour | — | Pas de mise à jour automatique ; mises à jour signées prévues après la signature de code (Q3) | Prévu |

**Variables de développement et d'E2E.** Trois variables d'environnement modifient le comportement du main : `NOVA_OPENROUTER_BASE_URL` (faux serveur OpenRouter, qui reçoit donc la clé), `NOVA_USER_DATA_DIR` (dossier de données isolé) et `ELECTRON_RENDERER_URL` (serveur de développement Vite, traité comme l'origine de l'application). Règle appliquée par `resolveLaunchOverrides` (`apps/desktop/src/main/security-policy.ts`) :

- application empaquetée : les trois variables sont ignorées, et leur nom est journalisé ;
- développement : les deux URL ne sont acceptées qu'en `http` ou `https` vers l'adresse de boucle locale (`127.0.0.1`, `localhost`, `[::1]`), et `NOVA_USER_DATA_DIR` seulement si c'est un chemin absolu ; sinon la variable est ignorée.

Tests unitaires : `apps/desktop/src/main/security-policy.test.ts`. Vérifié aussi sur un build empaqueté Linux (dossier) le 2026-09-27 : les trois variables y sont ignorées.

## Journaux et masquage

- Tout texte qui peut atteindre un journal, un détail d'erreur, un export ou l'interface passe par `redactSecrets` (`packages/shared/src/redact.ts`) : clés de type `sk-…` et jetons `Bearer` remplacés par `[secret masqué]`.
- Messages des fournisseurs : masqués et tronqués à 500 caractères (`sanitizeProviderMessage`).
- Seuls les 4 derniers caractères d'une clé peuvent être affichés (`keyHint`).
- Le contenu des conversations n'a pas sa place dans les journaux. Un E2E (`bridge-security.spec.ts`) vérifie qu'après une réponse en continu, ni la clé ni le contenu n'apparaissent dans les journaux sur disque.
- Limite connue : le masquage reconnaît des formes de secrets, pas tous les secrets possibles. Toute nouvelle forme de clé (autre fournisseur) ajoute son motif et un test.

## Effacement des données

Retirer la clé (`connection.remove`), la remplacer, ou supprimer une conversation efface les lignes correspondantes de `nova.sqlite` (dossier de données). Depuis les correctifs de revue :

- la base est ouverte avec `PRAGMA secure_delete = ON` : SQLite remplace par des zéros le contenu des lignes supprimées (texte chiffré de la clé, titres et messages) au lieu de simplement libérer la place ;
- après une telle suppression, `PRAGMA wal_checkpoint(TRUNCATE)` recopie le journal WAL dans la base et le tronque, pour que les anciennes pages n'y restent pas.

**Limites.** Ces mesures agissent sur les fichiers SQLite, pas sur le support physique. Un SSD (répartition de l'usure, blocs réalloués), un système de fichiers journalisé ou à copie sur écriture (btrfs, APFS, ZFS), des instantanés et des sauvegardes peuvent garder d'anciennes copies des données. NOVA ne peut pas garantir qu'elles sont irrécupérables sur le disque ; le chiffrement du disque par le système reste la protection contre la copie du disque. Rappel : sous Linux sans trousseau, le texte chiffré du coffre faible se déchiffre avec une clé publique ; une copie ancienne vaut donc la clé.

## Données qui quittent l'appareil

| Donnée | Destinataire | Quand | Contrôle utilisateur |
| --- | --- | --- | --- |
| Messages de la conversation (historique inclus) | OpenRouter, puis le fournisseur amont qui sert le modèle | À chaque envoi ou relance | Choix du modèle ; `data_collection` (`deny` par défaut) |
| Clé OpenRouter | OpenRouter | À chaque requête authentifiée | Suppression à tout moment |
| Nom et adresse de l'application (en-têtes d'attribution) | OpenRouter | À chaque requête | — |
| Télémétrie, rapports de plantage | Personne | Jamais en J1 | Politique future : question Q4 |

Rien d'autre ne part. Aucune synchronisation ni service distant n'est activé par défaut.

## Prévu

| Sujet | Mesure | Jalon |
| --- | --- | --- |
| Isolation des outils et serveurs MCP | `utilityProcess` ou processus enfants avec environnement réduit, sans secrets hérités, répertoire limité à l'espace de travail, délais et quotas | J2–J3 |
| Injection d'instructions | Contenus de fichiers, pages, sorties d'outils et descriptions d'outils MCP traités comme des données non fiables, affichés avec leur provenance ; ils ne peuvent ni élargir une permission ni déclencher une action sans passer par le moteur de permissions | J2–J3 |
| Chemins | Résolution par `realpath` puis confinement strict dans la racine de l'espace de travail ; liens symboliques sortants refusés ; accès hors espace refusé et journalisé | J2 |
| Effets externes | Clés d'idempotence ; aucune relance aveugle d'un effet externe après un plantage | J3 |
| Budgets | Plafonds par mission, projet et période, avec réservation avant l'action, y compris avec plusieurs workers | J3 |
| Voix | Pas de conservation des enregistrements par défaut ; transcription visible avant action ; coupure immédiate | J4 |
| Mises à jour | Paquets signés, vérification de signature avant installation | Après Q3 |
| Hébergement | Isolation entre comptes, chiffrement au repos, journal d'audit | J5 |
