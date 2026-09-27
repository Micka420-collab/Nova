/// <reference types="vite/client" />
import type { NovaBridge } from "@nova/shared";

declare global {
  interface Window {
    /** Exposed by the sandboxed preload (apps/desktop/src/preload). Same modifiers as e2e/*.spec.ts. */
    novaBridge: NovaBridge;
  }
}
