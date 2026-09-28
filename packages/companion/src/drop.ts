// P10 "Déposer un fichier sur Nomi": the intents REALLY possible for a dropped item. Nothing is
// read or sent before the user clicks one; each attach intent states what leaves the machine.
import { NOMI_COPY } from "./copy";

export interface DroppedItem {
  name: string;
  size: number;
  /** Browser MIME type ("" when unknown). */
  mimeType: string;
  isDirectory: boolean;
}

export interface DropContext {
  /** Current model declares `image` in its input modalities; null = unknown (treated as no). */
  imageInput: boolean | null;
}

export type DropIntent =
  | { kind: "attach_text"; label: string; disclosure: string }
  | { kind: "choose_model"; label: string; reason: string }
  | { kind: "open_workspace"; label: string }
  | { kind: "refused"; reason: string };

/** Text goes into a chat message, whose content is capped at 100 000 characters (ipc.ts). */
export const DROP_TEXT_MAX_BYTES = 90_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonc", "yaml", "yml", "toml", "ini", "csv", "tsv", "xml", "html", "css", "scss",
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp",
  "hpp", "cs", "php", "sh", "bash", "zsh", "ps1", "sql", "vue", "svelte", "lua", "r", "log", "env.example",
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** "36 Ko", "1,2 Mo", "512 octets". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} octets`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}

export function isTextFile(item: DroppedItem): boolean {
  if (item.mimeType.startsWith("text/") || item.mimeType === "application/json") return true;
  return TEXT_EXTENSIONS.has(extension(item.name));
}

export function isImageFile(item: DroppedItem): boolean {
  return item.mimeType.startsWith("image/") || IMAGE_EXTENSIONS.has(extension(item.name));
}

export function dropIntents(item: DroppedItem, ctx: DropContext): DropIntent[] {
  const copy = NOMI_COPY.drop;
  if (item.isDirectory) return [{ kind: "open_workspace", label: copy.openWorkspace }];
  if (isImageFile(item)) {
    // chat.send carries text only: an image cannot be attached yet, whatever the model reads.
    if (ctx.imageInput !== true) return [{ kind: "choose_model", label: copy.chooseModel, reason: copy.imageUnsupported }];
    return [{ kind: "refused", reason: copy.imageNotYet }];
  }
  if (!isTextFile(item)) return [{ kind: "refused", reason: copy.unsupported }];
  if (item.size > DROP_TEXT_MAX_BYTES) return [{ kind: "refused", reason: copy.tooLarge(formatSize(DROP_TEXT_MAX_BYTES)) }];
  return [{ kind: "attach_text", label: copy.attach, disclosure: copy.attachDisclosure(formatSize(item.size)) }];
}
