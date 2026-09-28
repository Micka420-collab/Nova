// Content hashes (SHA-256 hex of the exact bytes on disk) and text decoding.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ContentHash } from "@nova/shared";
import { errnoCode } from "./errors";

export function sha256(bytes: Uint8Array | string): ContentHash {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Streams the file (large files are never fully loaded to hash them). */
export function hashFile(absolute: string): Promise<ContentHash> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(absolute)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Hash of the file, or null when it does not exist. */
export async function hashFileOrNull(absolute: string): Promise<ContentHash | null> {
  try {
    return await hashFile(absolute);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

const BINARY_SNIFF_BYTES = 8_000;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * UTF-8 text of the bytes, or null when they look binary (a NUL byte in the first 8 000 bytes, as
 * git does, or invalid UTF-8). The BOM is kept so that writing the text back is byte-identical.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Dominant line ending of a text, null when it has no line break. */
export function detectEol(text: string): "lf" | "crlf" | null {
  let crlf = 0;
  let lf = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf += 1;
    else lf += 1;
  }
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? "crlf" : "lf";
}
