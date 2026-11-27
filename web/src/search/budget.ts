/**
 * The search's budget (route.ts): AI Search bills past each month's
 * included 1,000 semantic queries (and 1,000 full-text ones), $0.75 per
 * 1,000 more from December 1, 2026, and no spending limit on the account
 * covers it (infra/README.md, "Search for agents"). So the site answers at
 * most {@link QUERIES_IN_WINDOW} searches in any {@link WINDOW_DAYS} UTC
 * days (today and the 31 before it),
 * and past that answers 503 without asking the index: the search goes
 * unavailable rather than billing.
 *
 * It is a window of days, not a calendar month, because the month
 * Cloudflare counts is the account's billing period, which needn't start
 * on the 1st. A period is at most 31 days long, so whatever part of it has
 * passed when a search comes lies within the window ending on that day:
 * no period can hold more searches than the window lets through.
 *
 * One Durable Object ({@link answer}) holds the count for the whole
 * site: every location's searches are counted in the same place, one at a
 * time, so two at once can't both take the last one. A search is counted
 * when it is taken, before the index is asked, so one that then fails
 * still counts: the count can only be above what Cloudflare bills.
 *
 * The object loads this module on its first request (worker.ts, object.ts),
 * and the route on its first search, so a cold start parses none of it.
 * What indexing may ingest is kept beside it (ledger.ts).
 */

/** The most searches answered in any {@link WINDOW_DAYS} days: under the 1,000 included. */
export const QUERIES_IN_WINDOW = 900;

/** The window's length, in UTC days, today included: a billing period of 31 days, and the day it started on. */
export const WINDOW_DAYS = 32;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Searches taken on each UTC day (`YYYY-MM-DD`). */
export type DayCounts = Readonly<Record<string, number>>;

/** The UTC day of `at`, as `YYYY-MM-DD`. */
export const utcDay = (at: number): string =>
  new Date(at).toISOString().slice(0, 10);

/** The first UTC day the window ending on `at`'s day holds. */
const firstDay = (at: number, days: number) => utcDay(at - (days - 1) * DAY_MS);

/** The searches `counts` holds in the window ending on `at`'s day. */
export function used(
  counts: DayCounts,
  at: number,
  days = WINDOW_DAYS,
): number {
  const first = firstDay(at, days);
  return Object.entries(counts)
    .filter(([day]) => day >= first)
    .reduce((sum, [, count]) => sum + count, 0);
}

/** What taking a search came to. */
export type Taken =
  | { readonly ok: true; readonly used: number; readonly limit: number }
  | {
      readonly ok: false;
      readonly used: number;
      readonly limit: number;
      /** Seconds until the window holds room for one more. */
      readonly retryAfter: number;
    };

/**
 * Takes one search at `at` from `counts`, if the window has room: what it
 * came to, and the counts to keep, without the days the window has left.
 */
export function take(
  counts: DayCounts,
  at: number,
  limit = QUERIES_IN_WINDOW,
  days = WINDOW_DAYS,
): { readonly taken: Taken; readonly counts: DayCounts } {
  const first = firstDay(at, days);
  const kept = Object.fromEntries(
    Object.entries(counts).filter(([day]) => day >= first),
  );
  const before = used(kept, at, days);
  if (before >= limit) {
    return {
      taken: {
        ok: false,
        used: before,
        limit,
        retryAfter: secondsUntilRoom(kept, at, limit, days),
      },
      counts: kept,
    };
  }
  const today = utcDay(at);
  return {
    taken: { ok: true, used: before + 1, limit },
    counts: { ...kept, [today]: (kept[today] ?? 0) + 1 },
  };
}

/**
 * Seconds from `at` until the first UTC midnight after which the window
 * holds fewer than `limit`: the days that leave it by then free their
 * searches. Nothing is taken meanwhile, since every search is refused.
 */
export function secondsUntilRoom(
  counts: DayCounts,
  at: number,
  limit = QUERIES_IN_WINDOW,
  days = WINDOW_DAYS,
): number {
  const midnight = Date.parse(`${utcDay(at)}T00:00:00Z`);
  for (let ahead = 1; ahead <= days; ahead++) {
    const then = midnight + ahead * DAY_MS;
    if (used(counts, then, days) < limit) {
      return Math.ceil((then - at) / 1000);
    }
  }
  return Math.ceil((midnight + days * DAY_MS - at) / 1000);
}

/** What the object uses of its Durable Object state. */
export interface BudgetState {
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
}

/** Where the Worker asks the object to take a search. */
export const takePath = "/take";

/** The storage key of the day counts. */
const countsKey = "queries";

/**
 * The site's one search budget, a Durable Object (infra/src/web.ts binds
 * it as `SEARCH_BUDGET` on prod): its answer to a search's request, as
 * object.ts routes it. `POST /take` takes a search and answers {@link Taken} as JSON,
 * 200 either way. Requests run one at a time, and nothing is awaited
 * between reading the counts and writing them but the storage itself,
 * which holds other requests back meanwhile, so each one sees the last
 * one's count.
 */
export async function answer(
  state: BudgetState,
  request: Request,
  // Tests give a clock and a low limit; the object gives neither.
  now: () => number = Date.now,
  limit = QUERIES_IN_WINDOW,
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== takePath) {
    return new Response("Not found", { status: 404 });
  }
  const counts = (await state.storage.get<DayCounts>(countsKey)) ?? {};
  const { taken, counts: next } = take(counts, now(), limit);
  if (taken.ok) await state.storage.put(countsKey, next);
  return Response.json(taken);
}
