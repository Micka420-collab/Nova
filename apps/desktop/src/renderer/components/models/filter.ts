import type { ModelInfo } from "@nova/shared";

export interface ModelFilters {
  query: string;
  /** Text in and text out required; models whose modalities are unknown are kept. */
  text: boolean;
  tools: boolean;
  free: boolean;
  /** Author quick filter (lowercase id prefix), e.g. `deepseek`. */
  author: string | null;
}

export const DEFAULT_FILTERS: ModelFilters = { query: "", text: true, tools: false, free: false, author: null };

/** The author offered as a quick filter, pre-applied until a first model is chosen. */
export const QUICK_AUTHOR = "deepseek";

function supportsText(modalities: string[] | null): boolean {
  return modalities === null || modalities.includes("text");
}

export function filterModels(models: readonly ModelInfo[], filters: ModelFilters): ModelInfo[] {
  const query = filters.query.trim().toLowerCase();
  return models.filter((model) => {
    if (filters.text && !(supportsText(model.inputModalities) && supportsText(model.outputModalities))) return false;
    if (filters.tools && model.supportsTools !== true) return false;
    if (filters.free && !model.isFree) return false;
    if (filters.author && model.author.toLowerCase() !== filters.author) return false;
    if (!query) return true;
    return [model.name, model.id, model.author].some((value) => value.toLowerCase().includes(query));
  });
}

export function findModel(models: readonly ModelInfo[] | undefined, id: string | null): ModelInfo | null {
  if (!models || !id) return null;
  return models.find((model) => model.id === id) ?? null;
}
