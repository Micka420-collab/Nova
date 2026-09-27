// Secret vault: encrypts provider keys before they reach SQLite. Only the Electron main process
// holds plaintext keys; the vault never logs or returns them anywhere else.
import type { SafeStorage } from "electron";
import type { VaultStatus } from "@nova/shared";

export interface DecryptedSecret {
  plain: string;
  /** The platform rotated its key or found a stronger one: re-encrypt and persist. */
  shouldReEncrypt: boolean;
}

export interface VaultEncryptOptions {
  /** The user explicitly accepted obfuscation-only storage (`weak-vault`). */
  allowWeak?: boolean;
}

export interface SecretVault {
  status(): Promise<VaultStatus>;
  encrypt(plain: string, options?: VaultEncryptOptions): Promise<Uint8Array>;
  decrypt(cipher: Uint8Array): Promise<DecryptedSecret>;
}

/** Vault missing, too weak for the request, or failing. Messages never contain secrets. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export type SafeStorageApi = Pick<
  SafeStorage,
  | "isAsyncEncryptionAvailable"
  | "encryptStringAsync"
  | "decryptStringAsync"
  | "getSelectedStorageBackend"
  | "setUsePlainTextEncryption"
>;

const LINUX_KEYRING_BACKENDS: ReadonlySet<string> = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);
const PROBE_PLAINTEXT = "nova-vault-probe";

/**
 * On Linux neither the selected backend nor async availability proves OS protection (Electron 44,
 * measured: `gnome_libsecret` without a running keyring and `basic_text` both encrypt with the
 * hard-coded "v10" key; a reachable Secret Service yields "v11"). The ciphertext tag decides.
 */
async function detectStatus(safeStorage: SafeStorageApi, platform: NodeJS.Platform): Promise<VaultStatus> {
  const selected = platform === "linux" ? safeStorage.getSelectedStorageBackend() : "unknown";
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    return { level: "unavailable", backend: platform === "linux" ? selected : "unknown" };
  }
  if (platform === "win32") return { level: "os", backend: "dpapi" };
  if (platform === "darwin") return { level: "os", backend: "keychain" };
  const probe = await safeStorage.encryptStringAsync(PROBE_PLAINTEXT);
  if (Buffer.from(probe.subarray(0, 3)).toString("latin1") === "v11") {
    return { level: "os", backend: LINUX_KEYRING_BACKENDS.has(selected) ? selected : "secret_service" };
  }
  return { level: "weak", backend: "basic_text" };
}

/** Vault on Electron `safeStorage` (async API). The level is detected once per process. */
export function createElectronVault(safeStorage: SafeStorageApi, platform: NodeJS.Platform): SecretVault {
  let detected: Promise<VaultStatus> | null = null;
  const status = (): Promise<VaultStatus> =>
    (detected ??= detectStatus(safeStorage, platform).catch(
      (): VaultStatus => ({ level: "unavailable", backend: "unknown" }),
    ));

  return {
    status,
    async encrypt(plain, options = {}) {
      const { level } = await status();
      if (level === "unavailable") throw new VaultError("No secret encryption is available on this system");
      if (level === "weak") {
        if (!options.allowWeak) throw new VaultError("Only weak (obfuscation) encryption is available");
        // Consent given. The async encryptor already falls back to the hard-coded key; this aligns
        // the sync API on the same explicit choice.
        safeStorage.setUsePlainTextEncryption(true);
      }
      try {
        return await safeStorage.encryptStringAsync(plain);
      } catch {
        throw new VaultError("Secret encryption failed");
      }
    },
    async decrypt(cipher) {
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
          Buffer.from(cipher.buffer, cipher.byteOffset, cipher.byteLength),
        );
        return { plain: result, shouldReEncrypt };
      } catch {
        throw new VaultError("Secret decryption failed");
      }
    },
  };
}
