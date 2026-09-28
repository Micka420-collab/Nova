// Where catalog models are listed but the catalog is not loaded yet (or failed to load): says so,
// with a retry, instead of presenting an unknown catalog as a known absence of models.
import { useEffect } from "react";
import { Button } from "@nova/ui";
import { fr } from "../../copy/fr";
import { useApp } from "../../state/context";

export function CatalogPending() {
  const status = useApp((state) => state.catalog.status);
  const loadCatalog = useApp((state) => state.loadCatalog);
  // Never asked yet in this session: ask now (the pickers do the same when they open).
  useEffect(() => {
    if (status === "idle") void loadCatalog(false);
  }, [status, loadCatalog]);
  if (status !== "error") {
    return <output className="nova-note">{fr.models.loading}</output>;
  }
  return (
    <output className="nova-note">
      {fr.models.loadFailed}.{" "}
      <Button size="sm" variant="secondary" onClick={() => void loadCatalog(false)}>
        {fr.models.retry}
      </Button>
    </output>
  );
}
