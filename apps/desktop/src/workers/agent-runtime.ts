// agent-runtime utilityProcess: will run the mission loop (@nova/missions). Holds no key: generations go through the main-process provider proxy.
// Phase 0: answers the built-in ping only.
import { serveWorker } from "./serve";

serveWorker("agent-runtime", {});
