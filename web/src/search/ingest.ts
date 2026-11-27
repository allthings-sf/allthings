import type { PrewarmReport } from "../prewarm.ts";
import { type Indexing, indexingOf } from "./bindings.ts";
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
  /** Another prewarm was indexing, so this one did nothing. */
  readonly busy?: true;
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
 * Indexes `documents` (each page's Markdown, by path) through `indexing`.
 * `complete` says the sitemap was read and every page it lists came back
 * as a document, so a page indexed before and missing now has left the
 * site.
 *
 * A changed page's upload takes the place of the item it was indexed as.
 * Cloudflare holds one item a key, so an upload it refuses may be its
 * refusal of a key it holds: then the old item is removed and the page
 * recorded as gone, and the next run, planned and counted again, uploads
 * it anew. Nothing is sent twice uncounted.
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
  const run = crypto.randomUUID();
  const planned = await plan(
    run,
    pages.map(({ key, hash, bytes }) => ({ key, hash, bytes })),
    complete,
  );
  const byKey = new Map(pages.map((page) => [page.key, page]));
  const uploaded: Array<{ key: string; hash: string; id: string }> = [];
  const removed: Array<{ key: string; id: string }> = [];
  const failed: Array<string> = [];
  const previous = new Map(planned.previous.map(({ key, id }) => [key, id]));
  await each(planned.upload, async (key) => {
    const page = byKey.get(key);
    if (page === undefined) return;
    const before = previous.get(key);
    try {
      const { id } = await items.upload(key, page.markdown);
      uploaded.push({ key, hash: page.hash, id });
      // Replaced under a new id: the old one is let go (already gone is gone).
      if (before !== undefined && before !== id) {
        await items.delete(before).catch(() => undefined);
      }
    } catch {
      failed.push(key);
      if (before !== undefined) {
        await items.delete(before).then(
          () => removed.push({ key, id: before }),
          () => undefined,
        );
      }
    }
  });
  await each(planned.remove, async ({ key, id }) => {
    try {
      await items.delete(id);
      removed.push({ key, id });
    } catch {
      failed.push(key);
    }
  });
  if (planned.busy !== true) await record(run, uploaded, removed);
  return {
    uploaded: uploaded.length,
    unchanged: planned.unchanged,
    refused: planned.refused.length,
    removed: removed.length,
    failed,
    used: planned.used,
    limit: planned.limit,
    ...(planned.busy === true ? { busy: true as const } : {}),
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
  // Tests make documents their own way; the Worker makes them as document.ts does.
  make: typeof pageDocument = pageDocument,
): Promise<IndexedPrewarm<Report>> {
  const indexing = indexingOf(env);
  if (indexing === undefined) return warm(undefined);
  const origin = typeof env["ORIGIN"] === "string" ? env["ORIGIN"] : "";
  // Each page is made Markdown as it arrives, so no page's HTML is kept.
  // One that couldn't be made is missing for a reason that isn't the
  // site's, so the run removes nothing.
  const made = new Map<string, Promise<string | undefined>>();
  const unmade = { any: false };
  const report = await warm((path, html) => {
    if (path === "/sitemap.xml") return;
    made.set(
      path,
      make(html, `${origin}${path}`).catch(() => {
        unmade.any = true;
        return undefined;
      }),
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
    report.unreachable === 0 &&
    !unmade.any;
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
