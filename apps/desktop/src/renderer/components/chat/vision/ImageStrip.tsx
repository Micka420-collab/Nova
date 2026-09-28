// Thumbnails of the images pasted for the next message, the refusal of the last paste, and the
// vision model proposed when the current model cannot read them.
import { Button, IconButton } from "@nova/ui";
import { desktopCopy } from "../../../copy/fr-desktop";
import { formatPricePerMTok } from "../../../lib/format";
import { imageDataUrl } from "../../../lib/vision";
import { CloseIcon } from "../../icons";
import type { ImageAttachments } from "./useImageAttachments";
// oxlint-disable-next-line import/no-unassigned-import -- component styles (Vite injects them)
import "./vision.css";

export function ImageStrip({ attachments }: { attachments: ImageAttachments }) {
  const { images, notice, suggestion } = attachments;
  const copy = desktopCopy.vision;
  if (images.length === 0 && !notice) return null;
  return (
    <div className="nova-images">
      {images.length > 0 ? (
        <ul className="nova-images__list" aria-label={copy.stripLabel}>
          {attachments.items.map(({ id, image }) => {
            const name = image.name ?? copy.unnamed;
            return (
              <li key={id} className="nova-images__item">
                <img className="nova-images__thumb" src={imageDataUrl(image)} alt={name} />
                <IconButton size="sm" aria-label={copy.remove(name)} icon={<CloseIcon size={12} />} onClick={() => attachments.remove(id)} />
              </li>
            );
          })}
        </ul>
      ) : null}
      {notice ? (
        <output className="nova-images__notice">{notice}</output>
      ) : null}
      {images.length > 0 ? <p className="nova-images__note">{copy.notice}</p> : null}
      {suggestion ? (
        <p className="nova-images__suggestion">
          <Button size="sm" variant="secondary" onClick={() => void suggestion.choose()}>
            {copy.suggest(suggestion.model.name)}
          </Button>
          <span className="nova-images__note">
            {copy.suggestPrice(formatPricePerMTok(suggestion.model.pricing.promptPerMTok, suggestion.model.pricing.variable))}
          </span>
        </p>
      ) : null}
    </div>
  );
}
