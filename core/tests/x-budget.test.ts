import { afterAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { ConfigProvider, DateTime, Effect, Exit, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/http";
import { SITE_SYNC_GRANTS } from "../../infra/scripts/site-sync.ts";
import { STUDIO_GRANTS } from "../../infra/scripts/studio.ts";
import { xReads } from "../migrations/0043_x_reads.ts";
import { COMMUNITY, CommunitySources } from "../src/community-metrics.ts";
import { FollowerSource } from "../src/followers.ts";
import { type EventSignals, makeXSearch } from "../src/posts/candidates.ts";
import {
  billedIn,
  dailyBudget,
  dollars,
  spendLine,
  X_DAILY_BUDGET_USD,
  XBudget,
  xBudgetBounds,
} from "../src/x-budget.ts";
import { XPostsSource } from "../src/x-posts-source.ts";
import {
  clockAt,
  migratedDatabase,
  sqlLayer,
  studioRun,
} from "./support/database.ts";

/**
 * X's daily budget (src/x-budget.ts): its bounds, what an answer bills, a
 * request refused once the day is spent, one count every caller of X
 * shares, the day starting over at 00:00 UTC, and X never asked while
 * what it cost is unknown. Each test has a fresh database and a fake X.
 */

const databases: Array<PGlite> = [];
afterAll(() => Promise.all(databases.map((db) => db.close())));

const fresh = async () => {
  const db = await migratedDatabase();
  databases.push(db);
  return db;
};

/** The instant most tests run at: midday, Nov 26 (UTC). */
const midday = DateTime.makeUnsafe("2026-11-26T12:00:00Z");

/** A user as X answers one, its id `id`. */
const user = (id: string) => ({
  id,
  name: `User ${id}`,
  username: `u${id}`,
  public_metrics: {
    followers_count: 10,
    following_count: 5,
    tweet_count: 20,
    listed_count: 1,
  },
});

/** A post as X answers one, by user 1. */
const post = (id: string) => ({
  id,
  text: `post ${id}`,
  created_at: "2026-11-25T02:00:00.000Z",
  author_id: "1",
  public_metrics: {
    like_count: 1,
    retweet_count: 0,
    reply_count: 0,
    quote_count: 0,
  },
});

/**
 * A fake X: users by ids, one user by id, posts by ids (all user 1's) and
 * an empty search, each as X answers; `asked` holds each path asked.
 */
const fakeX = (status = 200) => {
  const asked: Array<string> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url);
      const ids = (
        new URLSearchParams(UrlParams.toString(request.urlParams)).get("ids") ??
        ""
      )
        .split(",")
        .filter((id) => id !== "");
      asked.push(url.pathname);
      const body =
        url.pathname === "/2/users"
          ? { data: ids.map(user) }
          : url.pathname === "/2/tweets"
            ? { data: ids.map(post), includes: { users: [user("1")] } }
            : url.pathname.startsWith("/2/users/")
              ? { data: user(url.pathname.split("/").at(-1) ?? "") }
              : { meta: { result_count: 0 } };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          status === 200
            ? Response.json(body)
            : Response.json({ title: "CreditsDepleted" }, { status }),
        ),
      );
    }),
  );
  return { asked, layer };
};

/** A budget of `usd` a day in `db`, over `x`: one process's. */
const budgetOf = (
  db: PGlite,
  x: ReturnType<typeof fakeX>,
  usd = xBudgetBounds.min,
) =>
  XBudget.make(usd).pipe(Layer.provide(Layer.mergeAll(x.layer, sqlLayer(db))));

/** `ids`' accounts, asked of X through the budget: at most one user each. */
const lookUp = (ids: ReadonlyArray<string>) =>
  XBudget.use((budget) =>
    budget.execute(
      HttpClientRequest.get("https://api.x.com/2/users").pipe(
        HttpClientRequest.setUrlParam("ids", ids.join(",")),
      ),
      { users: ids.length },
    ),
  );

/** Ids `from` to `to`, as strings. */
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => String(from + index));

/** Why `exit` failed (its error's reason), or "sent". */
const outcome = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "sent";
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    ?.error as { readonly reason?: unknown } | undefined;
  return typeof error?.reason === "string" ? error.reason : "died";
};

/** The day's rows in `x_reads`, by kind. */
const recorded = async (db: PGlite, day = "2026-11-26") =>
  Object.fromEntries(
    (
      await db.query<{ kind: string; count: number }>(
        `SELECT kind, count(*)::int AS count FROM x_reads WHERE day = $1 GROUP BY kind ORDER BY kind`,
        [day],
      )
    ).rows.map(({ kind, count }) => [kind, count]),
  );

describe("the daily budget", () => {
  test("is whole cents from $0.50 up to $5: never nothing, never unbounded", () => {
    for (const usd of [
      0,
      -1,
      0.49,
      5,
      5.01,
      1.005,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => dailyBudget(usd)).toThrow(RangeError);
    }
    expect(dailyBudget(0.5)).toBe(500);
    expect(dailyBudget(4.99)).toBe(4990);
    // The reviewed default: raising it is a pull request.
    expect(X_DAILY_BUDGET_USD).toBe(2);
    expect(dailyBudget(X_DAILY_BUDGET_USD)).toBe(2000);
  });

  test("of nothing is never made, so X is never asked under one", async () => {
    const db = await fresh();
    const x = fakeX();
    const exit = await Effect.runPromiseExit(
      lookUp(["1"]).pipe(
        Effect.provide(budgetOf(db, x, 0)),
        Effect.provide(clockAt(midday)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(x.asked).toEqual([]);
  });

  test("is said in dollars, its share spent too", () => {
    expect(dollars(2000)).toBe("$2.00");
    expect(dollars(420)).toBe("$0.42");
    expect(dollars(1995)).toBe("$1.995");
    expect(dollars(5)).toBe("$0.005");
    expect(spendLine({ day: "2026-11-26", spent: 1000, budget: 2000 })).toBe(
      "X daily budget: $1.00 of $2.00 spent (50%)",
    );
  });
});

describe("what an answer bills", () => {
  test("is each post and user it holds, once, expanded authors too", () => {
    const of = (answer: unknown) => {
      const { posts, users } = billedIn(answer);
      return { posts: [...posts], users: [...users] };
    };
    expect(
      of({
        data: [
          { id: "21", text: "a" },
          { id: "22", text: "b" },
          { id: "21", text: "a" },
        ],
        includes: { users: [{ id: "9", username: "ada" }] },
      }),
    ).toEqual({ posts: ["21", "22"], users: ["9"] });
    // A lookup's one user, and its posts' timeline with their author.
    expect(of({ data: user("7") })).toEqual({ posts: [], users: ["7"] });
    expect(
      of({
        data: [post("31")],
        includes: { users: [user("1")], tweets: [post("32")] },
      }),
    ).toEqual({ posts: ["31", "32"], users: ["1"] });
  });

  test("is nothing when it holds no post or user", () => {
    for (const answer of [
      undefined,
      null,
      "not json",
      { meta: { result_count: 0 } },
      { errors: [{ title: "Not Found Error", resource_id: "8" }] },
      { data: { cap_reset_day: 6, project_usage: "302" } },
      { data: [{ id: "not an id", text: "?" }] },
    ]) {
      const { posts, users } = billedIn(answer);
      expect([posts.size, users.size]).toEqual([0, 0]);
    }
  });
});

describe("a request to X", () => {
  test.skipIf(studioRun)(
    "is refused once the day is spent: what wouldn't fit, then everything, and X bills each account once a day",
    async () => {
      const db = await fresh();
      const x = fakeX();
      const steps = await Effect.runPromise(
        Effect.gen(function* () {
          const results: Array<string> = [];
          for (const ids of [
            range(1, 20), // $0.20 of $0.50
            range(1, 20), // the same accounts: billed once a day
            range(21, 40), // $0.40
            range(41, 60), // $0.20 more wouldn't fit
            range(41, 50), // $0.10 just fits: $0.50
            ["51"], // nothing does
          ]) {
            results.push(outcome(yield* Effect.exit(lookUp(ids))));
          }
          results.push(outcome(yield* Effect.exit(lookUp([]))));
          return {
            results,
            today: yield* XBudget.use((budget) => budget.today),
          };
        }).pipe(
          Effect.provide(budgetOf(db, x)),
          Effect.provide(clockAt(midday)),
        ),
      );
      expect(steps.results).toEqual([
        "sent",
        "sent",
        "sent",
        "X daily budget spent: $0.40 of $0.50, too little for a read of up to $0.20",
        "sent",
        "X daily budget spent: $0.50 of $0.50",
        // A request that can bill nothing still waits for tomorrow's budget.
        "X daily budget spent: $0.50 of $0.50",
      ]);
      expect(x.asked).toHaveLength(4);
      expect(steps.today).toEqual({
        day: "2026-11-26",
        spent: 500,
        budget: 500,
      });
      expect(await recorded(db)).toEqual({ user: 50 });
    },
  );

  test.skipIf(studioRun)(
    "answered with anything but 200 bills nothing and comes back as X sent it",
    async () => {
      const db = await fresh();
      const x = fakeX(402);
      const answer = await Effect.runPromise(
        lookUp(["1"]).pipe(
          Effect.flatMap((response) =>
            Effect.map(response.text, (text) => ({
              status: response.status,
              text,
            })),
          ),
          Effect.provide(budgetOf(db, x)),
          Effect.provide(clockAt(midday)),
        ),
      );
      expect(answer).toEqual({
        status: 402,
        text: JSON.stringify({ title: "CreditsDepleted" }),
      });
      expect(await recorded(db)).toEqual({});
    },
  );

  test.skipIf(studioRun)(
    "is never sent while what the day cost is unknown: its spend unread, or an answer unrecorded",
    async () => {
      const unread = await fresh();
      await unread.exec(`DROP TABLE x_reads`);
      const x = fakeX();
      const refused = await Effect.runPromiseExit(
        lookUp(["1"]).pipe(
          Effect.provide(budgetOf(unread, x)),
          Effect.provide(clockAt(midday)),
        ),
      );
      expect(outcome(refused)).toBe(
        "X daily budget unknown: today's spend couldn't be read",
      );
      expect(x.asked).toEqual([]);

      const unrecorded = await fresh();
      await unrecorded.exec(`
        CREATE FUNCTION refuse_x_reads() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'no'; END $$;
        CREATE TRIGGER refuse_x_reads BEFORE INSERT ON x_reads
          FOR EACH ROW EXECUTE FUNCTION refuse_x_reads();`);
      const y = fakeX();
      const both = await Effect.runPromise(
        Effect.gen(function* () {
          const first = outcome(yield* Effect.exit(lookUp(["1"])));
          const second = outcome(yield* Effect.exit(lookUp(["2"])));
          return [first, second];
        }).pipe(
          Effect.provide(budgetOf(unrecorded, y)),
          Effect.provide(clockAt(midday)),
        ),
      );
      const why =
        "X daily budget unknown: an answer from X couldn't be recorded, so X isn't asked again in this run";
      expect(both).toEqual([why, why]);
      // X answered the first, which may be billed; the second never left.
      expect(y.asked).toEqual(["/2/users"]);
    },
  );
});

describe("the day", () => {
  test.skipIf(studioRun)(
    "starts over at 00:00 UTC, as X's billing day does",
    async () => {
      const db = await fresh();
      // Nov 26 spent: 100 posts, $0.50.
      await db.exec(
        `INSERT INTO x_reads (day, kind, id) SELECT '2026-11-26', 'post', g::text FROM generate_series(1, 100) g`,
      );
      const x = fakeX();
      const run = await Effect.runPromise(
        Effect.gen(function* () {
          const before = outcome(yield* Effect.exit(lookUp(["1"])));
          // One second to midnight, then midnight.
          yield* TestClock.adjust("1 second");
          const after = outcome(yield* Effect.exit(lookUp(["1"])));
          return {
            before,
            after,
            today: yield* XBudget.use((budget) => budget.today),
          };
        }).pipe(
          Effect.provide(budgetOf(db, x)),
          Effect.provide(clockAt(DateTime.makeUnsafe("2026-11-26T23:59:59Z"))),
        ),
      );
      expect(run.before).toBe("X daily budget spent: $0.50 of $0.50");
      expect(run.after).toBe("sent");
      expect(run.today).toEqual({ day: "2026-11-27", spent: 10, budget: 500 });
      // The day before keeps its record.
      expect(await recorded(db, "2026-11-26")).toEqual({ post: 100 });
      expect(await recorded(db, "2026-11-27")).toEqual({ user: 1 });
    },
  );
});

describe("every caller of X", () => {
  /** An evening that ended last night, which recent search reaches. */
  const signals: EventSignals = {
    slug: "2026-11-24-react-at-acme",
    name: "React at Acme",
    topic: "react",
    startsAt: DateTime.makeUnsafe("2026-11-25T01:00:00Z"),
    endsAt: DateTime.makeUnsafe("2026-11-25T04:00:00Z"),
    links: ["https://luma.com/react-at-acme"],
    hosts: ["Acme"],
    xHandles: ["ada"],
    xUserIds: [],
    xHandlesWithoutId: ["ada"],
    xFrom: ["ada"],
    blueskyHandles: [],
  };
  const config = Layer.succeed(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv({ env: { X_BEARER_TOKEN: "test" } }),
  );

  test.skipIf(studioRun)(
    "spends one count: the Worker's followers and community, the CLI's posts and post search",
    async () => {
      const db = await fresh();
      const x = fakeX();
      /** `effect` as one process does it, with a budget of its own over the shared database. */
      const asProcess = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        layer: Layer.Layer<R, unknown, XBudget>,
      ) =>
        Effect.runPromiseExit(
          effect.pipe(
            Effect.provide(
              layer.pipe(
                Layer.provideMerge(budgetOf(db, x)),
                Layer.provide(Layer.mergeAll(x.layer, sqlLayer(db), config)),
              ) as Layer.Layer<R>,
            ),
            Effect.provide(clockAt(midday)),
          ),
        );

      // The Worker's follower refresh: 30 accounts, $0.30.
      const followers = await asProcess(
        FollowerSource.use(
          (source) =>
            source.readByIds?.(range(1, 30)) ?? Effect.die("no batch"),
        ),
        FollowerSource.xApi,
      );
      expect(Exit.isSuccess(followers)).toBe(true);

      // The CLI's `people posts`: ten posts by user 1, whom the Worker read
      // today, so only the posts are billed: $0.35.
      const posts = await asProcess(
        XPostsSource.use((source) => source.posts(range(101, 110))),
        XPostsSource.xApi(),
      );
      expect(Exit.isSuccess(posts)).toBe(true);

      // The Worker's community snapshot: our account, $0.36.
      const community = await asProcess(
        CommunitySources.use((sources) => sources.read("x")),
        CommunitySources.live,
      );
      expect(Exit.isSuccess(community)).toBe(true);

      // The CLI's `posts find`: a search could bill $0.375 more, past $0.50.
      const search = await asProcess(
        Effect.gen(function* () {
          const xSearch = yield* makeXSearch;
          return yield* xSearch.search(signals);
        }),
        Layer.empty,
      );
      expect(outcome(search)).toBe(
        "X daily budget spent: $0.36 of $0.50, too little for a read of up to $0.375",
      );

      expect(x.asked).toEqual([
        "/2/users",
        "/2/tweets",
        `/2/users/${COMMUNITY.xUserId}`,
      ]);
      expect(await recorded(db)).toEqual({ post: 10, user: 31 });
    },
  );
});

describe("migration 0043's grants", () => {
  test.skipIf(studioRun)(
    "give site_sync exactly what its script lists, and the studio nothing until its own script runs",
    async () => {
      const db = await fresh();
      for (const role of ["site_sync", "studio"]) {
        await db.exec(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
        );
        await db.exec(`REVOKE ALL ON public.x_reads FROM ${role}`);
      }
      const statement = xReads.at(-1) ?? "";
      expect(statement).toContain("DO $grant$");
      await db.exec(statement);
      /** What `role` holds on x_reads, as `column privilege` lines. */
      const held = async (role: string) =>
        (
          await db.query<{ grant: string }>(
            `SELECT column_name || ' ' || lower(privilege_type) AS grant
             FROM information_schema.column_privileges
             WHERE grantee = $1 AND table_schema = 'public' AND table_name = 'x_reads'
             ORDER BY 1`,
            [role],
          )
        ).rows.map(({ grant }) => grant);
      const listed = SITE_SYNC_GRANTS["x_reads"] ?? {};
      expect(await held("site_sync")).toEqual(
        [
          ...(listed.select ?? []).map((column) => `${column} select`),
          ...(listed.insert ?? []).map((column) => `${column} insert`),
        ].toSorted(),
      );
      expect(STUDIO_GRANTS["public.x_reads"]).toEqual({
        select: true,
        insert: ["day", "kind", "id"],
      });
      expect(await held("studio")).toEqual([]);
    },
  );
});
