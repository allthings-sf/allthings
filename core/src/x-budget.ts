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
 * Every X request goes through {@link XBudget}, in the database the Worker
 * and the CLI share (migrations/0043_x_reads.ts), so they spend one
 * budget. Before a request is sent, the most its answer can bill is held
 * for the day (`x_holds`), under a lock, if the day's spend and it fit in
 * the budget; otherwise nothing is sent, and the caller skips X with why
 * ("X daily budget spent: $1.80 of $2.00"). Once spent, X is skipped until
 * 00:00 UTC, when the day starts over, as X's billing day does; a request
 * held in the minute before it is held, and recorded, on both days, since X
 * may bill it on either. After X
 * answers, each post and user the answer holds is recorded for the day in
 * `x_reads`, once, as X bills it, and the hold is let go. A request
 * unanswered, cut short, or whose answer can't be recorded keeps its hold,
 * counted at its most for the rest of the day; a spend that can't be read
 * refuses the request. So X is never asked past the budget, nor while what
 * it has cost today is unknown.
 *
 * What X bills, from docs.x.com's pricing
 * (https://docs.x.com/x-api/getting-started/pricing, read 2026-11-26):
 * "Posts: Read" $0.005 and "User: Read" $0.010 per resource returned,
 * "deduplicated within a 24-hour UTC day window". The day's spend is an
 * estimate. It errs high where it can: an author X expands with a post
 * (`includes.users`) is counted as a user read, which the pricing doesn't
 * settle either way. But X calls its deduplication "a soft guarantee", so
 * on a day it fails, X's bill can run past what the budget counted.
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
   * Sends `request` to X if the most its answer can bill (`atMost`) fits in
   * what the day has left, holding that much for the day until X answers;
   * otherwise sends nothing and fails with {@link XBudgetRefused}. What a
   * 200 answer holds is recorded, and its hold let go; any other answer,
   * which X doesn't bill, lets its hold go and comes back as X sent it. A
   * request that fails, is cut short, or whose answer can't be read or
   * recorded keeps its hold, counted at its most for the rest of the day.
   */
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
    atMost: XBill,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError | XBudgetRefused
  >;
  /** What today (UTC) has spent so far, its open holds too, against the budget. */
  readonly today: Effect.Effect<XSpend, XBudgetRefused>;
}

/** Why X wasn't asked: the day's spend is unknown. */
const spendUnread = () =>
  new XBudgetRefused({
    reason: "X daily budget unknown: today's spend couldn't be read",
  });

/** Why a dry run never asks X. */
export const dryRunReason = "a dry run never reads X, which bills each read";

/** The UTC day of now, as `YYYY-MM-DD`. */
const today = Effect.map(DateTime.now, DateTime.formatIsoDateUtc);

/**
 * How near midnight (UTC), in minutes, a request may be billed on the next
 * day instead: longer than one takes from its hold to X's answer (15 to 20
 * seconds at most, by its callers' timeouts).
 */
export const midnightMinutes = 1;

/** `day`'s spend in `sql`: its reads, priced, and its open holds. */
const spentOn = (sql: SqlClient, day: string) =>
  orDataSourceError(
    sql<{ posts: number; users: number; held: number }>`
      SELECT
        (SELECT count(*) FROM x_reads WHERE day = ${day} AND kind = 'post')::int AS posts,
        (SELECT count(*) FROM x_reads WHERE day = ${day} AND kind = 'user')::int AS users,
        (SELECT COALESCE(sum(mills), 0) FROM x_holds WHERE day = ${day} AND NOT settled)::int AS held`,
  ).pipe(
    Effect.map(([row]) =>
      row === undefined
        ? 0
        : row.posts * xPrice.post + row.users * xPrice.user + row.held,
    ),
  );

/** Today's spend in `sql` against `budget`. */
const spendToday = (sql: SqlClient, budget: number) =>
  Effect.gen(function* () {
    const day = yield* today;
    const spent = yield* spentOn(sql, day).pipe(Effect.mapError(spendUnread));
    return { day, spent, budget } satisfies XSpend;
  });

/**
 * The key of the lock every hold is taken under (`pg_advisory_xact_lock`),
 * across every process that spends the budget.
 */
const holdLock = 430043;

/**
 * The days (UTC, `YYYY-MM-DD`) X may bill a request held at `now` on: its
 * own, and the next one too within {@link midnightMinutes} of midnight, since
 * the request reaches X after it is held. Its holds and its reads are on
 * each, so whichever day X bills it on has counted it.
 */
export const billingDays = (now: DateTime.Utc): ReadonlyArray<string> => {
  const day = DateTime.formatIsoDateUtc(now);
  const later = DateTime.formatIsoDateUtc(
    DateTime.add(now, { minutes: midnightMinutes }),
  );
  return later === day ? [day] : [day, later];
};

/** The budget X's callers share. */
export class XBudget extends Context.Service<XBudget, XBudgetShape>()(
  "allthings/XBudget",
) {
  /**
   * A budget of `usd` a day (held to {@link dailyBudget}'s bounds), kept in
   * `x_holds` and `x_reads`. Needs a `SqlClient` and an `HttpClient`.
   */
  static readonly make = (usd: number) =>
    Layer.effect(
      XBudget,
      Effect.gen(function* () {
        const budget = dailyBudget(usd);
        const sql = yield* SqlClient;
        const client = yield* HttpClient.HttpClient;

        /**
         * `most` held for each day X may bill the request on
         * ({@link billingDays}), if each day's spend and every other hold
         * leave room for it: its holds, or the spend that refused it. One
         * hold at a time, across every process, so none takes what another
         * just took.
         */
        const hold = (most: number) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT pg_advisory_xact_lock(${sql.literal(String(holdLock))})`;
                const days = billingDays(yield* DateTime.now);
                for (const day of days) {
                  const spent = yield* spentOn(sql, day);
                  // Once spent, nothing is sent, not even what bills nothing.
                  if (spent >= budget || spent + most > budget) {
                    return { _tag: "Refused", spent } as const;
                  }
                }
                const ids: Array<string> = [];
                for (const day of days) {
                  const [held] = yield* sql<{ id: string }>`
                    INSERT INTO x_holds ${sql.insert({ day, mills: most })}
                    RETURNING id`;
                  if (held === undefined) {
                    return yield* Effect.fail(spendUnread());
                  }
                  ids.push(held.id);
                }
                return { _tag: "Held", ids, days } as const;
              }),
            )
            .pipe(Effect.mapError(spendUnread));

        /**
         * Lets holds `ids` go, recording `rows`, what X billed for their
         * answer. One that fails keeps the holds, counted at their most: the
         * day's spend errs high, never low.
         */
        const settle = (
          ids: ReadonlyArray<string>,
          rows: ReadonlyArray<{ day: string; kind: string; id: string }>,
        ) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                if (rows.length > 0) {
                  yield* sql`INSERT INTO x_reads ${sql.insert(rows)} ON CONFLICT DO NOTHING`;
                }
                yield* sql`UPDATE x_holds SET settled = true WHERE id IN ${sql.in(ids)}`;
              }),
            )
            .pipe(Effect.ignore);

        const execute = (
          request: HttpClientRequest.HttpClientRequest,
          atMost: XBill,
        ) =>
          Effect.gen(function* () {
            const most =
              Math.max(0, atMost.posts ?? 0) * xPrice.post +
              Math.max(0, atMost.users ?? 0) * xPrice.user;
            const held = yield* hold(most);
            if (held._tag === "Refused") {
              const { spent } = held;
              return yield* new XBudgetRefused({
                reason: `X daily budget spent: ${dollars(spent)} of ${dollars(budget)}${spent < budget ? `, too little for a read of up to ${dollars(most)}` : ""}`,
              });
            }
            // From here, until X's answer is recorded, the hold stands: a
            // request that fails or is cut short stays counted at its most.
            const response = yield* client.execute(request);
            if (response.status !== 200) {
              yield* settle(held.ids, []);
              return response;
            }
            // Read once, to record what X billed; the caller reads its copy.
            const text = yield* response.text;
            const answer = parsed(text);
            // An answer that isn't JSON doesn't say what X billed for it:
            // its holds stay.
            if (answer !== undefined) {
              const { posts, users } = billedIn(answer);
              // On each day X may have billed it, so neither counts low.
              yield* settle(
                held.ids,
                held.days.flatMap((day) => [
                  ...[...posts].map((id) => ({ day, kind: "post", id })),
                  ...[...users].map((id) => ({ day, kind: "user", id })),
                ]),
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

        return XBudget.of({ execute, today: spendToday(sql, budget) });
      }),
    );

  /** {@link X_DAILY_BUDGET_USD} a day. Needs a `SqlClient` and an `HttpClient`. */
  static readonly layer = XBudget.make(X_DAILY_BUDGET_USD);

  /**
   * The budget of a dry run, which writes nothing: X is never asked
   * ({@link dryRunReason}), and today's spend is only read. A cached answer
   * (src/x-posts-source.ts) still serves. Needs a `SqlClient`.
   */
  static readonly dryRun = Layer.effect(
    XBudget,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return XBudget.of({
        execute: () =>
          Effect.fail(new XBudgetRefused({ reason: dryRunReason })),
        today: spendToday(sql, dailyBudget(X_DAILY_BUDGET_USD)),
      });
    }),
  );
}
