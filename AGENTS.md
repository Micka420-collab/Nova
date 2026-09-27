# AGENTS.md — NOVA

Règles du dépôt pour tout agent (humain ou IA). Direction produit : `docs/PRODUCT.md`. État et reprise : `docs/STATUS.md`.

## Carte

- `apps/desktop` — application Electron (main, preload sandboxé, renderer React).
- `packages/shared` — types du domaine, contrat IPC (schémas zod), redaction des secrets.
- `packages/providers` — interface `ModelProvider` + adaptateur OpenRouter (catalogue, clé, streaming).
- `packages/storage` — état produit local en SQLite (`node:sqlite`), migrations versionnées.
- `packages/agent-runtime` — orchestration des générations (conversation → fournisseur → persistance).
- `packages/ui` — tokens de design, composants, compagnon Nomi, assets de marque.
- `docs/` — produit, architecture, design, roadmap, décisions, statut, sécurité, acceptation.

## Commandes

- Installer : `pnpm install` (Node ≥ 24.10, pnpm 12).
- Développer : `pnpm dev` · Construire : `pnpm build` · Paquet local : `pnpm --filter @nova/desktop package:dir`.
- Vérifier : `pnpm lint`, `pnpm typecheck`, `pnpm test` (Vitest, projets `node` et `dom`).
- E2E Electron : `pnpm test:e2e` (Playwright `_electron`, Linux headless via `xvfb-run -a`).
- Icônes : `pnpm icons` (rend les SVG de `packages/ui/assets` en PNG).

## Règles dures

- Aucun secret en clair hors du coffre : pas dans SQLite, logs, renderer, exports, captures. Utiliser `redactSecrets`.
- Le renderer n'a aucun accès Node ni réseau direct : tout passe par l'IPC typé et validé (zod) du main.
- Jamais d'identifiant de modèle codé en dur dans le produit : le catalogue vient du fournisseur.
- Inconnu = `null` affiché « inconnu ». Ne jamais deviner un prix, une capacité ou un résultat.
- Pas de fausse activité : Nomi et les indicateurs reflètent des événements réels du runtime.
- Pas de bouton inactif présenté comme fonctionnel ; pas de page vide « bientôt ».
- UI en français (microcopie dans `apps/desktop/src/renderer/copy`), code et commentaires en anglais.
- Imports sans extension, TypeScript strict, pas de `any`.
- Toute nouvelle dépendance : justification dans `docs/DECISIONS.md`.
- Mettre à jour `docs/STATUS.md` à chaque jalon : ce qui marche, ce qui a été réellement testé, ce qui ne l'est pas.
