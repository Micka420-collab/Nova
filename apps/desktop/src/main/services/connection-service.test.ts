import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProviderError, providerErrorInfo } from "@nova/providers";
import type { KeyCheckResult, KeyStorage, VaultLevel } from "@nova/shared";
import { openNovaStore, type NovaStore } from "@nova/storage";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceError } from "../service-error";
import { VaultError, type SecretVault } from "../vault";
import { ConnectionService } from "./connection-service";

const KEY = "sk-or-v1-first-key-0000000000000000000000000000aaaa";
const OTHER_KEY = "sk-or-v1-second-key-000000000000000000000000000bbbb";
const CHECK: KeyCheckResult = { label: "Clé test", limit: 5, limitRemaining: 4, usage: 1, isFreeTier: false };

/** Reversible, but the ciphertext never contains the plaintext bytes. */
const scramble = (bytes: Uint8Array): Uint8Array => bytes.map((byte) => byte ^ 0x5a);

class FakeVault implements SecretVault {
  shouldReEncrypt = false;
  /** Simulates a locked or reset keyring. */
  unreadable = false;
  readonly encryptCalls: { allowWeak: boolean }[] = [];
  constructor(
    public level: VaultLevel,
    public backend = level === "os" ? "gnome_libsecret" : "basic_text",
  ) {}

  async status() {
    return { level: this.level, backend: this.backend };
  }

  async encrypt(plain: string, options: { allowWeak?: boolean } = {}) {
    this.encryptCalls.push({ allowWeak: options.allowWeak === true });
    if (this.level === "unavailable" || (this.level === "weak" && !options.allowWeak)) {
      throw new VaultError("refused");
    }
    return scramble(new TextEncoder().encode(plain));
  }

  async decrypt(cipher: Uint8Array) {
    if (this.unreadable) throw new VaultError("Secret decryption failed");
    return { plain: new TextDecoder().decode(scramble(cipher)), shouldReEncrypt: this.shouldReEncrypt };
  }
}

class FakeProvider {
  readonly id = "openrouter" as const;
  readonly checked: string[] = [];
  outcome: KeyCheckResult | ProviderError = CHECK;

  async checkKey(apiKey: string): Promise<KeyCheckResult> {
    this.checked.push(apiKey);
    if (this.outcome instanceof ProviderError) throw this.outcome;
    return this.outcome;
  }
}

const dirs: string[] = [];
const stores: NovaStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(level: VaultLevel = "os") {
  const dir = mkdtempSync(join(tmpdir(), "nova-connection-"));
  dirs.push(dir);
  const dbPath = join(dir, "nova.sqlite");
  const store = openNovaStore(dbPath);
  stores.push(store);
  const vault = new FakeVault(level);
  const provider = new FakeProvider();
  let clock = 1_000;
  const now = () => (clock += 1);
  const service = new ConnectionService({ store, vault, provider, now });
  /** Simulates an app restart on the same database. */
  const restart = () => new ConnectionService({ store, vault, provider, now });
  const secretCount = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Number(db.prepare("SELECT count(*) AS n FROM secrets").get()?.n);
    } finally {
      db.close();
    }
  };
  const diskText = () =>
    readdirSync(dir)
      .map((name) => readFileSync(join(dir, name)).toString("latin1"))
      .join("\n");
  return { store, vault, provider, service, restart, secretCount, diskText };
}

describe("ConnectionService.setKey", () => {
  it("stores a verified key encrypted and exposes only its last 4 characters", async () => {
    const { service, store, provider, secretCount, diskText } = setup("os");
    const view = await service.setKey({ apiKey: KEY, storage: "vault" });

    expect(provider.checked).toEqual([KEY]);
    expect(view).toMatchObject({ state: "valid", storage: "vault", keyHint: "aaaa", check: CHECK, lastError: null });
    expect(view.lastCheckedAt).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain(KEY.slice(0, -4));
    expect(JSON.stringify(service.get())).not.toContain(KEY.slice(0, -4));
    expect(store.getConnection("openrouter")).toMatchObject({ storage: "vault", keyHint: "aaaa" });
    expect(JSON.stringify(store.getConnection("openrouter"))).not.toContain(KEY);
    expect(secretCount()).toBe(1);
    expect(diskText()).not.toContain(KEY);
    await expect(service.resolveApiKey()).resolves.toBe(KEY);
  });

  it("stores nothing for a rejected key and keeps the previous connection", async () => {
    const { service, provider, secretCount } = setup("os");
    await service.setKey({ apiKey: KEY, storage: "vault" });
    provider.outcome = new ProviderError(providerErrorInfo("invalid_key", { httpStatus: 401 }));

    await expect(service.setKey({ apiKey: OTHER_KEY, storage: "vault" })).rejects.toMatchObject({
      info: { code: "invalid_key" },
    });
    expect(service.get()).toMatchObject({ state: "valid", keyHint: "aaaa" });
    expect(secretCount()).toBe(1);
    await expect(service.resolveApiKey()).resolves.toBe(KEY);
  });

  it("stores the key as unverified when the check cannot reach the provider", async () => {
    const { service, provider } = setup("os");
    const network = providerErrorInfo("network", { providerMessage: "fetch failed" });
    provider.outcome = new ProviderError(network);

    const view = await service.setKey({ apiKey: KEY, storage: "vault" });
    expect(view).toMatchObject({ state: "unverified", check: null, lastError: network, keyHint: "aaaa" });
    await expect(service.resolveApiKey()).resolves.toBe(KEY);
  });

  it("rejects non-retryable check failures without storing", async () => {
    const { service, provider } = setup("os");
    provider.outcome = new ProviderError(providerErrorInfo("forbidden", { httpStatus: 403 }));
    await expect(service.setKey({ apiKey: KEY, storage: "vault" })).rejects.toBeInstanceOf(ProviderError);
    expect(service.get().state).toBe("absent");
  });

  const allowed: [VaultLevel, KeyStorage][] = [
    ["os", "vault"],
    ["os", "weak-vault"],
    ["os", "session"],
    ["weak", "weak-vault"],
    ["weak", "session"],
    ["unavailable", "session"],
  ];
  it.each(allowed)("vault level %s accepts storage %s", async (level, storage) => {
    const { service, vault } = setup(level);
    await expect(service.setKey({ apiKey: KEY, storage })).resolves.toMatchObject({ state: "valid", storage });
    // Weak ciphertext is only produced with the explicit weak-vault choice.
    expect(vault.encryptCalls).toEqual(storage === "session" ? [] : [{ allowWeak: storage === "weak-vault" }]);
    await expect(service.resolveApiKey()).resolves.toBe(KEY);
  });

  const refused: [VaultLevel, KeyStorage][] = [
    ["weak", "vault"],
    ["unavailable", "vault"],
    ["unavailable", "weak-vault"],
  ];
  it.each(refused)("vault level %s refuses storage %s before checking the key", async (level, storage) => {
    const { service, provider } = setup(level);
    await expect(service.setKey({ apiKey: KEY, storage })).rejects.toBeInstanceOf(VaultError);
    expect(provider.checked).toEqual([]);
    expect(service.get().state).toBe("absent");
  });

  it("deletes the previous secret when the key is replaced", async () => {
    const { service, store, secretCount } = setup("os");
    await service.setKey({ apiKey: KEY, storage: "vault" });
    const firstRef = store.getConnection("openrouter")?.secretRef;

    await service.setKey({ apiKey: OTHER_KEY, storage: "vault" });
    expect(firstRef).toBeTruthy();
    expect(store.getSecret(firstRef ?? "")).toBeNull();
    expect(secretCount()).toBe(1);
    await expect(service.resolveApiKey()).resolves.toBe(OTHER_KEY);

    await service.setKey({ apiKey: KEY, storage: "session" });
    expect(secretCount()).toBe(0);
    await expect(service.resolveApiKey()).resolves.toBe(KEY);
  });

  it("serializes concurrent saves so no secret is orphaned", async () => {
    const { service, secretCount } = setup("os");
    await Promise.all([
      service.setKey({ apiKey: KEY, storage: "vault" }),
      service.setKey({ apiKey: OTHER_KEY, storage: "vault" }),
    ]);
    expect(secretCount()).toBe(1);
    await expect(service.resolveApiKey()).resolves.toBe(OTHER_KEY);
  });
});

describe("ConnectionService key lifetime", () => {
  it("keeps session keys in memory only: a restart forgets them", async () => {
    const { service, restart, secretCount, diskText } = setup("weak");
    await service.setKey({ apiKey: KEY, storage: "session" });
    expect(service.get()).toMatchObject({ state: "valid", storage: "session", keyHint: "aaaa" });
    expect(secretCount()).toBe(0);
    expect(diskText()).not.toContain(KEY);

    const next = restart();
    expect(next.get().state).toBe("absent");
    await expect(next.resolveApiKey()).resolves.toBeNull();
  });

  it("resolves a vault key after a restart", async () => {
    const { service, restart } = setup("os");
    await service.setKey({ apiKey: KEY, storage: "vault" });
    await expect(restart().resolveApiKey()).resolves.toBe(KEY);
  });

  it("re-encrypts in place when the vault asks for it", async () => {
    const { service, store, vault } = setup("weak");
    await service.setKey({ apiKey: KEY, storage: "weak-vault" });
    const ref = store.getConnection("openrouter")?.secretRef ?? "";
    vault.level = "os";
    vault.backend = "gnome_libsecret";
    vault.shouldReEncrypt = true;

    await expect(service.resolveApiKey()).resolves.toBe(KEY);
    expect(store.getSecret(ref)?.backend).toBe("gnome_libsecret");
    expect(store.getConnection("openrouter")?.secretRef).toBe(ref);
  });

  it("remove deletes the connection, its secret and the session key", async () => {
    const { service, secretCount } = setup("os");
    await service.setKey({ apiKey: KEY, storage: "vault" });
    await expect(service.remove()).resolves.toMatchObject({ state: "absent", storage: null, keyHint: null });
    expect(secretCount()).toBe(0);
    await expect(service.resolveApiKey()).resolves.toBeNull();

    await service.setKey({ apiKey: OTHER_KEY, storage: "session" });
    await service.remove();
    await expect(service.resolveApiKey()).resolves.toBeNull();
  });
});

describe("ConnectionService.recordChatFailure", () => {
  it("marks the connection invalid when a chat was refused with the current key", async () => {
    const { service } = setup("os");
    await service.setKey({ apiKey: KEY, storage: "vault" });
    const refused = providerErrorInfo("invalid_key", { httpStatus: 401, providerMessage: "User not found." });

    await service.recordChatFailure(KEY, providerErrorInfo("rate_limited", { httpStatus: 429 }));
    expect(service.get().state).toBe("valid");
    await service.recordChatFailure(KEY, refused);
    expect(service.get()).toMatchObject({ state: "invalid", check: null, lastError: refused, keyHint: "aaaa" });
  });

  it("ignores a refusal of a key that has been replaced since", async () => {
    const { service } = setup("os");
    await service.setKey({ apiKey: KEY, storage: "vault" });
    await service.setKey({ apiKey: OTHER_KEY, storage: "session" });
    await service.recordChatFailure(KEY, providerErrorInfo("invalid_key", { httpStatus: 401 }));
    expect(service.get()).toMatchObject({ state: "valid", keyHint: "bbbb" });
  });
});

describe("ConnectionService.test", () => {
  it("reports valid, invalid and error outcomes of a re-check", async () => {
    const { service, provider } = setup("os");
    await service.setKey({ apiKey: KEY, storage: "vault" });

    provider.outcome = new ProviderError(providerErrorInfo("timeout"));
    await expect(service.test()).resolves.toMatchObject({ state: "error", check: null, lastError: { code: "timeout" } });

    provider.outcome = new ProviderError(providerErrorInfo("invalid_key", { httpStatus: 401 }));
    await expect(service.test()).resolves.toMatchObject({ state: "invalid", lastError: { code: "invalid_key" } });

    provider.outcome = CHECK;
    await expect(service.test()).resolves.toMatchObject({ state: "valid", check: CHECK, lastError: null });
    expect(provider.checked).toEqual([KEY, KEY, KEY, KEY]);
  });

  it("records an undecryptable key as an error and refuses with key_unreadable", async () => {
    const { service, vault } = setup("os");
    await service.setKey({ apiKey: KEY, storage: "vault" });
    vault.unreadable = true;

    await expect(service.resolveApiKey()).rejects.toEqual(
      new ServiceError("key_unreadable", "Stored key cannot be decrypted"),
    );
    await expect(service.test()).rejects.toMatchObject({ name: "ServiceError", code: "key_unreadable" });
    expect(service.get()).toMatchObject({
      state: "error",
      check: null,
      keyHint: "aaaa",
      lastError: { code: "key_unreadable" },
    });

    vault.unreadable = false;
    await expect(service.test()).resolves.toMatchObject({ state: "valid", lastError: null });
  });

  it("refuses to test without a key", async () => {
    const { service } = setup("os");
    await expect(service.test()).rejects.toEqual(new ServiceError("no_key", "No key configured for this provider"));
  });
});
