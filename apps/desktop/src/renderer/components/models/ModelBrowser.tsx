import { useEffect, useId, useMemo, useState } from "react";
import { Badge, Button, Callout, IconButton, Skeleton, TextField, type BadgeTone } from "@nova/ui";
import type { ModelInfo } from "@nova/shared";
import { fr } from "../../copy/fr";
import { describeProviderError, describeUiError } from "../../lib/errors";
import { formatContextLength, formatDate, formatModelPricing, formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useApp } from "../../state/context";
import { RefreshIcon } from "../icons";
import { DEFAULT_FILTERS, filterModels, QUICK_AUTHOR, type ModelFilters } from "./filter";

function Capability({ label, value }: { label: string; value: boolean | null }) {
  const tone: BadgeTone = value === true ? "jade" : value === null ? "amber" : "neutral";
  const text = value === true ? fr.models.capYes : value === false ? fr.models.capNo : fr.models.capUnknown;
  return (
    <Badge tone={tone} title={value === null ? fr.models.capUnknownTitle : undefined}>
      {label} · {text}
    </Badge>
  );
}

function ModelRow({ model, selected, onSelect }: { model: ModelInfo; selected: boolean; onSelect: () => void }) {
  const price = formatModelPricing(model.pricing);
  const context = formatContextLength(model.contextLength);
  return (
    <li>
      <button type="button" className="nova-model" aria-pressed={selected} onClick={onSelect}>
        <span className="nova-model__head">
          <span className="nova-model__name">{model.name}</span>
          {selected ? <Badge tone="jade">{fr.models.selected}</Badge> : null}
        </span>
        <span className="nova-model__meta">
          <code>{model.id}</code>
          <span>{model.author}</span>
          <span>{context ? fr.models.context(context) : fr.models.contextUnknown}</span>
        </span>
        <span className="nova-model__price">
          {fr.models.priceIn} {price.input} · {fr.models.priceOut} {price.output} · {fr.models.perMillion}
        </span>
        <span className="nova-model__caps">
          <Capability label={fr.models.capTools} value={model.supportsTools} />
          <Capability label={fr.models.capStructured} value={model.supportsStructuredOutputs} />
          <Capability label={fr.models.capReasoning} value={model.supportsReasoning} />
          {model.expirationDate ? <Badge tone="amber">{fr.models.expires(formatDate(model.expirationDate))}</Badge> : null}
        </span>
      </button>
    </li>
  );
}

export interface ModelBrowserProps {
  selectedId: string | null;
  onSelect: (model: ModelInfo) => void;
  /** Pre-applied author filter (the quick filter is suggested until a first model is chosen). */
  preferQuickAuthor?: boolean;
}

export function ModelBrowser({ selectedId, onSelect, preferQuickAuthor = false }: ModelBrowserProps) {
  const catalog = useApp((state) => state.catalog);
  const loadCatalog = useApp((state) => state.loadCatalog);
  const now = useNow(30_000);
  const countId = useId();
  const [filters, setFilters] = useState<ModelFilters>(() => ({
    ...DEFAULT_FILTERS,
    author: preferQuickAuthor ? QUICK_AUTHOR : null,
  }));

  useEffect(() => {
    if (catalog.status === "idle") void loadCatalog(false);
  }, [catalog.status, loadCatalog]);

  const models = catalog.data?.models;
  const visible = useMemo(() => filterModels(models ?? [], filters), [models, filters]);
  const toggle = (key: "text" | "tools" | "free") => setFilters((current) => ({ ...current, [key]: !current[key] }));
  const filtered = filters.query !== "" || filters.tools || filters.free || filters.author !== null || !filters.text;

  return (
    <div className="nova-models">
      <div className="nova-models__toolbar">
        <TextField
          label={fr.models.searchLabel}
          hideLabel
          type="search"
          placeholder={fr.models.searchPlaceholder}
          value={filters.query}
          onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
          aria-describedby={countId}
          className="nova-models__search"
        />
        <IconButton
          aria-label={fr.models.refresh}
          icon={<RefreshIcon />}
          variant="secondary"
          disabled={catalog.status === "loading"}
          onClick={() => void loadCatalog(true)}
        />
      </div>
      <fieldset className="nova-models__filters">
        <legend className="nv-visually-hidden">{fr.models.filtersLabel}</legend>
        <button type="button" className="nova-chip" aria-pressed={filters.text} onClick={() => toggle("text")}>
          {fr.models.filterText}
        </button>
        <button type="button" className="nova-chip" aria-pressed={filters.tools} onClick={() => toggle("tools")}>
          {fr.models.filterTools}
        </button>
        <button type="button" className="nova-chip" aria-pressed={filters.free} onClick={() => toggle("free")}>
          {fr.models.filterFree}
        </button>
        <button
          type="button"
          className="nova-chip"
          aria-pressed={filters.author === QUICK_AUTHOR}
          onClick={() =>
            setFilters((current) => ({ ...current, author: current.author === QUICK_AUTHOR ? null : QUICK_AUTHOR }))
          }
        >
          {fr.models.filterDeepSeek}
        </button>
      </fieldset>

      <p className="nova-models__status">
        <span id={countId} aria-live="polite">
          {models ? fr.models.count(visible.length, models.length) : null}
        </span>
        {catalog.data ? (
          <span>
            {catalog.data.source === "cache"
              ? fr.models.cacheNotice(formatRelative(catalog.data.fetchedAt, now))
              : fr.models.freshness(formatRelative(catalog.data.fetchedAt, now))}
          </span>
        ) : null}
      </p>

      {catalog.data?.refreshError ? (
        <Callout tone="warning" title={fr.models.refreshFailed}>
          {describeProviderError(catalog.data.refreshError).title}
        </Callout>
      ) : null}
      {catalog.status === "error" && catalog.error ? (
        <Callout
          tone={models ? "warning" : "danger"}
          title={models ? fr.models.refreshFailed : fr.models.loadFailed}
          action={
            <Button size="sm" variant="secondary" onClick={() => void loadCatalog(true)}>
              {fr.app.retry}
            </Button>
          }
        >
          {describeUiError(catalog.error).title}
        </Callout>
      ) : null}

      {!models && catalog.status !== "error" ? (
        <div className="nova-models__loading" aria-busy="true">
          <p className="nv-visually-hidden">{fr.models.loading}</p>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} height={72} radius={12} />
          ))}
        </div>
      ) : null}

      {models && visible.length === 0 ? (
        <div className="nova-models__empty">
          <p className="nova-models__empty-title">{fr.models.empty}</p>
          <p>{fr.models.emptyBody}</p>
          {filtered ? (
            <button type="button" className="nova-chip" onClick={() => setFilters(DEFAULT_FILTERS)}>
              {fr.models.clearFilters}
            </button>
          ) : null}
        </div>
      ) : null}

      {models && visible.length > 0 ? (
        <ul className="nova-models__list">
          {visible.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              selected={model.id === selectedId}
              onSelect={() => onSelect(model)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
