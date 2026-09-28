// J2-B L7: images pasted in Discuter. What a model accepts comes only from the catalog
// (`inputModalities`); no model id is ever written here. Images stay in the renderer's memory until
// the message leaves, then are dropped (never stored).
import { CHAT_IMAGE_LIMITS, CHAT_IMAGE_MEDIA_TYPES, type ChatImage, type ModelInfo } from "@nova/shared";

type ImageMediaType = ChatImage["mediaType"];

/** True only when the catalog lists "image" as an input of the model (unknown = false, never guessed). */
export function acceptsImages(model: ModelInfo | null | undefined): boolean {
  return model?.inputModalities?.includes("image") === true;
}

function isExpired(model: ModelInfo, now: number): boolean {
  if (!model.expirationDate) return false;
  const at = Date.parse(model.expirationDate);
  return Number.isFinite(at) && at <= now;
}

/** Estimated price of a typical call; null when the catalog does not give both prices. */
function priceOf(model: ModelInfo): number | null {
  const { promptPerMTok, completionPerMTok, variable } = model.pricing;
  if (variable || promptPerMTok === null || completionPerMTok === null) return null;
  return promptPerMTok * 4 + completionPerMTok;
}

/**
 * A model of the catalog that accepts images and answers in text, to suggest when an image is
 * pasted and the current model cannot read it. Same author as the current model first (closest
 * behavior), then the cheapest known price; unknown prices last, free and retired models never.
 * Null when the catalog has none: the UI then says so instead of guessing.
 */
export function pickVisionModel(models: readonly ModelInfo[], current: ModelInfo | null, now: number = Date.now()): ModelInfo | null {
  const candidates = models.filter(
    (model) =>
      model.id !== current?.id &&
      acceptsImages(model) &&
      !model.isFree &&
      !isExpired(model, now) &&
      (model.outputModalities === null || model.outputModalities.includes("text")),
  );
  const family = (model: ModelInfo): number => (current && model.author === current.author ? 0 : 1);
  const price = (model: ModelInfo): number => priceOf(model) ?? Number.POSITIVE_INFINITY;
  candidates.sort((a, b) => family(a) - family(b) || price(a) - price(b) || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

export type ImageRejection = "type" | "size" | "count" | "read";

export type ImageReadResult = { ok: true; image: ChatImage } | { ok: false; reason: ImageRejection; name: string | null };

function isImageMediaType(type: string): type is ImageMediaType {
  return (CHAT_IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

/** Base64 characters of `bytes` raw bytes (the contract limit is on the encoded size). */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("unexpected result")));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** Reads one pasted or dropped file into a `ChatImage`, checking type and size before reading it. */
export async function readImageFile(file: File): Promise<ImageReadResult> {
  const name = file.name ? file.name.slice(0, 200) : null;
  if (!isImageMediaType(file.type)) return { ok: false, reason: "type", name };
  if (base64Length(file.size) > CHAT_IMAGE_LIMITS.maxBase64Chars) return { ok: false, reason: "size", name };
  try {
    const url = await readDataUrl(file);
    const comma = url.indexOf(",");
    const dataBase64 = comma === -1 ? "" : url.slice(comma + 1);
    if (dataBase64.length < 4 || dataBase64.length > CHAT_IMAGE_LIMITS.maxBase64Chars) return { ok: false, reason: "size", name };
    return { ok: true, image: { mediaType: file.type, dataBase64, name } };
  } catch {
    return { ok: false, reason: "read", name };
  }
}

/** Image files of a paste or drop (other items, such as text, are left to the text field). */
export function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files].filter((file) => file.type.startsWith("image/"));
}

/** `data:` URL of an image for its thumbnail (allowed by the CSP `img-src 'self' data:`). */
export function imageDataUrl(image: ChatImage): string {
  return `data:${image.mediaType};base64,${image.dataBase64}`;
}
