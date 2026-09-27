import { fr } from "../../copy/fr";
import { useOnline } from "../../lib/hooks";
import { useApp } from "../../state/context";
import type { ModelTarget } from "../../state/store";
import type { ComposerBlock } from "./Composer";

/** Why a message cannot be sent right now, with the step that fixes it. Null when sending is possible. */
export function useSendGuard(modelId: string | null, target: ModelTarget): ComposerBlock | null {
  const online = useOnline();
  const connectionState = useApp((state) => state.connection?.state ?? null);
  const openSettings = useApp((state) => state.openSettings);
  const openModelPicker = useApp((state) => state.openModelPicker);
  if (connectionState === null || connectionState === "absent") {
    return { reason: fr.composer.noKey, action: { label: fr.composer.addKey, onAction: () => openSettings("providers") } };
  }
  if (connectionState === "invalid") {
    return {
      reason: fr.composer.invalidKey,
      action: { label: fr.providers.replace, onAction: () => openSettings("providers") },
    };
  }
  if (!modelId) {
    return {
      reason: fr.composer.noModel,
      action: { label: fr.models.pickerTitle, onAction: () => openModelPicker(target) },
    };
  }
  if (!online) return { reason: fr.composer.offline };
  return null;
}
