import { type PrewarmReport, sitemapPaths } from "../prewarm.ts";
import { type Indexing, indexingOf } from "./bindings.ts";
import { pageDocument } from "./document.ts";
import type { IndexPlan, IndexReport, Page, Run } from "./indexer.ts";
import { pageKey } from "./route.ts";

/**
 * Indexing the site's pages after each prewarm (prewarm.ts: the sync after
 * a run that writes, and every prod deploy), which reads every page the
 * sitemap lists anyway. Each page that answered becomes Markdown as it
 * arrives (document.ts), so no page's HTML is kept, and the search's
 * Durable Object indexes them (indexer.ts), counting what it sends. The
 * prewarm's dry run says what indexing would do, doing none of it
 * ({@link planWithIndex}).
 *
 * Only prod has the index (bindings.ts). Every other stage prewarms as it
 * did, and this module loads only when a prewarm runs.
 */

/** The longest item key the Items API takes. */
export const keyLimit = 128;

/** A prewarm's report, with what indexing did where the Worker indexes. */
export type IndexedPrewarm<Report> = Report & {
  readonly search?:
    | (IndexReport & { readonly skipped: ReadonlyArray<string> })
    | { readonly error: string };
};

/** Each listed page, as it came back: its HTML, or undefined if it didn't. */
type Pages = Map<string, string | undefined>;

/**
 * The run `pages` make: each page made into a document, by its key; every
 * key the sitemap lists; and which came back 2xx with no document. A page
 * whose key is longer than the Items API takes is left out, by path
 * (`skipped`), and so is kept out of every list, so it can't fail the run.
 * A page whose conversion threw makes the run incomplete, so it removes
 * nothing.
 */
async function runOf(
  pages: Pages,
  origin: string,
  sitemapRead: boolean,
  make: typeof pageDocument,
): Promise<{ readonly run: Run; readonly skipped: ReadonlyArray<string> }> {
  const documents: Array<Page> = [];
  const listed: Array<string> = [];
  const bare: Array<string> = [];
  const skipped: Array<string> = [];
  let unmade = false;
  for (const [path, html] of pages) {
    const key = pageKey(path);
    if (key.length > keyLimit) {
      skipped.push(path);
      continue;
    }
    listed.push(key);
    if (html === undefined) continue;
    const markdown = await make(html, `${origin}${path}`).catch(() => {
      unmade = true;
      return undefined;
    });
    if (markdown !== undefined) documents.push({ key, markdown });
    else if (!unmade) bare.push(key);
  }
  return {
    run: {
      pages: documents,
      listed,
      bare,
      complete: sitemapRead && !unmade,
    },
    skipped,
  };
}

const originOf = (env: Readonly<Record<string, unknown>>) =>
  typeof env["ORIGIN"] === "string" ? env["ORIGIN"] : "";

/**
 * `warm` (a prewarm, handed each page it reads), then the pages it read
 * indexed, where the Worker has the index. Indexing never fails the
 * prewarm: what went wrong is in the report's `search`.
 */
export async function withIndex<Report extends PrewarmReport>(
  env: Readonly<Record<string, unknown>>,
  warm: (
    onPage: ((path: string, html: string | undefined) => void) | undefined,
  ) => Promise<Report>,
  // Tests make documents their own way; the Worker makes them as document.ts does.
  make: typeof pageDocument = pageDocument,
): Promise<IndexedPrewarm<Report>> {
  const indexing = indexingOf(env);
  if (indexing === undefined) return warm(undefined);
  const pages: Pages = new Map();
  const report = await warm((path, html) => {
    if (path !== "/sitemap.xml") pages.set(path, html);
  });
  try {
    const { run, skipped } = await runOf(
      pages,
      originOf(env),
      report.sitemapRead,
      make,
    );
    return { ...report, search: { ...(await indexing.index(run)), skipped } };
  } catch (error) {
    return {
      ...report,
      search: {
        error: error instanceof Error ? error.message : "indexing failed",
      },
    };
  }
}

/** Pages asked for at once by a dry run. */
const concurrency = 4;

/**
 * The prewarm's dry run with what indexing would do (indexer.ts's
 * `planIndex`): `render` answers each page as the site would, without
 * keeping it (the app behind the page store), so the plan writes nothing.
 * `base` is the prewarm's own plan.
 */
export async function planWithIndex<Base extends object>(
  env: Readonly<Record<string, unknown>>,
  base: Base,
  render: (path: string) => Promise<Response>,
  make: typeof pageDocument = pageDocument,
): Promise<
  Base & { readonly search?: IndexPlan | { readonly error: string } }
> {
  const indexing: Indexing | undefined = indexingOf(env);
  if (indexing === undefined) return base;
  try {
    const sitemap = await render("/sitemap.xml");
    const sitemapRead = sitemap.ok;
    const paths = sitemapRead ? sitemapPaths(await sitemap.text()) : [];
    const pages: Pages = new Map(paths.map((path) => [path, undefined]));
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
        while (next < paths.length) {
          const path = paths[next];
          next += 1;
          if (path === undefined || path === "/sitemap.xml") continue;
          const response = await render(path).catch(() => undefined);
          pages.set(
            path,
            response?.ok === true ? await response.text() : undefined,
          );
        }
      }),
    );
    const { run } = await runOf(pages, originOf(env), sitemapRead, make);
    return { ...base, search: await indexing.plan(run) };
  } catch (error) {
    return {
      ...base,
      search: {
        error: error instanceof Error ? error.message : "planning failed",
      },
    };
  }
}
