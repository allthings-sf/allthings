import type { PrewarmReport } from "../prewarm.ts";
import { type Indexing, indexingOf, type Items } from "./bindings.ts";
import { pageDocument } from "./document.ts";
import { pageKey } from "./route.ts";

/**
 * Indexing the site's pages for search (route.ts), within what the object
 * lets it ingest (ledger.ts): each prewarm (prewarm.ts; the sync after
 * each run that writes, and a prod deploy) hands over every page the
 * sitemap lists, as HTML, and each becomes Markdown (document.ts). A page
 * whose Markdown is what was last indexed is left alone; one that changed
 * is uploaded to the index's built-in storage, which indexes it then and
 * never on its own, once the object has counted its bytes; one the object
 * has no room for waits for a later run. A page the sitemap no longer
 * lists is removed from the index, so it never answers with a page the
 * site took down.
 *
 * Only prod has the index (bindings.ts). Every other stage prewarms as it
 * did, and this module loads only when a prewarm runs.
 */

/** What indexing did, as the prewarm's answer says it. */
export interface IndexReport {
  /** Pages uploaded now. */
  readonly uploaded: number;
  /** Pages indexed as they are, so left alone. */
  readonly unchanged: number;
  /** Pages changed that the window has no room for yet. */
  readonly refused: number;
  /** Pages the sitemap no longer lists, removed. */
  readonly removed: number;
  /** Pages whose upload or removal failed, by key: tried again next time. */
  readonly failed: ReadonlyArray<string>;
  /** Bytes ingested in the window, this run's included, and its limit. */
  readonly used: number;
  readonly limit: number;
}

/** Uploads at once. */
export const concurrency = 4;

const sha256 = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** Runs `work` on each of `items`, {@link concurrency} at once. */
async function each<T>(
  items: ReadonlyArray<T>,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        if (item !== undefined) await work(item);
      }
    }),
  );
}

/**
 * Uploads `markdown` under `key`, in place of the item the key was indexed
 * as before (`previous`), if it was. Whether Cloudflare replaces a key's
 * item or keeps both, the page ends with one: an upload Cloudflare refuses
 * removes the old item and is tried once more, and one that comes back as
 * a new item removes the old one after it (already gone is gone).
 */
async function upload(
  items: Items,
  key: string,
  markdown: string,
  previous: string | undefined,
): Promise<string> {
  let id: string;
  try {
    id = (await items.upload(key, markdown)).id;
  } catch (error) {
    if (previous === undefined) throw error;
    await items.delete(previous);
    return (await items.upload(key, markdown)).id;
  }
  if (previous !== undefined && previous !== id) {
    await items.delete(previous).catch(() => undefined);
  }
  return id;
}

/**
 * Indexes `documents` (each page's Markdown, by path) through `indexing`.
 * `complete` says the sitemap was read and every page it lists came back,
 * so a page indexed before and missing now has left the site.
 */
export async function indexPages(
  documents: ReadonlyMap<string, string>,
  complete: boolean,
  { items, plan, record }: Indexing,
): Promise<IndexReport> {
  const pages = await Promise.all(
    [...documents].map(async ([path, markdown]) => ({
      key: pageKey(path),
      markdown,
      hash: await sha256(markdown),
      bytes: new TextEncoder().encode(markdown).byteLength,
    })),
  );
  const planned = await plan(
    pages.map(({ key, hash, bytes }) => ({ key, hash, bytes })),
    complete,
  );
  const byKey = new Map(pages.map((page) => [page.key, page]));
  const uploaded: Array<{ key: string; hash: string; id: string }> = [];
  const removed: Array<string> = [];
  const failed: Array<string> = [];
  const previous = new Map(planned.previous.map(({ key, id }) => [key, id]));
  await each(planned.upload, async (key) => {
    const page = byKey.get(key);
    if (page === undefined) return;
    try {
      const id = await upload(items, key, page.markdown, previous.get(key));
      uploaded.push({ key, hash: page.hash, id });
    } catch {
      failed.push(key);
    }
  });
  await each(planned.remove, async ({ key, id }) => {
    try {
      await items.delete(id);
      removed.push(key);
    } catch {
      failed.push(key);
    }
  });
  await record(uploaded, removed);
  return {
    uploaded: uploaded.length,
    unchanged: planned.unchanged,
    refused: planned.refused.length,
    removed: removed.length,
    failed,
    used: planned.used,
    limit: planned.limit,
  };
}

/** A prewarm's report, with what indexing did when the Worker indexes. */
export type IndexedPrewarm<Report> = Report & {
  readonly search?: IndexReport | { readonly error: string };
};

/**
 * `warm` (a prewarm, handed each page it reads), then the pages it read
 * indexed, where the Worker has the index. Indexing never fails the
 * prewarm: what went wrong is in the report's `search`.
 */
export async function withIndex<Report extends PrewarmReport>(
  env: Readonly<Record<string, unknown>>,
  warm: (
    onPage: ((path: string, html: string) => void) | undefined,
  ) => Promise<Report>,
): Promise<IndexedPrewarm<Report>> {
  const indexing = indexingOf(env);
  if (indexing === undefined) return warm(undefined);
  const origin = typeof env["ORIGIN"] === "string" ? env["ORIGIN"] : "";
  // Each page is made Markdown as it arrives, so no page's HTML is kept.
  const made = new Map<string, Promise<string | undefined>>();
  const report = await warm((path, html) => {
    if (path === "/sitemap.xml") return;
    made.set(
      path,
      pageDocument(html, `${origin}${path}`).catch(() => undefined),
    );
  });
  const documents = new Map<string, string>();
  for (const [path, document] of made) {
    const markdown = await document;
    if (markdown !== undefined) documents.set(path, markdown);
  }
  // A page that came back with no document (no <main>) isn't the site's
  // to search, so a complete run removes it too.
  const complete =
    report.sitemapRead &&
    report.failed.length === 0 &&
    report.unreachable === 0;
  try {
    return {
      ...report,
      search: await indexPages(documents, complete, indexing),
    };
  } catch (error) {
    return {
      ...report,
      search: {
        error: error instanceof Error ? error.message : "indexing failed",
      },
    };
  }
}
