// Images pasted in Discuter (J2-B L7): kept in memory for the draft of one conversation, sent with
// the next message only, then dropped. When the current model cannot read images (catalog), the
// send is blocked with the reason and, when the setting allows, a vision model of the catalog is
// proposed (one click switches this conversation to it; nothing changes without that click).
import { useCallback, useState } from "react";
import { CHAT_IMAGE_LIMITS, type ChatImage, type ModelInfo } from "@nova/shared";
import { IMAGE_REJECTIONS, desktopCopy } from "../../../copy/fr-desktop";
import { acceptsImages, pickVisionModel, readImageFile } from "../../../lib/vision";
import { useApp } from "../../../state/context";
import type { ComposerBlock } from "../Composer";
import { findModel } from "../../models/filter";

export interface VisionSuggestion {
  model: ModelInfo;
  choose: () => Promise<void>;
}

export interface PastedImage {
  /** Local identity of the thumbnail (images carry no id). */
  id: number;
  image: ChatImage;
}

export interface ImageAttachments {
  items: PastedImage[];
  /** What goes with the message. */
  images: ChatImage[];
  /** Why the last pasted file was refused (type, size, count, unreadable); null otherwise. */
  notice: string | null;
  add: (files: File[]) => Promise<void>;
  remove: (id: number) => void;
  clear: () => void;
  /** The current model cannot read the images: the send waits (reason + fix). */
  block: ComposerBlock | null;
  /** A catalog model that reads images, proposed when the current one cannot. */
  suggestion: VisionSuggestion | null;
}

interface Draft {
  key: string;
  items: PastedImage[];
  notice: string | null;
}

let nextImageId = 1;

/** `conversationKey` scopes the images: switching conversation drops them (never sent elsewhere). */
export function useImageAttachments(conversationKey: string | null, modelId: string | null): ImageAttachments {
  const key = conversationKey ?? "new";
  const models = useApp((state) => state.catalog.data?.models);
  const suggestEnabled = useApp((state) => state.settings?.chat.suggestVisionModel ?? true);
  const chooseModel = useApp((state) => state.chooseModel);
  const openModelPicker = useApp((state) => state.openModelPicker);
  const [draft, setDraft] = useState<Draft>({ key, items: [], notice: null });
  const current: Draft = draft.key === key ? draft : { key, items: [], notice: null };

  const add = useCallback(
    async (files: File[]) => {
      const read = await Promise.all(files.map((file) => readImageFile(file)));
      setDraft((previous) => {
        const items = previous.key === key ? [...previous.items] : [];
        let notice: string | null = null;
        for (const result of read) {
          if (!result.ok) notice = IMAGE_REJECTIONS[result.reason](result.name);
          else if (items.length >= CHAT_IMAGE_LIMITS.maxImages) notice = IMAGE_REJECTIONS.count(result.image.name);
          else items.push({ id: nextImageId++, image: result.image });
        }
        return { key, items, notice };
      });
    },
    [key],
  );
  const remove = useCallback(
    (id: number) =>
      setDraft((previous) => (previous.key === key ? { key, items: previous.items.filter((item) => item.id !== id), notice: null } : previous)),
    [key],
  );
  const clear = useCallback(() => setDraft({ key, items: [], notice: null }), [key]);

  const model = findModel(models, modelId);
  const blocked = current.items.length > 0 && modelId !== null && !acceptsImages(model);
  const candidate = blocked && suggestEnabled ? pickVisionModel(models ?? [], model) : null;
  const copy = desktopCopy.vision;
  let block: ComposerBlock | null = null;
  if (blocked) {
    const reason = model?.inputModalities ? copy.cannotRead(model.name) : copy.unknownModel;
    // No candidate while suggestions are on means the catalog has none: say it, offer to remove them.
    const none = suggestEnabled && !candidate;
    block = none
      ? { reason: `${reason} ${copy.noVisionModel}`, action: { label: copy.removeAll, onAction: clear } }
      : { reason, action: { label: copy.chooseModel, onAction: () => openModelPicker("conversation") } };
  }
  return {
    items: current.items,
    images: current.items.map((item) => item.image),
    notice: current.notice,
    add,
    remove,
    clear,
    block,
    suggestion: candidate ? { model: candidate, choose: () => chooseModel(candidate.id, "conversation") } : null,
  };
}
