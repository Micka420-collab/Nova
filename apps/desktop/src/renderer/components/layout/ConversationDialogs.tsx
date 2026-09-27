import { useState, type FormEvent } from "react";
import { Button, Dialog, TextField, useToast } from "@nova/ui";
import type { ConversationSummary } from "@nova/shared";
import { fr } from "../../copy/fr";
import { errorToast } from "../../lib/errors";
import { useApp } from "../../state/context";

export function RenameDialog({ conversation, onClose }: { conversation: ConversationSummary; onClose: () => void }) {
  const rename = useApp((state) => state.rename);
  const toast = useToast();
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const formId = `rename-${conversation.id}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = title.trim();
    if (!next) return;
    setBusy(true);
    try {
      await rename(conversation.id, next);
      toast.show({ title: fr.conversation.renamed, tone: "success" });
      onClose();
    } catch (error) {
      toast.show(errorToast(error, fr.conversation.renameTitle));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={fr.conversation.renameTitle}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {fr.app.cancel}
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} disabled={!title.trim()}>
            {fr.app.save}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)}>
        <TextField
          label={fr.conversation.renameLabel}
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
        />
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  /** Resolves when done; the dialog closes itself on success. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      // The caller reports the failure; the dialog stays open so the user can retry or cancel.
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {fr.app.cancel}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

export function DeleteDialog({ conversation, onClose }: { conversation: ConversationSummary; onClose: () => void }) {
  const remove = useApp((state) => state.remove);
  const toast = useToast();
  return (
    <ConfirmDialog
      title={fr.conversation.deleteTitle(conversation.title)}
      description={fr.conversation.deleteDescription}
      confirmLabel={fr.conversation.deleteConfirm}
      onClose={onClose}
      onConfirm={async () => {
        try {
          await remove(conversation.id);
          toast.show({ title: fr.conversation.deleted, tone: "success" });
        } catch (error) {
          toast.show(errorToast(error, fr.nav.remove));
          throw error;
        }
      }}
    />
  );
}
