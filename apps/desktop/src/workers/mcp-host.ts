// mcp-host utilityProcess: will host one stdio MCP server (@nova/mcp) with a scrubbed environment.
// Phase 0: answers the built-in ping only.
import { serveWorker } from "./serve";

serveWorker("mcp-host", {});
