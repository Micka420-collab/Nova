// chain-host utilityProcess (mode « Chaîne », L4): runs ONE program in a fresh V8 context, then is
// killed by main. See ./chain/session.ts (limits), ./chain/sandbox.ts (isolation) and
// @nova/chain (protocol, main-side runner). Started by main's chain-service with a scrubbed
// environment and a V8 heap cap; it holds no secret and opens nothing itself.
import { createChainHostSession } from "./chain/session";

const port = process.parentPort;

const session = createChainHostSession({
  post: (message) => port.postMessage(message),
  heapUsedBytes: () => process.memoryUsage().heapUsed,
});

// A rejection the program leaves unhandled is the program's business; it must not kill the host.
process.on("unhandledRejection", () => {});
// Any host failure ends this process: main reports "the program host stopped unexpectedly".
process.on("uncaughtException", () => process.exit(70));

port.on("message", (event) => session.handle(event.data));
port.postMessage({ type: "ready" });
