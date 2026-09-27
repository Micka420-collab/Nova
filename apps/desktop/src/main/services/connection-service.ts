// Provider connection: key verification, vault storage, session keys, key resolution for the runtime.
// The plaintext key never leaves this service except towards the provider (and the vault).
import { randomUUID } from "node:crypto";
import type { RuntimeLogger } from "@nova/agent-runtime";
import { ProviderError, type ModelProvider } from "@nova/providers";
import {
  keyHint,
  type KeyStorage,
  type ProviderConnectionView,
  type SetKeyRequest,
  type VaultLevel,
} from "@nova/shared";
import type { NovaStore, ProviderConnectionRecord } from "@nova/storage";
import { describeError } from "../logger";
import { ServiceError } from "../service-error";
import { VaultError, type SecretVault } from "../vault";

export interface ConnectionServiceDeps {
  store: NovaStore;
  vault: SecretVault;
  provider: Pick<ModelProvider, "id" | "checkKey">;
  now?: () => number;
  logger?: RuntimeLogger;
}

type Verification = Pick<ProviderConnectionRecord, "state" | "check" | "lastError" | "lastCheckedAt">;

const STORAGE_LEVELS: Readonly<Record<KeyStorage, readonly VaultLevel[]>> = {
  vault: ["os"],
  "weak-vault": ["os", "weak"],
  session: ["os", "weak", "unavailable"],
};

const SILENT_LOGGER: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} };

export function storageAllowed(storage: KeyStorage, level: VaultLevel): boolean {
  return STORAGE_LEVELS[storage].includes(level);
}

export class ConnectionService {
  /** Session keys live only in this process memory. */
  private readonly sessionKeys = new Map<string, string>();
  /** Mutations run one at a time: a verification awaits the network between read and write. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly logger: RuntimeLogger;

  constructor(private readonly deps: ConnectionServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? SILENT_LOGGER;
    // A new service means a new process: a session row left by a previous run has no key anymore.
    if (deps.store.getConnection(deps.provider.id)?.storage === "session") {
      deps.store.deleteConnection(deps.provider.id);
    }
  }

  get(): ProviderConnectionView {
    return this.toView(this.deps.store.getConnection(this.deps.provider.id));
  }

  /**
   * Verifies then stores a key. An invalid key stores nothing and throws its ProviderError; a
   * retryable failure (network, timeout, provider down) stores it as `unverified`.
   */
  setKey(req: Pick<SetKeyRequest, "apiKey" | "storage">): Promise<ProviderConnectionView> {
    return this.serialize(async () => {
      const { store, vault, provider } = this.deps;
      const { apiKey, storage } = req;
      const vaultStatus = await vault.status();
      if (!storageAllowed(storage, vaultStatus.level)) {
        throw new VaultError(`Storage "${storage}" is not available with a vault of level "${vaultStatus.level}"`);
      }
      const verification = await this.verifyNewKey(apiKey);
      const previous = store.getConnection(provider.id);
      let secretRef: string | null = null;
      if (storage !== "session") {
        const ciphertext = await vault.encrypt(apiKey, { allowWeak: storage === "weak-vault" });
        secretRef = randomUUID();
        store.putSecret({ id: secretRef, ciphertext, backend: vaultStatus.backend, createdAt: this.now() });
      }
      const record: ProviderConnectionRecord = {
        providerId: provider.id,
        secretRef,
        storage,
        keyHint: keyHint(apiKey),
        ...verification,
        updatedAt: this.now(),
      };
      store.upsertConnection(record);
      if (previous?.secretRef && previous.secretRef !== secretRef) store.deleteSecret(previous.secretRef);
      if (storage === "session") this.sessionKeys.set(provider.id, apiKey);
      else this.sessionKeys.delete(provider.id);
      this.logger.info("provider key saved", { providerId: provider.id, storage, state: record.state });
      return this.toView(record);
    });
  }

  /** Re-checks the stored key: `valid`, `invalid` (rejected key) or `error` (check not completed). */
  test(): Promise<ProviderConnectionView> {
    return this.serialize(async () => {
      const { store, provider } = this.deps;
      const record = store.getConnection(provider.id);
      const apiKey = record ? await this.resolveApiKey() : null;
      if (!record || !apiKey) throw new ServiceError("no_key", "No key configured for this provider");
      let verification: Verification;
      try {
        const check = await provider.checkKey(apiKey);
        verification = { state: "valid", check, lastError: null, lastCheckedAt: this.now() };
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        const state = error.info.code === "invalid_key" ? "invalid" : "error";
        verification = { state, check: null, lastError: error.info, lastCheckedAt: this.now() };
      }
      const updated: ProviderConnectionRecord = { ...record, ...verification, updatedAt: this.now() };
      store.upsertConnection(updated);
      this.logger.info("provider key tested", { providerId: provider.id, state: updated.state });
      return this.toView(updated);
    });
  }

  remove(): Promise<ProviderConnectionView> {
    return this.serialize(async () => {
      const { store, provider } = this.deps;
      const record = store.getConnection(provider.id);
      store.deleteConnection(provider.id);
      if (record?.secretRef) store.deleteSecret(record.secretRef);
      this.sessionKeys.delete(provider.id);
      this.logger.info("provider key removed", { providerId: provider.id });
      return this.toView(null);
    });
  }

  /** Plaintext key for provider calls, from session memory or the vault; null when none is set. */
  async resolveApiKey(): Promise<string | null> {
    const { store, vault, provider } = this.deps;
    const record = store.getConnection(provider.id);
    if (!record) return null;
    if (record.storage === "session") return this.sessionKeys.get(provider.id) ?? null;
    const secret = record.secretRef ? store.getSecret(record.secretRef) : null;
    if (!secret) return null;
    const { plain, shouldReEncrypt } = await vault.decrypt(secret.ciphertext);
    if (shouldReEncrypt) await this.reEncrypt(record.storage, secret.id, plain);
    return plain;
  }

  private async verifyNewKey(apiKey: string): Promise<Verification> {
    try {
      const check = await this.deps.provider.checkKey(apiKey);
      return { state: "valid", check, lastError: null, lastCheckedAt: this.now() };
    } catch (error) {
      if (error instanceof ProviderError && error.info.retryable) {
        return { state: "unverified", check: null, lastError: error.info, lastCheckedAt: this.now() };
      }
      throw error;
    }
  }

  private async reEncrypt(storage: KeyStorage, secretId: string, plain: string): Promise<void> {
    const { store, vault, provider } = this.deps;
    try {
      const { backend } = await vault.status();
      const ciphertext = await vault.encrypt(plain, { allowWeak: storage === "weak-vault" });
      // A replace or remove may have happened meanwhile: never resurrect a dropped secret.
      if (store.getConnection(provider.id)?.secretRef !== secretId) return;
      store.putSecret({ id: secretId, ciphertext, backend, createdAt: this.now() });
      this.logger.info("provider key re-encrypted", { providerId: provider.id, backend });
    } catch (error) {
      this.logger.warn("provider key re-encryption failed, previous ciphertext kept", {
        providerId: provider.id,
        error: describeError(error),
      });
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private toView(record: ProviderConnectionRecord | null): ProviderConnectionView {
    if (!record) {
      return {
        providerId: this.deps.provider.id,
        state: "absent",
        storage: null,
        keyHint: null,
        lastCheckedAt: null,
        lastError: null,
        check: null,
      };
    }
    return {
      providerId: record.providerId,
      state: record.state,
      storage: record.storage,
      keyHint: record.keyHint,
      lastCheckedAt: record.lastCheckedAt,
      lastError: record.lastError,
      check: record.check,
    };
  }
}
