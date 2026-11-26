import { afterAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/http";
import type { SqlClient } from "effect/sql/SqlClient";
import { SITE_SYNC_GRANTS } from "../../infra/scripts/site-sync.ts";
import { STUDIO_GRANTS } from "../../infra/scripts/studio.ts";
import { xReads } from "../migrations/0043_x_reads.ts";
import { COMMUNITY, CommunitySources } from "../src/community-metrics.ts";
import { FollowerSource } from "../src/followers.ts";
import {
  type CandidateSearchShape,
  type EventSignals,
  makeXSearch,
} from "../src/posts/candidates.ts";
import {
  billedIn,
  dailyBudget,
  dollars,
  dryRunReason,
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
 * X's daily budget (src/x-budget.ts): its bounds; what an answer bills; a
 * request refused once the day is spent; one count every caller of X
 * shares, an answer in flight held against the others; the day starting
 * over at 00:00 UTC; a request unanswered or unrecorded counted at its
 * most; and a dry run that asks X nothing. Each test has a fresh database
 * and a fake X. `bun run test:studio` runs it as the studio, for `people
 * posts` and `posts find`.
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
 * an empty search, each as X answers, unless `answer` answers instead;
 * `asked` holds each path asked. `meanwhile` runs as each request arrives.
 */
const fakeX = (
  options: {
    readonly answer?: () => Response;
    readonly meanwhile?: () => Promise<void>;
  } = {},
) => {
  const asked: Array<string> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.promise(async () => {
        const url = new URL(request.url);
        // The ids as a parameter (`setUrlParam`) or in the URL itself, as
        // `people posts` writes them.
        const ids = (
          new URLSearchParams(UrlParams.toString(request.urlParams)).get(
            "ids",
          ) ??
          url.searchParams.get("ids") ??
          ""
        )
          .split(",")
          .filter((id) => id !== "");
        asked.push(url.pathname);
        await options.meanwhile?.();
        const body =
          url.pathname === "/2/users"
            ? { data: ids.map(user) }
            : url.pathname === "/2/tweets"
              ? { data: ids.map(post), includes: { users: [user("1")] } }
              : url.pathname.startsWith("/2/users/")
                ? { data: user(url.pathname.split("/").at(-1) ?? "") }
                : { meta: { result_count: 0 } };
        return HttpClientResponse.fromWeb(
          request,
          options.answer?.() ?? Response.json(body),
        );
      }),
    ),
  );
  return { asked, layer };
};

/** A budget of `usd` a day in `db`, over `x`: one process's. */
const budgetOf = (
  db: PGlite,
  x: ReturnType<typeof fakeX>,
  usd: number = xBudgetBounds.min,
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

/** The day's spend, as the budget counts it. */
const spent = XBudget.use((budget) => budget.today).pipe(
  Effect.map((today) => today.spent),
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

/** The day's holds still open, in thousandths of a dollar. */
const open = async (db: PGlite, day = "2026-11-26") =>
  (
    await db.query<{ mills: number }>(
      `SELECT mills FROM x_holds WHERE day = $1 AND NOT settled ORDER BY mills`,
      [day],
    )
  ).rows.map(({ mills }) => mills);

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
  test("is refused once the day is spent: what wouldn't fit, then everything, and X bills each account once a day", async () => {
    const db = await fresh();
    const x = fakeX();
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        const results: Array<string> = [];
        for (const ids of [
          range(1, 20), // $0.20 of $0.50
          range(1, 20), // the same accounts: billed once a day
          range(21, 40), // $0.40
          range(41, 60), // $0.20 more wouldn't fit
          range(41, 50), // $0.10 just fits: $0.50
          ["51"], // nothing does
          [], // not even what bills nothing
        ]) {
          results.push(outcome(yield* Effect.exit(lookUp(ids))));
        }
        return {
          results,
          today: yield* XBudget.use((budget) => budget.today),
        };
      }).pipe(Effect.provide(budgetOf(db, x)), Effect.provide(clockAt(midday))),
    );
    expect(run.results).toEqual([
      "sent",
      "sent",
      "sent",
      "X daily budget spent: $0.40 of $0.50, too little for a read of up to $0.20",
      "sent",
      "X daily budget spent: $0.50 of $0.50",
      "X daily budget spent: $0.50 of $0.50",
    ]);
    expect(x.asked).toHaveLength(4);
    expect(run.today).toEqual({ day: "2026-11-26", spent: 500, budget: 500 });
    expect(await recorded(db)).toEqual({ user: 50 });
    // Each answer recorded let its hold go.
    expect(await open(db)).toEqual([]);
  });

  test("answered with anything but 200 bills nothing and comes back as X sent it", async () => {
    const db = await fresh();
    const x = fakeX({
      answer: () =>
        Response.json({ title: "CreditsDepleted" }, { status: 402 }),
    });
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
    expect(await open(db)).toEqual([]);
  });

  test("unanswered, cut short or unrecorded stays counted at its most for the day", async () => {
    // A 200 whose body breaks off.
    const broken = await fresh();
    const cut = fakeX({
      answer: () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.error(new Error("cut")),
          }),
          { status: 200 },
        ),
    });
    const afterCut = await Effect.runPromise(
      Effect.gen(function* () {
        const sent = yield* Effect.exit(lookUp(range(1, 3)));
        return { failed: Exit.isFailure(sent), spent: yield* spent };
      }).pipe(
        Effect.provide(budgetOf(broken, cut)),
        Effect.provide(clockAt(midday)),
      ),
    );
    expect(afterCut).toEqual({ failed: true, spent: 30 });

    // A 200 that isn't JSON: what X billed for it is unknown.
    const garbled = await fresh();
    const notJson = fakeX({
      answer: () => new Response("<html>", { status: 200 }),
    });
    const afterGarble = await Effect.runPromise(
      lookUp(["1"]).pipe(
        Effect.andThen(spent),
        Effect.provide(budgetOf(garbled, notJson)),
        Effect.provide(clockAt(midday)),
      ),
    );
    expect(afterGarble).toBe(10);
    expect(await open(garbled)).toEqual([10]);

    // A caller's timeout that cuts the request off before X answers.
    const hung = await fresh();
    const arrived = Effect.runSync(Deferred.make<void>());
    const hanging = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Deferred.succeed(arrived, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    );
    const afterHang = await Effect.runPromise(
      Effect.gen(function* () {
        const request = yield* Effect.forkChild(lookUp(range(1, 2)));
        yield* Deferred.await(arrived);
        yield* Fiber.interrupt(request);
        return yield* spent;
      }).pipe(
        Effect.provide(
          XBudget.make(0.5).pipe(
            Layer.provide(Layer.mergeAll(hanging, sqlLayer(hung))),
          ),
        ),
        Effect.provide(clockAt(midday)),
      ),
    );
    expect(afterHang).toBe(20);
  });

  test.skipIf(studioRun)(
    "is never sent while the day's spend can't be read",
    async () => {
      const db = await fresh();
      await db.exec(`DROP TABLE x_reads`);
      const x = fakeX();
      const refused = await Effect.runPromiseExit(
        lookUp(["1"]).pipe(
          Effect.provide(budgetOf(db, x)),
          Effect.provide(clockAt(midday)),
        ),
      );
      expect(outcome(refused)).toBe(
        "X daily budget unknown: today's spend couldn't be read",
      );
      expect(x.asked).toEqual([]);
    },
  );

  test.skipIf(studioRun)(
    "whose answer can't be recorded stays counted at its most",
    async () => {
      const db = await fresh();
      await db.exec(`
        CREATE FUNCTION refuse_x_reads() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'no'; END $$;
        CREATE TRIGGER refuse_x_reads BEFORE INSERT ON x_reads
          FOR EACH ROW EXECUTE FUNCTION refuse_x_reads();`);
      const x = fakeX();
      const run = await Effect.runPromise(
        Effect.gen(function* () {
          const first = outcome(yield* Effect.exit(lookUp(range(1, 20))));
          const second = outcome(yield* Effect.exit(lookUp(range(1, 20))));
          const third = outcome(yield* Effect.exit(lookUp(range(1, 20))));
          return { first, second, third, spent: yield* spent };
        }).pipe(
          Effect.provide(budgetOf(db, x)),
          Effect.provide(clockAt(midday)),
        ),
      );
      // The same accounts, but none recorded: each read counts at its most.
      expect(run).toEqual({
        first: "sent",
        second: "sent",
        third:
          "X daily budget spent: $0.40 of $0.50, too little for a read of up to $0.20",
        spent: 400,
      });
      expect(x.asked).toHaveLength(2);
      expect(await open(db)).toEqual([200, 200]);
    },
  );
});

describe("the day", () => {
  test("starts over at 00:00 UTC, as X's billing day does", async () => {
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
  });
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
  /** The post search, as `posts find` asks it. */
  const search = Effect.gen(function* () {
    const xSearch: CandidateSearchShape = yield* makeXSearch;
    return yield* xSearch.search(signals);
  });

  /**
   * `effect` as one process runs it, over `x`, with a budget of its own
   * (`budgetFor`, a live one by default) over the shared database `db`,
   * through one connection: the studio's, in its run.
   */
  const asProcess = <A, E, R>(
    db: PGlite,
    x: ReturnType<typeof fakeX>,
    effect: Effect.Effect<A, E, R | XBudget>,
    layer: Layer.Layer<R, unknown, XBudget | HttpClient.HttpClient | SqlClient>,
    budgetFor: (
      sql: Layer.Layer<SqlClient, unknown>,
    ) => Layer.Layer<XBudget, unknown> = (sql) =>
      XBudget.make(xBudgetBounds.min).pipe(
        Layer.provide(Layer.mergeAll(x.layer, sql)),
      ),
  ) => {
    const sql = sqlLayer(db);
    return Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(budgetFor(sql)),
            Layer.provide(Layer.mergeAll(x.layer, sql)),
            // The token, for the layer and for a search the effect makes.
            Layer.provideMerge(config),
          ),
        ),
        Effect.provide(clockAt(midday)),
      ),
    );
  };

  /** A dry run's budget over `sql`. */
  const dryRun = (sql: Layer.Layer<SqlClient, unknown>) =>
    XBudget.dryRun.pipe(Layer.provide(sql));

  test("spends one count: the Worker's followers and community, the CLI's posts and post search", async () => {
    const db = await fresh();
    const x = fakeX();

    // The Worker's follower refresh: 30 accounts, $0.30.
    const followers = await asProcess(
      db,
      x,
      FollowerSource.use(
        (source) => source.readByIds?.(range(1, 30)) ?? Effect.die("no batch"),
      ),
      FollowerSource.xApi,
    );
    expect(Exit.isSuccess(followers)).toBe(true);

    // The CLI's `people posts`: ten posts by user 1, whom the Worker read
    // today, so only the posts are billed: $0.35.
    const posts = await asProcess(
      db,
      x,
      XPostsSource.use((source) => source.posts(range(101, 110))),
      XPostsSource.xApi(),
    );
    expect(Exit.isSuccess(posts)).toBe(true);

    // The Worker's community snapshot: our account, $0.36.
    const community = await asProcess(
      db,
      x,
      CommunitySources.use((sources) => sources.read("x")),
      CommunitySources.live,
    );
    expect(Exit.isSuccess(community)).toBe(true);

    // The CLI's `posts find`: a search could bill $0.375 more, past $0.50.
    expect(outcome(await asProcess(db, x, search, Layer.empty))).toBe(
      "X daily budget spent: $0.36 of $0.50, too little for a read of up to $0.375",
    );

    expect(x.asked).toEqual([
      "/2/users",
      "/2/tweets",
      `/2/users/${COMMUNITY.xUserId}`,
    ]);
    expect(await recorded(db)).toEqual({ post: 10, user: 31 });
  });

  // Two processes on one PGlite connection: the studio's run, which makes its
  // role on each connection it opens, can't nest one in the other.
  test.skipIf(studioRun)(
    "holds a request in flight against the others: two never both take the last of the day",
    async () => {
      const db = await fresh();
      /** What the CLI's lookup met while the Worker's was in flight. */
      const meanwhile: Array<string> = [];
      const cli = fakeX();
      const worker = fakeX({
        meanwhile: async () => {
          meanwhile.push(
            outcome(
              await Effect.runPromiseExit(
                lookUp(range(31, 55)).pipe(
                  Effect.provide(budgetOf(db, cli)),
                  Effect.provide(clockAt(midday)),
                ),
              ),
            ),
          );
        },
      });
      const sent = await Effect.runPromiseExit(
        lookUp(range(1, 30)).pipe(
          Effect.provide(budgetOf(db, worker)),
          Effect.provide(clockAt(midday)),
        ),
      );
      expect(Exit.isSuccess(sent)).toBe(true);
      // The Worker's 30 accounts were held, $0.30: $0.25 more didn't fit.
      expect(meanwhile).toEqual([
        "X daily budget spent: $0.30 of $0.50, too little for a read of up to $0.25",
      ]);
      expect(cli.asked).toEqual([]);
      expect(await recorded(db)).toEqual({ user: 30 });
      expect(await open(db)).toEqual([]);
    },
  );

  test("in a dry run asks X nothing and writes nothing: the follower refresh, the post search and people posts", async () => {
    const db = await fresh();
    const x = fakeX();
    const followers = await asProcess(
      db,
      x,
      FollowerSource.use(
        (source) => source.readByIds?.(range(1, 3)) ?? Effect.die("no batch"),
      ),
      FollowerSource.xApi,
      dryRun,
    );
    // Each id is left unasked, with why.
    expect(
      Exit.isSuccess(followers)
        ? [...followers.value.values()].map((read) =>
            "reason" in read ? read.reason : "read",
          )
        : "failed",
    ).toEqual([dryRunReason, dryRunReason, dryRunReason]);
    expect(outcome(await asProcess(db, x, search, Layer.empty, dryRun))).toBe(
      dryRunReason,
    );
    const posts = await asProcess(
      db,
      x,
      XPostsSource.use((source) => source.posts(["101"])),
      XPostsSource.xApi(),
      dryRun,
    );
    expect(outcome(posts)).toBe(dryRunReason);
    // A dry run still says what the day has spent.
    expect(
      await Effect.runPromise(
        spent.pipe(
          Effect.provide(dryRun(sqlLayer(db))),
          Effect.provide(clockAt(midday)),
        ),
      ),
    ).toBe(0);
    expect(x.asked).toEqual([]);
    expect(await recorded(db)).toEqual({});
    expect(await open(db)).toEqual([]);
  });
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
        await db.exec(
          `REVOKE ALL ON public.x_reads, public.x_holds FROM ${role}`,
        );
      }
      const statement = xReads.at(-1) ?? "";
      expect(statement).toContain("DO $grant$");
      await db.exec(statement);
      /** What `role` holds on `table`, as `column privilege` lines. */
      const held = async (role: string, table: string) =>
        (
          await db.query<{ grant: string }>(
            `SELECT column_name || ' ' || lower(privilege_type) AS grant
             FROM information_schema.column_privileges
             WHERE grantee = $1 AND table_schema = 'public' AND table_name = $2
             ORDER BY 1`,
            [role, table],
          )
        ).rows.map(({ grant }) => grant);
      for (const table of ["x_holds", "x_reads"]) {
        const listed = SITE_SYNC_GRANTS[table] ?? {};
        expect(await held("site_sync", table)).toEqual(
          [
            ...(listed.select ?? []).map((column) => `${column} select`),
            ...(listed.insert ?? []).map((column) => `${column} insert`),
            ...(listed.update ?? []).map((column) => `${column} update`),
          ].toSorted(),
        );
        expect(await held("studio", table)).toEqual([]);
      }
      expect(STUDIO_GRANTS["public.x_holds"]).toEqual({
        select: true,
        insert: ["day", "mills"],
        update: ["settled"],
      });
      expect(STUDIO_GRANTS["public.x_reads"]).toEqual({
        select: true,
        insert: ["day", "kind", "id"],
      });
    },
  );
});
