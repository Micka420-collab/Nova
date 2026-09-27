// Recommended MCP servers (M4), versioned in the repository and reviewed at each release.
// Every entry was checked on 27/09/2026: npm packages with `npm view` (name, version, license,
// bin, not deprecated), remote endpoints with a POST answering (200, or 401 = auth required), and
// the publisher's README for the configuration. Packages are pinned to the verified version.
// Nothing here is ever installed or run by itself: adding a server is a user gesture, with the
// command and the requested values shown first.
//
// Deliberately absent: `@modelcontextprotocol/server-github` (deprecated on npm; GitHub's official
// server is the remote endpoint below).
import type { McpConfigValueInput, McpServerInput } from "@nova/shared";

export type McpCatalogTransport =
  | { type: "stdio"; command: "npx"; args: string[]; package: string; version: string }
  | { type: "http"; url: string };

export interface McpCatalogInput {
  /** `arg`: appended to args; `env`: environment variable; `header`: HTTP header. */
  kind: "arg" | "env" | "header";
  name: string;
  /** French label for the form. */
  label: string;
  secret: boolean;
  required: boolean;
  /** Prefix added before the typed value (e.g. `Bearer ` for Authorization headers). */
  valuePrefix: string | null;
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  publisher: string;
  /** French, one sentence. */
  description: string;
  homepage: string;
  /** SPDX id as published; null = not stated as an SPDX id (shown « inconnu »). */
  license: string | null;
  transport: McpCatalogTransport;
  prerequisites: ("node" | "npx")[];
  inputs: McpCatalogInput[];
  /** Only useful to test NOVA or a setup (exercises every protocol feature). */
  forTesting: boolean;
  verifiedAt: string;
}

const VERIFIED = "2026-09-27";
const REFERENCE_REPO = "https://github.com/modelcontextprotocol/servers";

const npx = (pkg: string, version: string, extra: string[] = []): McpCatalogTransport => ({
  type: "stdio",
  command: "npx",
  args: ["-y", `${pkg}@${version}`, ...extra],
  package: pkg,
  version,
});

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "filesystem",
    name: "Système de fichiers",
    publisher: "Model Context Protocol (serveurs de référence)",
    description: "Lire et modifier des fichiers dans les dossiers que tu autorises explicitement.",
    homepage: REFERENCE_REPO,
    license: null,
    transport: npx("@modelcontextprotocol/server-filesystem", "2026.8.31"),
    prerequisites: ["node", "npx"],
    inputs: [{ kind: "arg", name: "directory", label: "Dossier autorisé", secret: false, required: true, valuePrefix: null }],
    forTesting: false,
    verifiedAt: VERIFIED,
  },
  {
    id: "memory",
    name: "Mémoire (graphe de connaissances)",
    publisher: "Model Context Protocol (serveurs de référence)",
    description: "Garde des faits et des relations d'une session à l'autre dans un fichier local.",
    homepage: REFERENCE_REPO,
    license: null,
    transport: npx("@modelcontextprotocol/server-memory", "2026.8.31"),
    prerequisites: ["node", "npx"],
    inputs: [
      {
        kind: "env",
        name: "MEMORY_FILE_PATH",
        label: "Fichier de mémoire (facultatif)",
        secret: false,
        required: false,
        valuePrefix: null,
      },
    ],
    forTesting: false,
    verifiedAt: VERIFIED,
  },
  {
    id: "sequential-thinking",
    name: "Réflexion séquentielle",
    publisher: "Model Context Protocol (serveurs de référence)",
    description: "Aide le modèle à découper un problème en étapes qu'il peut réviser.",
    homepage: REFERENCE_REPO,
    license: null,
    transport: npx("@modelcontextprotocol/server-sequential-thinking", "2026.8.31"),
    prerequisites: ["node", "npx"],
    inputs: [],
    forTesting: false,
    verifiedAt: VERIFIED,
  },
  {
    id: "playwright",
    name: "Playwright (navigateur)",
    publisher: "Microsoft",
    description: "Pilote un navigateur : ouvrir des pages, cliquer, remplir des formulaires, capturer.",
    homepage: "https://github.com/microsoft/playwright-mcp",
    license: "Apache-2.0",
    transport: npx("@playwright/mcp", "0.0.82"),
    prerequisites: ["node", "npx"],
    inputs: [],
    forTesting: false,
    verifiedAt: VERIFIED,
  },
  {
    id: "context7",
    name: "Context7 (documentation)",
    publisher: "Upstash",
    description: "Documentation à jour des bibliothèques, servie à distance : rien à installer.",
    homepage: "https://github.com/upstash/context7",
    license: "MIT",
    transport: { type: "http", url: "https://mcp.context7.com/mcp" },
    prerequisites: [],
    inputs: [
      {
        kind: "header",
        name: "Authorization",
        label: "Clé API Context7 (facultative)",
        secret: true,
        required: false,
        valuePrefix: "Bearer ",
      },
    ],
    forTesting: false,
    verifiedAt: VERIFIED,
  },
  {
    id: "github",
    name: "GitHub",
    publisher: "GitHub",
    description: "Issues, pull requests et dépôts GitHub, servis à distance : rien à installer.",
    homepage: "https://github.com/github/github-mcp-server",
    license: "MIT",
    transport: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
    prerequisites: [],
    inputs: [
      {
        kind: "header",
        name: "Authorization",
        label: "Jeton d'accès personnel GitHub",
        secret: true,
        required: true,
        valuePrefix: "Bearer ",
      },
    ],
    forTesting: false,
    verifiedAt: VERIFIED,
  },
  {
    id: "notion",
    name: "Notion",
    publisher: "Notion",
    description: "Lire et modifier tes pages et bases Notion avec un jeton d'intégration.",
    homepage: "https://github.com/makenotion/notion-mcp-server",
    license: "MIT",
    transport: npx("@notionhq/notion-mcp-server", "2.5.2"),
    prerequisites: ["node", "npx"],
    inputs: [
      { kind: "env", name: "NOTION_TOKEN", label: "Jeton d'intégration Notion", secret: true, required: true, valuePrefix: null },
    ],
    forTesting: false,
    verifiedAt: VERIFIED,
  },
  {
    id: "everything",
    name: "Everything (serveur de test)",
    publisher: "Model Context Protocol (serveurs de référence)",
    description: "Serveur de démonstration qui exerce toutes les fonctions du protocole, pour tester.",
    homepage: REFERENCE_REPO,
    license: null,
    transport: npx("@modelcontextprotocol/server-everything", "2026.8.31"),
    prerequisites: ["node", "npx"],
    inputs: [],
    forTesting: true,
    verifiedAt: VERIFIED,
  },
];

/**
 * Builds the `mcp.add` input for a catalog entry from the values typed in the form (keyed by
 * input name). Returns the names of missing required inputs instead when there are any.
 */
export function catalogServerInput(
  entry: McpCatalogEntry,
  values: Readonly<Record<string, string>>,
  target: Pick<McpServerInput, "scope" | "workspaceId">,
): { ok: true; input: McpServerInput } | { ok: false; missing: string[] } {
  const missing = entry.inputs
    .filter((input) => input.required && !(values[input.name] ?? "").trim())
    .map((input) => input.name);
  if (missing.length > 0) return { ok: false, missing };
  const args: string[] = [];
  const named: Record<string, McpConfigValueInput> = {};
  for (const input of entry.inputs) {
    const typed = (values[input.name] ?? "").trim();
    if (!typed) continue;
    const value = `${input.valuePrefix ?? ""}${typed}`;
    if (input.kind === "arg") args.push(value);
    else named[input.name] = { kind: input.secret ? "secret" : "plain", value };
  }
  const transport =
    entry.transport.type === "stdio"
      ? { type: "stdio" as const, command: entry.transport.command, args: [...entry.transport.args, ...args], env: named }
      : { type: "http" as const, url: entry.transport.url, headers: named };
  return { ok: true, input: { name: entry.name, transport, ...target, enabled: true } };
}
