import { indexPath, itemsOf } from "./bindings.ts";
import { answer, type BudgetState } from "./budget.ts";
import { documentLimit } from "./document.ts";
import {
  INGEST_BYTES_IN_WINDOW,
  type IndexReport,
  indexSite,
  type Page,
} from "./indexer.ts";

/**
 * The search's Durable Object (worker.ts's `SearchBudget`): its answer to
 * each request. `POST /take` takes a search from the budget (budget.ts);
 * `POST /index` indexes the site's pages (indexer.ts) and answers what it
 * did. The class loads this module on its first request, so a cold start
 * parses none of it.
 */

/**
 * The object's one lock: whether a run is indexing now, and the latest
 * pages handed over meanwhile, which the running one indexes once it's done.
 */
export interface Lock {
  running: boolean;
  next?: ReadonlyArray<Page> | undefined;
}

/** The most pages one run takes: far past the site's. */
export const pagesLimit = 2_000;

/** The longest item key the Items API takes. */
export const keyLimit = 128;

const isPage = (value: unknown): value is Page =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Page).key === "string" &&
  (value as Page).key !== "" &&
  (value as Page).key.length <= keyLimit &&
  typeof (value as Page).markdown === "string" &&
  new TextEncoder().encode((value as Page).markdown).byteLength <=
    documentLimit;

/** What a run that found another indexing did: nothing yet; that run does it next. */
const busy: IndexReport = {
  uploaded: 0,
  unchanged: 0,
  refused: 0,
  reset: 0,
  failed: [],
  used: 0,
  limit: INGEST_BYTES_IN_WINDOW,
  busy: true,
};

/**
 * The object's answer to `request`, with `env`'s bindings and its `lock`.
 * One run indexes at a time: the lock lives in the object, the one place
 * every run goes through. It lives in memory, so an object the runtime
 * restarts starts unlocked, and the run it was doing is gone with it
 * (indexer.ts picks up what it left pending).
 */
export async function objectAnswer(
  state: BudgetState,
  env: Readonly<Record<string, unknown>>,
  request: Request,
  lock: Lock,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || pathname !== indexPath) {
    return answer(state, request);
  }
  const body: unknown = await request.json().catch(() => undefined);
  const pages =
    typeof body === "object" && body !== null
      ? (body as { pages?: unknown }).pages
      : undefined;
  if (
    !Array.isArray(pages) ||
    pages.length > pagesLimit ||
    !pages.every(isPage)
  ) {
    return Response.json(
      { error: "an index takes { pages: [{ key, markdown }] }" },
      { status: 400 },
    );
  }
  const items = itemsOf(env);
  if (items === undefined) {
    return Response.json({ error: "no index is bound" }, { status: 503 });
  }
  // Checked and taken with nothing awaited between, so two runs can't both
  // find it free. Pages handed over while it's held are kept, the latest in
  // place of any earlier, and the run holding it indexes them next, so the
  // newest are never dropped (and the pages of every run between them are
  // the older versions of the same).
  if (lock.running) {
    lock.next = pages;
    return Response.json(busy);
  }
  lock.running = true;
  try {
    let report = await indexSite(state, items, pages);
    for (let next = lock.next; next !== undefined; next = lock.next) {
      lock.next = undefined;
      report = await indexSite(state, items, next);
    }
    return Response.json(report);
  } finally {
    lock.running = false;
    lock.next = undefined;
  }
}
