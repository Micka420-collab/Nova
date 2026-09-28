// P10: a file dropped on Nomi. Only metadata (name, size, type) is read on drop; the content is
// read when the user clicks « Joindre », and even then it only goes into the draft — nothing is
// sent before the user sends the message.
import { NOMI_COPY, dropIntents, formatSize, type ActionOutcome, type DropIntent, type DroppedItem } from "@nova/companion";
import { useState, type DragEvent } from "react";
import type { NomiBubbleDrop } from "./NomiBubble";

export interface NomiDropHandlers {
  /** Model of the next message reads images (catalog `inputModalities`); null = unknown. */
  imageInput: boolean | null;
  attachText(name: string, text: string): void;
  chooseModel(): void;
  openWorkspace(): void;
  showOutcome(outcome: ActionOutcome): void;
}

interface Dropped {
  file: File;
  item: DroppedItem;
  intents: DropIntent[];
}

function hasFiles(event: DragEvent): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

/** Fence that cannot be closed by the file's own content. */
function fenced(name: string, text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${name}\n${fence}\n${text}\n${fence}`;
}

export function useNomiDrop(handlers: NomiDropHandlers | null) {
  const [dragOver, setDragOver] = useState(false);
  const [dropped, setDropped] = useState<Dropped | null>(null);

  const targetProps = handlers
    ? {
        onDragEnter(event: DragEvent) {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragOver(true);
        },
        onDragOver(event: DragEvent) {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave(event: DragEvent) {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragOver(false);
        },
        onDrop(event: DragEvent) {
          event.preventDefault();
          setDragOver(false);
          const file = event.dataTransfer.files[0];
          if (!file) return;
          const entry = event.dataTransfer.items[0]?.webkitGetAsEntry?.() ?? null;
          const item: DroppedItem = { name: file.name, size: file.size, mimeType: file.type, isDirectory: entry?.isDirectory === true };
          setDropped({ file, item, intents: dropIntents(item, { imageInput: handlers.imageInput }) });
        },
      }
    : {};

  async function onIntent(intent: DropIntent): Promise<void> {
    if (!handlers || !dropped) return;
    const { file } = dropped;
    setDropped(null);
    if (intent.kind === "attach_text") {
      try {
        handlers.attachText(file.name, fenced(file.name, await file.text()));
        handlers.showOutcome({ ok: true, message: NOMI_COPY.outcome.attached(file.name), navigate: null });
      } catch {
        handlers.showOutcome({ ok: false, reason: "failed", message: NOMI_COPY.outcome.failed(NOMI_COPY.outcome.unknownError) });
      }
    } else if (intent.kind === "choose_model") {
      handlers.chooseModel();
    } else if (intent.kind === "open_workspace") {
      handlers.openWorkspace();
    }
  }

  const drop: NomiBubbleDrop | null = dropped
    ? {
        name: dropped.item.name,
        size: dropped.item.isDirectory ? "" : formatSize(dropped.item.size),
        intents: dropped.intents,
        onIntent: (intent) => void onIntent(intent),
        onCancel: () => setDropped(null),
      }
    : null;

  return { dragOver, drop, targetProps };
}
