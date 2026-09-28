// SDK transports for the two supported kinds. The legacy HTTP+SSE transport is not supported.
//
// stdio: spawned by the SDK (`StdioClientTransport`, cross-spawn, shell: false). The SDK merges
// `getDefaultEnvironment()` (HOME, LOGNAME, PATH, SHELL, TERM, USER; a Windows equivalent) of the
// CURRENT process — the mcp-host worker, whose own environment main already scrubbed — with the
// explicit `env` given here (the server's configured variables, secrets injected by main).
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface StdioLaunch {
  command: string;
  args: readonly string[];
  /** Configured variables, already resolved (plain + decrypted secrets). */
  env: Readonly<Record<string, string>>;
  /** Working directory (workspace root for workspace servers); null = the host's. */
  cwd: string | null;
}

export interface HttpEndpoint {
  url: string;
  /** Configured headers, already resolved (plain + decrypted secrets). */
  headers: Readonly<Record<string, string>>;
}

/** Largest single JSON-RPC message accepted from a stdio server (the SDK default is 10 MB). */
const STDIO_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export function stdioTransportFactory(launch: StdioLaunch): (stderr: (chunk: string) => void) => Transport {
  return (stderr) => {
    const transport = new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      env: { ...launch.env },
      stderr: "pipe",
      maxBufferSize: STDIO_MAX_MESSAGE_BYTES,
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
    });
    // The PassThrough exists before start(): early startup errors are not lost.
    transport.stderr?.on("data", (chunk: Buffer | string) => stderr(chunk.toString()));
    return transport;
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Refuses to send configured secrets in clear text: a plain `http://` URL is only accepted for
 * loopback hosts when headers carry secrets. Returns a French reason, or null when acceptable.
 */
export function httpEndpointProblem(url: string, carriesSecrets: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Adresse invalide.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Seuls http et https sont acceptés.";
  if (parsed.username || parsed.password) return "L'adresse ne doit pas contenir d'identifiants.";
  if (parsed.protocol === "http:" && carriesSecrets && !isLoopback(parsed.hostname)) {
    return "Un secret ne peut pas être envoyé en http non chiffré (https requis).";
  }
  return null;
}

export function httpTransportFactory(endpoint: HttpEndpoint, fetchImpl?: FetchLike): () => Transport {
  return () =>
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      // Redirects are refused: a redirect would carry configured headers to another origin.
      requestInit: { headers: { ...endpoint.headers }, redirect: "error" },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
}
