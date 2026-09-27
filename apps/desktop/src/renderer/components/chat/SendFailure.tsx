import { Button, Callout } from "@nova/ui";
import { fr } from "../../copy/fr";
import { describeUiError, type UiError } from "../../lib/errors";
import { useApp } from "../../state/context";

/** Why the draft did not leave, with the step that fixes it when there is one (key missing or unreadable). */
export function SendFailure({ error }: { error: UiError }) {
  const openSettings = useApp((state) => state.openSettings);
  const copy = describeUiError(error);
  // Provider failures are shown on the answer; here only IPC failures carry a settings action.
  const action = error.providerError ? null : copy.action;
  return (
    <Callout
      tone="danger"
      title={fr.composer.sendFailed}
      action={
        action ? (
          <Button size="sm" variant="secondary" onClick={() => openSettings("providers")}>
            {action}
          </Button>
        ) : undefined
      }
    >
      <p>{copy.detail ? `${copy.title}. ${copy.detail}` : copy.title}</p>
    </Callout>
  );
}
