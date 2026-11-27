import type { PrewarmReport } from "../prewarm.ts";
import { indexingOf } from "./bindings.ts";
import { pageDocument } from "./document.ts";
import type { IndexReport } from "./indexer.ts";
import { pageKey } from "./route.ts";

/**
 * Indexing the site's pages after each prewarm (prewarm.ts: the sync after
 * a run that writes, and every prod deploy), which reads every page the
 * sitemap lists anyway. Each page that answered becomes Markdown as it
 * arrives (document.ts), so no page's HTML is kept, and the search's
 * Durable Object indexes them (indexer.ts), counting what it sends.
 *
 * Only prod has the index (bindings.ts). Every other stage prewarms as it
 * did, and this module loads only when a prewarm runs.
 */

/** A prewarm's report, with what indexing did where the Worker indexes. */
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
  // A page that couldn't be made into a document is missing for a reason
  // that isn't the site's, so the run removes nothing.
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
  const pages: Array<{ key: string; markdown: string }> = [];
  for (const [path, document] of made) {
    const markdown = await document;
    if (markdown !== undefined) pages.push({ key: pageKey(path), markdown });
  }
  // A page with no document (no <main>) isn't the site's to search, so a
  // complete run removes it too.
  const complete =
    report.sitemapRead &&
    report.failed.length === 0 &&
    report.unreachable === 0 &&
    !unmade.any;
  try {
    return { ...report, search: await indexing.index(pages, complete) };
  } catch (error) {
    return {
      ...report,
      search: {
        error: error instanceof Error ? error.message : "indexing failed",
      },
    };
  }
}
