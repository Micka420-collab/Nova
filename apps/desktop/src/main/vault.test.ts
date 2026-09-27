import { describe, expect, it } from "vitest";
import { createElectronVault, VaultError, type SafeStorageApi } from "./vault";

type Backend = ReturnType<SafeStorageApi["getSelectedStorageBackend"]>;

/** Stand-in for Electron safeStorage: ciphertext = version tag + reversed bytes. */
class FakeSafeStorage implements SafeStorageApi {
  plainTextForced = false;
  availabilityChecks = 0;
  shouldReEncrypt = false;
  constructor(
    private readonly options: { available: boolean; tag: "v10" | "v11"; backend: Backend },
  ) {}

  async isAsyncEncryptionAvailable() {
    this.availabilityChecks += 1;
    return this.options.available;
  }

  async encryptStringAsync(plainText: string) {
    return Buffer.concat([Buffer.from(this.options.tag), Buffer.from(plainText).reverse()]);
  }

  async decryptStringAsync(encrypted: Buffer) {
    if (encrypted.length < 3) throw new Error("bad ciphertext");
    return { result: Buffer.from(encrypted.subarray(3)).reverse().toString(), shouldReEncrypt: this.shouldReEncrypt };
  }

  getSelectedStorageBackend(): Backend {
    return this.options.backend;
  }

  setUsePlainTextEncryption(usePlainText: boolean) {
    this.plainTextForced = usePlainText;
  }
}

describe("Electron vault level detection", () => {
  it.each([
    ["linux", { available: true, tag: "v11", backend: "gnome_libsecret" }, { level: "os", backend: "gnome_libsecret" }],
    ["linux", { available: true, tag: "v11", backend: "basic_text" }, { level: "os", backend: "secret_service" }],
    // Measured on Electron 44: a keyring backend selected but unreachable still encrypts with v10.
    ["linux", { available: true, tag: "v10", backend: "gnome_libsecret" }, { level: "weak", backend: "basic_text" }],
    ["linux", { available: true, tag: "v10", backend: "basic_text" }, { level: "weak", backend: "basic_text" }],
    ["linux", { available: false, tag: "v10", backend: "unknown" }, { level: "unavailable", backend: "unknown" }],
    ["win32", { available: true, tag: "v10", backend: "unknown" }, { level: "os", backend: "dpapi" }],
    ["darwin", { available: true, tag: "v10", backend: "unknown" }, { level: "os", backend: "keychain" }],
    ["darwin", { available: false, tag: "v10", backend: "unknown" }, { level: "unavailable", backend: "unknown" }],
  ] as const)("%s %o -> %o", async (platform, options, expected) => {
    const safeStorage = new FakeSafeStorage(options);
    const vault = createElectronVault(safeStorage, platform);
    await expect(vault.status()).resolves.toEqual(expected);
    await vault.status();
    expect(safeStorage.availabilityChecks).toBe(1);
  });
});

describe("Electron vault encryption", () => {
  it("refuses weak encryption without explicit consent", async () => {
    const safeStorage = new FakeSafeStorage({ available: true, tag: "v10", backend: "basic_text" });
    const vault = createElectronVault(safeStorage, "linux");

    await expect(vault.encrypt("sk-or-v1-secret")).rejects.toBeInstanceOf(VaultError);
    expect(safeStorage.plainTextForced).toBe(false);

    const cipher = await vault.encrypt("sk-or-v1-secret", { allowWeak: true });
    expect(safeStorage.plainTextForced).toBe(true);
    expect(Buffer.from(cipher).toString("latin1")).not.toContain("sk-or-v1-secret");
    await expect(vault.decrypt(cipher)).resolves.toEqual({ plain: "sk-or-v1-secret", shouldReEncrypt: false });
  });

  it("encrypts at OS level without touching the plaintext fallback", async () => {
    const safeStorage = new FakeSafeStorage({ available: true, tag: "v11", backend: "kwallet6" });
    safeStorage.shouldReEncrypt = true;
    const vault = createElectronVault(safeStorage, "linux");
    const cipher = await vault.encrypt("sk-or-v1-secret");
    expect(safeStorage.plainTextForced).toBe(false);
    await expect(vault.decrypt(cipher)).resolves.toEqual({ plain: "sk-or-v1-secret", shouldReEncrypt: true });
  });

  it("fails closed when nothing is available and reports decryption failures without detail", async () => {
    const vault = createElectronVault(new FakeSafeStorage({ available: false, tag: "v10", backend: "unknown" }), "linux");
    await expect(vault.encrypt("sk-or-v1-secret", { allowWeak: true })).rejects.toBeInstanceOf(VaultError);
    await expect(vault.decrypt(new Uint8Array([1]))).rejects.toEqual(new VaultError("Secret decryption failed"));
  });
});
