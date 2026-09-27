// App information and external links.
import type { AppInfo, OpenExternalRequest } from "@nova/shared";
import { isAllowedExternalUrl } from "../security-policy";
import { ServiceError } from "../service-error";
import type { SecretVault } from "../vault";

export interface AppServiceDeps {
  info: Omit<AppInfo, "vault">;
  vault: Pick<SecretVault, "status">;
  /** Opens a URL in the system browser (Electron `shell.openExternal`). */
  openExternal: (url: string) => Promise<void>;
}

export interface AppService {
  info(): Promise<AppInfo>;
  openExternal(req: OpenExternalRequest): Promise<void>;
}

export function createAppService(deps: AppServiceDeps): AppService {
  return {
    info: async () => ({ ...deps.info, vault: await deps.vault.status() }),
    openExternal: async ({ url }) => {
      if (!isAllowedExternalUrl(url)) throw new ServiceError("invalid_request", "URL not in the external allowlist");
      await deps.openExternal(url);
    },
  };
}
