// agent-runtime utilityProcess: runs the mission loop (@nova/missions). It holds NO key and opens
// no socket: main attaches one MessagePort (`channel.attach`) over which generations go through
// main's provider proxy and tool calls through main's gateway (permission first, S1).
import { buildMissionSystemPrompt } from "@nova/agent-runtime";
import { serveRuntimeChannel } from "@nova/missions";
import { portFromMessagePortMain } from "./agent/electron-port";
import { serveWorker, WorkerMethodError } from "./serve";

let current: ReturnType<typeof serveRuntimeChannel> | null = null;

serveWorker("agent-runtime", {
  "channel.attach": (_params, context) => {
    const port = context.ports[0];
    if (!port) throw new WorkerMethodError("invalid_params", "a message port is required");
    // A new attach replaces the previous link: its missions were already failed by main.
    current?.channel.close();
    current = serveRuntimeChannel(portFromMessagePortMain(port), { systemPrompt: buildMissionSystemPrompt });
    return { attached: true };
  },
});
