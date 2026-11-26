import { Context, DateTime, Effect, Layer, Schema } from "effect";
import {
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { orDataSourceError } from "./sql.ts";

/**
 * One budget a UTC day, in dollars, for everything this repository reads
 * from X's API: the sync Worker's post search (src/posts/candidates.ts),
 * follower counts (src/followers.ts) and community snapshot
 * (src/community-metrics.ts), and the CLI's, which run the same code, and
 * `bun run people posts` (src/x-posts-source.ts). X bills pay-per-use
 * reads from prepaid credits, which auto-recharge can refill without end:
 * without this, nothing but time windows bounds what a loop, a bug or a
 * large run spends in a day.
 *
 * Every X request goes through {@link XBudget}. Before it is sent, the
 * day's spend so far and the most its answer can bill must fit in the
 * budget; otherwise nothing is sent, and the caller skips X with why
 * ("X daily budget spent: $1.80 of $2.00"). Once spent, X is skipped until
 * 00:00 UTC, when the day starts over, as X's billing day does. After X
 * answers, each post and user the answer holds is recorded for the day in
 * `x_reads` (migrations/0043_x_reads.ts), once, as X bills it, in the
 * database the Worker and the CLI share, so they spend one budget. A spend
 * that can't be read, or an answer that can't be recorded, refuses too:
 * X is never asked while what it has cost today is unknown.
 *
 * What X bills, from docs.x.com's pricing
 * (https://docs.x.com/x-api/getting-started/pricing, read 2026-11-26):
 * "Posts: Read" $0.005 and "User: Read" $0.010 per resource returned,
 * "deduplicated within a 24-hour UTC day window". The estimate errs high:
 * an author X expands with a post (`includes.users`) is counted as a user
 * read, which the pricing doesn't settle either way, and X calls its
 * deduplication "a soft guarantee". It can pass the budget only when two
 * callers check at once, each by at most what its one request can bill.
 *
 * Announcing on X (src/social/x.ts) isn't counted: each post there is
 * approved by a person and sent once, never retried, and refusing a
 * planned announcement because the day's reads were spent would be wrong.
 */

/**
 * What X bills on pay-per-use for each resource an answer returns, in
 * thousandths of a dollar: $0.005 a post, $0.010 a user.
 */
export const xPrice = { post: 5, user: 10 } as const;

/**
 * The day's budget for X, in dollars: a reviewed constant, so raising it is
 * a pull request. Sized from the 14 days X last answered, Oct 30 to Nov 12,
 * 2026 (it has refused every read since, its credits spent): $2.00 is about
 * three times Nov 11 ($0.66: 65 follower counts and the community's), and
 * a third over the busiest day, Nov 12 ($1.52: 301 posts the post search
 * found after an evening, and the community's), whose three times ($4.55)
 * would leave a day's worst near $5. At most $62 in a 31-day month.
 */
export const X_DAILY_BUDGET_USD = 2;

/**
 * The bounds any daily budget is held to, in dollars: at least `min`, so X
 * is usable, and below `max`, so a day's worst stays small.
 */
export const xBudgetBounds = { min: 0.5, max: 5 } as const;

/**
 * `usd` as a daily budget in thousandths of a dollar, held to
 * {@link xBudgetBounds} and to whole cents: a defect otherwise, so a
 * budget of nothing, or none, is never made.
 */
export const dailyBudget = (usd: number): number => {
  const mills = Math.round(usd * 1000);
  if (
    !Number.isFinite(usd) ||
    usd < xBudgetBounds.min ||
    usd >= xBudgetBounds.max ||
    mills % 10 !== 0
  ) {
    throw new RangeError(
      `X's daily budget must be whole cents from $${xBudgetBounds.min.toFixed(2)} up to, not including, $${xBudgetBounds.max.toFixed(2)}: not ${usd}`,
    );
  }
  return mills;
};

/** Thousandths of a dollar as dollars: `$2.00`, `$0.42`, `$1.995`. */
export const dollars = (mills: number): string => {
  const shown = (mills / 1000).toFixed(3);
  return `$${shown.endsWith("0") ? shown.slice(0, -1) : shown}`;
};

/** X wasn't asked: the day's budget is spent, or what it spent is unknown. */
export class XBudgetRefused extends Schema.TaggedError<XBudgetRefused>()(
  "XBudgetRefused",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The most one answer can bill: how many posts and users it may hold. */
export interface XBill {
  readonly posts?: number;
  readonly users?: number;
}

/** What a day has spent on X, against its budget, in thousandths of a dollar. */
export interface XSpend {
  /** The UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly spent: number;
  readonly budget: number;
}

/** A day's spend as a run's summary says it: `X daily budget: $0.42 of $2.00 spent (21%)`. */
export const spendLine = ({ spent, budget }: XSpend): string =>
  `X daily budget: ${dollars(spent)} of ${dollars(budget)} spent (${Math.floor((spent / budget) * 100)}%)`;

/** An X id: digits, as X writes them. */
const xId = /^[0-9]{1,20}$/;

/** `text` as JSON, or undefined when it isn't: such an answer holds nothing to bill. */
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The posts and users an answer from X holds, by id: what X bills for it.
 * A `data` item with a `username` is a user (X always returns one); any
 * other with an id is a post. Expanded users and posts (`includes.users`,
 * `includes.tweets`) count too.
 */
export const billedIn = (
  answer: unknown,
): {
  readonly posts: ReadonlySet<string>;
  readonly users: ReadonlySet<string>;
} => {
  const posts = new Set<string>();
  const users = new Set<string>();
  const record = (item: unknown, as?: "post" | "user") => {
    if (typeof item !== "object" || item === null) return;
    const { id, username } = item as { id?: unknown; username?: unknown };
    if (typeof id !== "string" || !xId.test(id)) return;
    const user =
      as === undefined ? typeof username === "string" : as === "user";
    (user ? users : posts).add(id);
  };
  const listOf = (value: unknown): ReadonlyArray<unknown> =>
    Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (typeof answer !== "object" || answer === null) return { posts, users };
  const { data, includes } = answer as { data?: unknown; includes?: unknown };
  for (const item of listOf(data)) record(item);
  if (typeof includes === "object" && includes !== null) {
    const { users: expanded, tweets } = includes as {
      users?: unknown;
      tweets?: unknown;
    };
    for (const user of listOf(expanded)) record(user, "user");
    for (const post of listOf(tweets)) record(post, "post");
  }
  return { posts, users };
};

export interface XBudgetShape {
  /**
   * Sends `request` to X, if the day's spend and the most its answer can
   * bill (`atMost`) fit in the budget, and records what a 200 answer holds;
   * otherwise sends nothing and fails with {@link XBudgetRefused}. Any
   * other answer is returned as it came, and bills nothing.
   */
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
    atMost: XBill,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError | XBudgetRefused
  >;
  /** What today (UTC) has spent so far, against the budget. */
  readonly today: Effect.Effect<XSpend, XBudgetRefused>;
}

/** The budget X's callers share. */
export class XBudget extends Context.Service<XBudget, XBudgetShape>()(
  "allthings/XBudget",
) {
  /**
   * A budget of `usd` a day (held to {@link dailyBudget}'s bounds), kept in
   * `x_reads`. Needs a `SqlClient` and an `HttpClient`.
   */
  static readonly make = (usd: number) =>
    Layer.effect(
      XBudget,
      Effect.gen(function* () {
        const budget = dailyBudget(usd);
        const sql = yield* SqlClient;
        const client = yield* HttpClient.HttpClient;
        // Once an answer couldn't be recorded, what X has billed is
        // unknown: nothing more is sent from this process.
        let unrecorded: string | undefined;

        const spentOn = (day: string) =>
          orDataSourceError(
            sql<{ kind: string; count: number }>`
              SELECT kind, count(*)::int AS count FROM x_reads
              WHERE day = ${day} GROUP BY kind`,
          ).pipe(
            Effect.map((rows) =>
              rows.reduce(
                (sum, { kind, count }) =>
                  sum + count * (kind === "user" ? xPrice.user : xPrice.post),
                0,
              ),
            ),
          );

        const today = Effect.gen(function* () {
          const day = DateTime.formatIsoDateUtc(yield* DateTime.now);
          const spent = yield* spentOn(day).pipe(
            Effect.mapError(
              () =>
                new XBudgetRefused({
                  reason:
                    "X daily budget unknown: today's spend couldn't be read",
                }),
            ),
          );
          return { day, spent, budget } satisfies XSpend;
        });

        const execute = (
          request: HttpClientRequest.HttpClientRequest,
          atMost: XBill,
        ) =>
          Effect.gen(function* () {
            if (unrecorded !== undefined) {
              return yield* new XBudgetRefused({ reason: unrecorded });
            }
            const { day, spent } = yield* today;
            const most =
              Math.max(0, atMost.posts ?? 0) * xPrice.post +
              Math.max(0, atMost.users ?? 0) * xPrice.user;
            // Once spent, nothing is sent, not even what could bill nothing.
            if (spent >= budget || spent + most > budget) {
              return yield* new XBudgetRefused({
                reason: `X daily budget spent: ${dollars(spent)} of ${dollars(budget)}${spent < budget ? `, too little for a read of up to ${dollars(most)}` : ""}`,
              });
            }
            const response = yield* client.execute(request);
            if (response.status !== 200) return response;
            // Read once, to count what X billed; the caller reads its copy.
            const text = yield* response.text;
            const { posts, users } = billedIn(parsed(text));
            const rows = [
              ...[...posts].map((id) => ({ day, kind: "post", id })),
              ...[...users].map((id) => ({ day, kind: "user", id })),
            ];
            if (rows.length > 0) {
              yield* orDataSourceError(
                sql`INSERT INTO x_reads ${sql.insert(rows)} ON CONFLICT DO NOTHING`,
              ).pipe(
                Effect.mapError(() => {
                  unrecorded =
                    "X daily budget unknown: an answer from X couldn't be recorded, so X isn't asked again in this run";
                  return new XBudgetRefused({ reason: unrecorded });
                }),
              );
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(text, {
                status: response.status,
                headers: Object.entries(response.headers),
              }),
            );
          });

        return XBudget.of({ execute, today });
      }),
    );

  /** {@link X_DAILY_BUDGET_USD} a day. Needs a `SqlClient` and an `HttpClient`. */
  static readonly layer = XBudget.make(X_DAILY_BUDGET_USD);
}
