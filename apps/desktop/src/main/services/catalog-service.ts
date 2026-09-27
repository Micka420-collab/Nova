// Model catalog: live from the provider, cached in SQLite, served from cache when offline.
import type { RuntimeLogger } from "@nova/agent-runtime";
import { ProviderError, type ModelProvider } from "@nova/providers";
import type { CatalogRequest, ModelCatalog, ModelInfo, ProviderErrorInfo } from "@nova/shared";
import type { NovaStore } from "@nova/storage";
import { describeError } from "../logger";

export const CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface CatalogServiceDeps {
  store: NovaStore;
  provider: Pick<ModelProvider, "id" | "listModels">;
  /** The catalog is public: a missing or unreadable key only drops the optional auth header. */
  resolveApiKey: () => Promise<string | null>;
  now?: () => number;
  logger?: RuntimeLogger;
}

export class CatalogService {
  private readonly now: () => number;

  constructor(private readonly deps: CatalogServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async catalog(req: Pick<CatalogRequest, "refresh">): Promise<ModelCatalog> {
    const { store, provider } = this.deps;
    const cached = store.loadCatalog(provider.id);
    if (cached && !req.refresh) {
      const age = this.now() - cached.fetchedAt;
      // A negative age (clock moved back) is not trusted as fresh.
      if (age >= 0 && age < CATALOG_MAX_AGE_MS) return this.fromCache(cached, null);
    }
    try {
      const apiKey = await this.optionalApiKey();
      const models = await provider.listModels(apiKey ? { apiKey } : {});
      const fetchedAt = this.now();
      store.saveCatalog(provider.id, models, fetchedAt);
      return { providerId: provider.id, models, fetchedAt, source: "network", refreshError: null };
    } catch (error) {
      if (!(error instanceof ProviderError) || !cached) throw error;
      this.deps.logger?.warn("catalog refresh failed, serving cache", { code: error.info.code });
      return this.fromCache(cached, error.info);
    }
  }

  private fromCache(
    cached: { models: ModelInfo[]; fetchedAt: number },
    refreshError: ProviderErrorInfo | null,
  ): ModelCatalog {
    return {
      providerId: this.deps.provider.id,
      models: cached.models,
      fetchedAt: cached.fetchedAt,
      source: "cache",
      refreshError,
    };
  }

  private async optionalApiKey(): Promise<string | null> {
    try {
      return await this.deps.resolveApiKey();
    } catch (error) {
      this.deps.logger?.warn("catalog fetched without key: key unavailable", { error: describeError(error) });
      return null;
    }
  }
}
