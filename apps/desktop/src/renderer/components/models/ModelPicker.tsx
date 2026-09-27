import { Dialog, useToast } from "@nova/ui";
import type { ModelInfo } from "@nova/shared";
import { fr } from "../../copy/fr";
import { errorToast } from "../../lib/errors";
import { useApp } from "../../state/context";
import { selectedModelId } from "../../state/store";
import { ModelBrowser } from "./ModelBrowser";

/** App-level model picker: target is the shown conversation, the next new one, or the default. */
export function ModelPicker() {
  const picker = useApp((state) => state.ui.modelPicker);
  const setUi = useApp((state) => state.setUi);
  const chooseModel = useApp((state) => state.chooseModel);
  const current = useApp((state) =>
    picker.target === "default"
      ? (state.settings?.defaultModelId ?? null)
      : selectedModelId(state, picker.target === "conversation" ? state.activeId : null),
  );
  const neverChosen = useApp((state) => state.settings !== null && state.settings.defaultModelId === null);
  const toast = useToast();

  const close = () => setUi({ modelPicker: { ...picker, open: false } });

  async function select(model: ModelInfo) {
    close();
    try {
      await chooseModel(model.id, picker.target);
    } catch (error) {
      toast.show(errorToast(error, fr.settings.saveFailed));
    }
  }

  return (
    <Dialog open={picker.open} onClose={close} title={fr.models.pickerTitle} description={fr.models.pickerDescription} size="lg">
      {picker.open ? (
        <ModelBrowser selectedId={current} onSelect={(model) => void select(model)} preferQuickAuthor={neverChosen && !current} />
      ) : null}
    </Dialog>
  );
}
