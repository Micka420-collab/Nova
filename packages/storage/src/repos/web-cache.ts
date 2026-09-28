// Web page cache (W2), table `web_cache` (migration v4), and the web-search usage writer (W1).
// `url_hash` keys the REQUESTED URL; `url` holds the final URL after redirects. Markdown is the
// already-capped, untrusted page text (never workspace content, never secrets).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { UsageSummary } from "@nova/shared";
import { readNumber, readText, readTextOrNull, type Row } from "../sqlite";

export interface WebCacheRecord {
  urlHash: string;
  url: string;
  title: string | null;
  markdown: string;
  contentHash: string;
  fetchedAt: number;
  expiresAt: number;
}

export interface WebCacheRepo {
  /** Entry for the key when not expired at `at`, else null. */
  get(urlHash: string, at: number): WebCacheRecord | null;
  /** Inserts or replaces the entry of the key. */
  put(entry: WebCacheRecord): void;
  /** Deletes entries expired at `at`; returns how many. */
  purgeExpired(at: number): number;
}

function toEntry(row: Row): WebCacheRecord {
  return {
    urlHash: readText(row, "url_hash"),
    url: readText(row, "url"),
    title: readTextOrNull(row, "title"),
    markdown: readText(row, "markdown"),
    contentHash: readText(row, "content_hash"),
    fetchedAt: readNumber(row, "fetched_at"),
    expiresAt: readNumber(row, "expires_at"),
  };
}

export function createWebCacheRepo(db: DatabaseSync): WebCacheRepo {
  return {
    get(urlHash, at) {
      const row = db.prepare("SELECT * FROM web_cache WHERE url_hash = ? AND expires_at > ?").get(urlHash, at);
      return row ? toEntry(row) : null;
    },
    put(entry) {
      db.prepare(
        `INSERT INTO web_cache (url_hash, url, title, markdown, content_hash, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url_hash) DO UPDATE SET url = excluded.url, title = excluded.title,
           markdown = excluded.markdown, content_hash = excluded.content_hash,
           fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      ).run(entry.urlHash, entry.url, entry.title, entry.markdown, entry.contentHash, entry.fetchedAt, entry.expiresAt);
    },
    purgeExpired(at) {
      return Number(db.prepare("DELETE FROM web_cache WHERE expires_at <= ?").run(at).changes);
    },
  };
}

export interface WebSearchUsageInput {
  providerId: string;
  modelId: string;
  servedModel: string | null;
  servedProvider: string | null;
  /** null = unknown usage (the call may still have been billed: cost stays null, never 0). */
  usage: UsageSummary | null;
  conversationId: string | null;
  messageId: string | null;
  missionId: string | null;
  toolCallId: string | null;
}

export interface WebSearchUsageRepo {
  /** Records one `usage_records` row with kind `web_search`. */
  record(input: WebSearchUsageInput): void;
}

export function createWebSearchUsageRepo(db: DatabaseSync, now: () => number = Date.now): WebSearchUsageRepo {
  return {
    record(input) {
      const usage = input.usage;
      db.prepare(
        `INSERT INTO usage_records
           (id, conversation_id, message_id, mission_id, tool_call_id, kind, provider_id, model_id,
            served_model, served_provider, prompt_tokens, completion_tokens, reasoning_tokens,
            cached_tokens, cost, created_at)
         VALUES (?, ?, ?, ?, ?, 'web_search', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.conversationId,
        input.messageId,
        input.missionId,
        input.toolCallId,
        input.providerId,
        input.modelId,
        input.servedModel,
        input.servedProvider,
        usage?.promptTokens ?? null,
        usage?.completionTokens ?? null,
        usage?.reasoningTokens ?? null,
        usage?.cachedTokens ?? null,
        usage?.cost ?? null,
        now(),
      );
    },
  };
}
