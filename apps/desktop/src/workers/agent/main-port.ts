// Main-process side of the agent-runtime link: a fresh MessageChannelMain whose first end is
// attached to the worker (`channel.attach`); the second end is the main side of the mission
// channel. Each call replaces the previous link (the worker closes its old channel; main fails
// the missions that were running on it).
import { MessageChannelMain } from "electron";
import type { PortLike } from "@nova/missions";
import type { WorkerPool } from "../../main/workers";
import { portFromMessagePortMain } from "./electron-port";

export async function openAgentRuntimePort(workers: Pick<WorkerPool, "get">): Promise<PortLike> {
  const { port1, port2 } = new MessageChannelMain();
  try {
    await workers.get("agent-runtime").request("channel.attach", null, [port1]);
  } catch (error) {
    port2.close();
    throw error;
  }
  return portFromMessagePortMain(port2);
}
