// Electron hardening: permissions, navigation, new windows, webviews, IPC sender checks.
import { shell, type Session, type WebContents, type WebFrameMain } from "electron";
import type { Logger } from "./logger";
import { devContentSecurityPolicy } from "./renderer-assets";
import { describeUrlForLog, isAllowedExternalUrl, isAppOrigin, isAppUrl } from "./security-policy";

export interface SecurityContext {
  /** Origin of the Vite dev server when running `electron-vite dev`, else null. */
  devOrigin: string | null;
  logger: Logger;
}

function openIfAllowed(url: string, context: SecurityContext, reason: string): void {
  if (!isAllowedExternalUrl(url)) {
    context.logger.warn(`${reason} blocked`, { target: describeUrlForLog(url) });
    return;
  }
  shell.openExternal(url).catch((error: unknown) => {
    context.logger.warn("external link failed to open", { target: describeUrlForLog(url), error: String(error) });
  });
}

/**
 * Every browser permission (camera, microphone, notifications, devices, clipboard read…) is denied,
 * except writing text to the clipboard from the app page: without it `navigator.clipboard.writeText`
 * fails with "Write permission denied" (measured on Electron 44) and copy buttons silently break.
 */
export function hardenSession(session: Session, context: SecurityContext): void {
  const { devOrigin } = context;
  const allowed = (permission: string, url: string): boolean =>
    permission === "clipboard-sanitized-write" && isAppUrl(url, devOrigin);
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const granted = allowed(permission, details.requestingUrl);
    if (!granted) context.logger.warn("permission request denied", { permission });
    callback(granted);
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowed(permission, requestingOrigin));
  session.setDevicePermissionHandler(() => false);
  if (devOrigin) {
    const csp = devContentSecurityPolicy(devOrigin);
    session.webRequest.onHeadersReceived({ urls: [`${devOrigin}/*`] }, (details, callback) => {
      const kept = Object.entries(details.responseHeaders ?? {}).filter(
        ([name]) => name.toLowerCase() !== "content-security-policy",
      );
      callback({ responseHeaders: { ...Object.fromEntries(kept), "Content-Security-Policy": [csp] } });
    });
  }
}

/** Applied to every WebContents: the app never navigates away, opens windows or hosts webviews. */
export function hardenWebContents(contents: WebContents, context: SecurityContext): void {
  const guardNavigation = (event: Electron.Event<{ url: string }>): void => {
    if (isAppUrl(event.url, context.devOrigin)) return;
    event.preventDefault();
    openIfAllowed(event.url, context, "navigation");
  };
  contents.on("will-navigate", guardNavigation);
  contents.on("will-redirect", guardNavigation);
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    context.logger.warn("webview attachment blocked");
  });
  contents.setWindowOpenHandler(({ url }) => {
    openIfAllowed(url, context, "window open");
    return { action: "deny" };
  });
}

/** IPC is accepted only from the app's own top-level page. */
export function isTrustedSender(frame: WebFrameMain | null | undefined, devOrigin: string | null): boolean {
  if (!frame || frame.parent !== null) return false;
  return isAppUrl(frame.url, devOrigin) && isAppOrigin(frame.origin, devOrigin);
}
