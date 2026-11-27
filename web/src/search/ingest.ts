import type { PrewarmReport } from "../prewarm.ts";
import { indexingOf } from "./bindings.ts";
import { pageDocument } from "./document.ts";
import type { IndexReport, Page } from "./indexer.ts";
import { pageKey } from "./route.ts";

/**
 * Indexing the site's pages after each prewarm (prewarm.ts: the sync after
 * a run that writes, and every prod deploy), which reads every page the
 * sitemap lists anyway. Each page that answered becomes Markdown
 * (document.ts), and the search's Durable Object indexes them
 * (indexer.ts), counting what it sends. worker.ts hands each page to
 * {@link indexerOf} as the prewarm reads it, purges the edge, and only
 * then finishes the indexer, so visitors never wait on indexing.
 *
 * Only prod has the index (bindings.ts). Every other stage prewarms as it
 * did, and this module loads only when a prewarm runs.
 */

/** The longest item key the Items API takes. */
export const keyLimit = 128;

/**
 * `plan`, the prewarm's dry run (cache.ts's `prewarmPlan`), with what
 * indexing would then do. It lives here rather than in cache.ts, which
 * every cold start parses, so a dry run loads it with this module.
 */
export const withIndexPlan = <Plan extends object>(plan: Plan) => ({
  ...plan,
  thenIndex:
    "on prod, after the purge: each page that came back, made into Markdown, whose Markdown changed since it was indexed, uploaded in key order while the search's window has room (4,000,000 bytes in any 32 UTC days, counted before each is sent); nothing removed",
});

/** A prewarm's report, with what indexing did where the Worker indexes. */
export type IndexedPrewarm<Report> = Report & {
  readonly search?:
    | (IndexReport & { readonly skipped: ReadonlyArray<string> })
    | { readonly error: string };
};

/** What the prewarm indexes with: each page it reads, then its report. */
export interface Indexer {
  /** Hands over each listed page as it comes back (prewarm.ts's `onPage`). */
  readonly onPage: (path: string, html: string | undefined) => void;
  /**
   * `report` with what indexing the pages handed over did. Indexing never
   * fails the prewarm: what went wrong is in the report's `search`.
   */
  readonly finish: <Report extends PrewarmReport>(
    report: Report,
  ) => Promise<IndexedPrewarm<Report>>;
}

/**
 * The prewarm's indexer, where the Worker has the index. A page that came
 * back is made into a document; one that didn't, or has no `<main>`, isn't
 * sent. A page whose key would pass the Items API's 128 characters is left
 * out (`skipped`), so it can't fail the others. The documents go to the
 * object sorted by key, the order its window lets them through in, so a
 * run takes the same pages whatever order they came back in.
 */
export function indexerOf(
  env: Readonly<Record<string, unknown>>,
  // Tests make documents their own way; the Worker makes them as document.ts does.
  make: typeof pageDocument = pageDocument,
): Indexer | undefined {
  const indexing = indexingOf(env);
  if (indexing === undefined) return undefined;
  const origin = typeof env["ORIGIN"] === "string" ? env["ORIGIN"] : "";
  const pages = new Map<string, string>();
  return {
    onPage: (path, html) => {
      if (path === "/sitemap.xml") return;
      if (html === undefined) pages.delete(path);
      else pages.set(path, html);
    },
    finish: async (report) => {
      try {
        const documents: Array<Page> = [];
        const skipped: Array<string> = [];
        for (const [path, html] of pages) {
          const key = pageKey(path);
          if (key.length > keyLimit) {
            skipped.push(path);
            continue;
          }
          const markdown = await make(html, `${origin}${path}`);
          if (markdown !== undefined) documents.push({ key, markdown });
        }
        documents.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return {
          ...report,
          search: { ...(await indexing.index(documents)), skipped },
        };
      } catch (error) {
        return {
          ...report,
          search: {
            error: error instanceof Error ? error.message : "indexing failed",
          },
        };
      }
    },
  };
}
