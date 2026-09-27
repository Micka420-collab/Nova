// search.* in main (E4/E10): ripgrep text search and quick-open, both run in the fs-worker.
// `text` can also stream partial matches (`streamText`) for the project search panel.
import { randomUUID } from "node:crypto";
import type { SearchMatch, SearchQuery, SearchResult } from "@nova/shared";
import { FS_NOTIFY, type FsSearchMatchesNotify } from "../../workers/fs/protocol";
import type { AtelierApi } from "../api";
import type { WorkspaceService } from "./workspace-service";

export interface SearchService {
  api: AtelierApi["search"];
  /**
   * Same as `api.text` but calls `onMatches` with each batch while ripgrep runs; aborting the
   * signal cancels the search in the worker.
   */
  streamText(query: SearchQuery, onMatches: (matches: SearchMatch[]) => void, signal?: AbortSignal): Promise<SearchResult>;
}

export function createSearchService(deps: { workspaces: Pick<WorkspaceService, "fs"> }): SearchService {
  const { fs } = deps.workspaces;
  return {
    api: {
      text: (req) => fs.call("search.text", req),
      files: (req) => fs.call("search.files", req),
    },
    async streamText(query, onMatches, signal) {
      const streamId = randomUUID();
      const unsubscribe = fs.onNotify((event) => {
        if (event.method !== FS_NOTIFY.searchMatches) return;
        const payload = event.params as FsSearchMatchesNotify;
        if (payload.streamId === streamId) onMatches(payload.matches);
      });
      const cancel = (): void => void fs.call("search.cancel", { streamId }).catch(() => {});
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await fs.call("search.text", { ...query, streamId });
      } finally {
        signal?.removeEventListener("abort", cancel);
        unsubscribe();
      }
    },
  };
}
