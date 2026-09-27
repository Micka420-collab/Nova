// nova:// scheme: serves the built renderer (never file://).
import { protocol } from "electron";
import { serveRendererRequest } from "./renderer-assets";
import { APP_SCHEME } from "./security-policy";

/** Must run before the app `ready` event. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function handleAppProtocol(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, (request) => serveRendererRequest(rendererRoot, request));
}
