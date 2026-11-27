import { describe, expect, test } from "bun:test";
import { searchOf } from "../src/search/bindings.ts";
import {
  type BudgetState,
  type DayCounts,
  QUERIES_IN_WINDOW,
  SearchBudget,
  secondsUntilRoom,
  take,
  type Taken,
  takePath,
  used,
  WINDOW_DAYS,
} from "../src/search/budget.ts";
import {
  pageKey,
  pagePath,
  type Passage,
  resultsMarkdown,
  type SearchOptions,
  searchPath,
  searchRequest,
} from "../src/search/route.ts";

/**
 * Search for agents (src/search/): the budget that caps it under AI
 * Search's included queries, the route that answers it, and the bindings
 * prod gives it.
 */

const at = (day: string, time = "12:00:00") => Date.parse(`${day}T${time}Z`);

/** Storage that keeps what it is given, as a Durable Object's does. */
const memory = (): BudgetState & { readonly held: Map<string, unknown> } => {
  const held = new Map<string, unknown>();
  return {
    held,
    storage: {
      get: async <T>(key: string) => held.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        held.set(key, structuredClone(value));
      },
    },
  };
};

const takeFrom = async (budget: SearchBudget): Promise<Taken> =>
  (await (
    await budget.fetch(
      new Request(`https://budget${takePath}`, { method: "POST" }),
    )
  ).json()) as Taken;

describe("the search budget", () => {
  test("stays under the included 1,000 searches, over a window longer than any billing period", () => {
    expect(QUERIES_IN_WINDOW).toBe(900);
    expect(WINDOW_DAYS).toBe(32);
  });

  test("takes searches up to its limit, and refuses the next", () => {
    let counts: DayCounts = {};
    for (let n = 1; n <= 3; n++) {
      const result = take(counts, at("2026-12-10"), 3);
      expect(result.taken).toEqual({ ok: true, used: n, limit: 3 });
      counts = result.counts;
    }
    const refused = take(counts, at("2026-12-10"), 3);
    expect(refused.taken.ok).toBe(false);
    expect(refused.counts).toEqual({ "2026-12-10": 3 });
  });

  test("counts every day of the window, today and the 31 before it", () => {
    const counts = { "2026-11-08": 5, "2026-11-09": 7, "2026-12-10": 1 };
    expect(used(counts, at("2026-12-10"))).toBe(8);
    expect(used(counts, at("2026-12-11"))).toBe(1);
  });

  test("frees a day's searches once that day leaves the window", () => {
    const full = { "2026-11-01": 2, "2026-11-20": 1 };
    expect(take(full, at("2026-12-02"), 3).taken.ok).toBe(false);
    // Nov 1 leaves the window at the start of Dec 3, and its days go.
    const next = take(full, at("2026-12-03", "00:00:01"), 3);
    expect(next.taken).toEqual({ ok: true, used: 2, limit: 3 });
    expect(next.counts).toEqual({ "2026-11-20": 1, "2026-12-03": 1 });
  });

  test("says how long until there's room: the midnight the oldest full day leaves", () => {
    const full = { "2026-11-01": 2, "2026-11-20": 1 };
    // From noon Dec 2 to midnight Dec 3.
    expect(secondsUntilRoom(full, at("2026-12-02"), 3)).toBe(12 * 3600);
    // Nov 20 alone is still a full window of 1: room once it leaves too.
    expect(secondsUntilRoom({ "2026-11-20": 1 }, at("2026-12-02"), 1)).toBe(
      (12 + 19 * 24) * 3600,
    );
  });

  test("never lets one billing period of 31 days hold more than its limit", () => {
    // A search an hour, every hour, for 70 days; whatever day the billing
    // period starts on, no 31 days hold more than the limit.
    let counts: DayCounts = {};
    const taken: Array<number> = [];
    const start = at("2026-12-01", "00:30:00");
    for (let hour = 0; hour < 70 * 24; hour++) {
      const now = start + hour * 3600 * 1000;
      const result = take(counts, now, 100);
      if (result.taken.ok) taken.push(now);
      counts = result.counts;
    }
    for (const from of taken) {
      const period = taken.filter(
        (time) => time >= from && time < from + 31 * 24 * 3600 * 1000,
      );
      expect(period.length).toBeLessThanOrEqual(100);
    }
    expect(taken.length).toBeGreaterThan(100);
  });

  test("the object answers its 901st search in a window with a refusal, and keeps its count", async () => {
    const state = memory();
    const now = () => at("2026-12-10");
    const budget = new SearchBudget(state, {}, now, 900);
    for (let n = 1; n <= 900; n++) {
      expect((await takeFrom(budget)).ok).toBe(true);
    }
    const refused = await takeFrom(budget);
    expect(refused).toEqual({
      ok: false,
      used: 900,
      limit: 900,
      retryAfter: 31 * 24 * 3600 + 12 * 3600,
    });
    // A new object on the same storage, as after an eviction, still refuses.
    expect((await takeFrom(new SearchBudget(state, {}, now, 900))).ok).toBe(
      false,
    );
    expect(state.held.get("queries")).toEqual({ "2026-12-10": 900 });
  });

  test("the object answers only its one path", async () => {
    const budget = new SearchBudget(memory());
    const get = await budget.fetch(new Request(`https://budget${takePath}`));
    expect(get.status).toBe(404);
    const other = await budget.fetch(
      new Request("https://budget/other", { method: "POST" }),
    );
    expect(other.status).toBe(404);
  });
});

const passage = (key: string, score: number, text: string): Passage => ({
  item: { key },
  score,
  text,
});

/**
 * The route with an index that records what it was asked, a budget of
 * `limit`, and a rate limit that lets `rate` searches through.
 */
const route = (
  limit = 900,
  passages: ReadonlyArray<Passage> = [
    passage("effect.md", 0.91234, "State of Effect 2026, at /effect."),
  ],
  rate = Number.POSITIVE_INFINITY,
) => {
  const asked: Array<string> = [];
  const clients: Array<string> = [];
  let taken = 0;
  const options: SearchOptions = {
    allow: async (client) => {
      clients.push(client);
      return clients.length <= rate;
    },
    origin: "https://allthings.dev",
    index: {
      search: async ({ query }) => {
        asked.push(query);
        return { chunks: passages };
      },
    },
    take: async () =>
      taken < limit
        ? { ok: true, used: ++taken, limit }
        : { ok: false, used: taken, limit, retryAfter: 7200 },
  };
  return { asked, clients, options, taken: () => taken };
};

/** A QUERY body that arrives in pieces, with no length said up front. */
const streamed = (...pieces: ReadonlyArray<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  });

const endpoint = `https://allthings.dev${searchPath}`;

describe("the search route", () => {
  test("is the well-known path Cloudflare's guide names", () => {
    expect(searchPath).toBe("/.well-known/search");
  });

  test("searches for a GET's q, and answers Markdown under each page's address", async () => {
    const { asked, options } = route();
    const response = await searchRequest(
      new Request(`${endpoint}?q=${encodeURIComponent("effect  talks")}`),
      options,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-query")).toBe(
      "text/plain, application/json",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
    );
    expect(asked).toEqual(["effect talks"]);
    expect(await response.text()).toBe(
      '# Search results for: "effect talks"\n\n## https://allthings.dev/effect (score: 0.912)\n\nState of Effect 2026, at /effect.\n',
    );
  });

  test("searches for a QUERY's text, or its JSON's q", async () => {
    const { asked, options } = route();
    const text = await searchRequest(
      new Request(endpoint, {
        method: "QUERY",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "who hosts",
      }),
      options,
    );
    expect(text.status).toBe(200);
    const json = await searchRequest(
      new Request(endpoint, {
        method: "QUERY",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: "react native" }),
      }),
      options,
    );
    expect(json.status).toBe(200);
    expect(asked).toEqual(["who hosts", "react native"]);
  });

  test("refuses what it can't search before counting it", async () => {
    const { asked, options, taken } = route();
    const statuses = await Promise.all(
      [
        new Request(endpoint),
        new Request(`${endpoint}?q=%20%20`),
        new Request(`${endpoint}?q=${"a".repeat(501)}`),
        new Request(endpoint, { method: "POST", body: "effect" }),
        new Request(endpoint, { method: "HEAD" }),
        new Request(endpoint, {
          method: "QUERY",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        new Request(endpoint, {
          method: "QUERY",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "effect" }),
        }),
        new Request(endpoint, {
          method: "QUERY",
          headers: { "content-type": "text/html" },
          body: "<p>effect</p>",
        }),
        new Request(endpoint, {
          method: "QUERY",
          headers: { "content-type": "text/plain" },
          body: "a".repeat(5000),
        }),
      ].map(async (request) => (await searchRequest(request, options)).status),
    );
    expect(statuses).toEqual([400, 400, 400, 405, 405, 400, 400, 415, 413]);
    expect(taken()).toBe(0);
    expect(asked).toEqual([]);
  });

  test("says which methods search", async () => {
    const response = await searchRequest(
      new Request(endpoint, { method: "POST", body: "effect" }),
      route().options,
    );
    expect(response.headers.get("allow")).toBe("GET, QUERY");
  });

  test("answers 503 past its budget, without asking the index", async () => {
    const { asked, options } = route(1);
    expect(
      (await searchRequest(new Request(`${endpoint}?q=one`), options)).status,
    ).toBe(200);
    const refused = await searchRequest(
      new Request(`${endpoint}?q=two`),
      options,
    );
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("7200");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.text()).toContain(
      "at most 1 searches in any 32 UTC days (today and the 31 before it)",
    );
    expect(asked).toEqual(["one"]);
  });

  test("reads a QUERY body no further than its limit, whatever it says of its length", async () => {
    const { asked, options, taken } = route();
    const piece = new TextEncoder().encode("a".repeat(1_500));
    const long = await searchRequest(
      new Request(endpoint, {
        method: "QUERY",
        headers: { "content-type": "text/plain" },
        body: streamed(piece, piece, piece),
      }),
      options,
    );
    expect(long.status).toBe(413);
    const fits = await searchRequest(
      new Request(endpoint, {
        method: "QUERY",
        headers: { "content-type": "text/plain" },
        body: streamed(new TextEncoder().encode("effect "), piece.slice(0, 3)),
      }),
      options,
    );
    expect(fits.status).toBe(200);
    const notUtf8 = await searchRequest(
      new Request(endpoint, {
        method: "QUERY",
        headers: { "content-type": "text/plain" },
        body: streamed(new Uint8Array([0x65, 0xff, 0x66])),
      }),
      options,
    );
    expect(notUtf8.status).toBe(400);
    expect(taken()).toBe(1);
    expect(asked).toEqual(["effect aaa"]);
  });

  test("answers 429 past an address's rate, before counting it or asking the index", async () => {
    const { asked, clients, options, taken } = route(900, undefined, 1);
    const from = (address: string) =>
      new Request(`${endpoint}?q=effect`, {
        headers: { "cf-connecting-ip": address },
      });
    expect((await searchRequest(from("192.0.2.1"), options)).status).toBe(200);
    const limited = await searchRequest(from("192.0.2.1"), options);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(await limited.text()).toContain("10 times a minute");
    expect(clients).toEqual(["192.0.2.1", "192.0.2.1"]);
    expect(taken()).toBe(1);
    expect(asked).toEqual(["effect"]);
  });

  test("answers 503 when the rate limit can't be read, before counting it", async () => {
    const { asked, options, taken } = route();
    const response = await searchRequest(new Request(`${endpoint}?q=effect`), {
      ...options,
      allow: async () => {
        throw new Error("the limiter is unreachable");
      },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(taken()).toBe(0);
    expect(asked).toEqual([]);
  });

  test("answers 503 when the budget can't be read, without asking the index", async () => {
    const { asked, options } = route();
    const response = await searchRequest(new Request(`${endpoint}?q=effect`), {
      ...options,
      take: async () => {
        throw new Error("the object is unreachable");
      },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(asked).toEqual([]);
  });

  test("answers 502, never stored, when the index fails", async () => {
    const { options } = route();
    const response = await searchRequest(new Request(`${endpoint}?q=effect`), {
      ...options,
      index: {
        search: async () => {
          throw new Error("down");
        },
      },
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("says so when nothing matches", () => {
    expect(resultsMarkdown("nothing", [], "https://allthings.dev")).toBe(
      '# Search results for: "nothing"\n\nNothing on allthings.dev matches.\n',
    );
  });

  test("separates passages, best first as the index ranks them", () => {
    expect(
      resultsMarkdown(
        "people",
        [
          passage("people.md", 0.8, "Organizers."),
          passage("index.md", 0.5, "Next."),
        ],
        "https://allthings.dev",
      ),
    ).toBe(
      '# Search results for: "people"\n\n## https://allthings.dev/people (score: 0.800)\n\nOrganizers.\n\n---\n\n## https://allthings.dev/ (score: 0.500)\n\nNext.\n',
    );
  });

  test("names each page's item by its path, and back", () => {
    for (const path of [
      "/",
      "/effect",
      "/people/erik-thorelli",
      "/year/2025",
    ]) {
      expect(pagePath(pageKey(path))).toBe(path);
    }
    expect(pageKey("/")).toBe("index.md");
    expect(pageKey("/people/erik-thorelli")).toBe("people/erik-thorelli.md");
  });
});

describe("the search's bindings", () => {
  const namespace = {
    get: (instance: string) => ({
      search: async () => ({
        chunks: [passage(`${instance}.md`, 1, "found")],
      }),
    }),
  };
  /** A rate limit that records the keys it was asked for, letting all through. */
  const keys: Array<string> = [];
  const limit = {
    limit: async ({ key }: { readonly key: string }) => {
      keys.push(key);
      return { success: true };
    },
  };
  /** A Durable Object namespace whose one object is `budget`. */
  const objects = (budget: SearchBudget) => ({
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (url: string, init: RequestInit) => {
        expect(id).toBe("site");
        return budget.fetch(new Request(url, init));
      },
    }),
  });

  test("are there only with the namespace, the instance, the budget and the rate limit", () => {
    const all = {
      SEARCH: namespace,
      SEARCH_INSTANCE: "pages",
      SEARCH_BUDGET: objects(new SearchBudget(memory())),
      SEARCH_LIMIT: limit,
    };
    expect(searchOf(all)).toBeDefined();
    expect(searchOf({})).toBeUndefined();
    expect(searchOf({ ...all, SEARCH_INSTANCE: "" })).toBeUndefined();
    for (const name of Object.keys(all)) {
      const { [name as keyof typeof all]: _left, ...rest } = all;
      expect(searchOf(rest)).toBeUndefined();
    }
  });

  test("limit each address by its own key", async () => {
    const search = searchOf({
      SEARCH: namespace,
      SEARCH_INSTANCE: "pages",
      SEARCH_BUDGET: objects(new SearchBudget(memory())),
      SEARCH_LIMIT: limit,
    });
    expect(await search?.allow("192.0.2.7")).toBe(true);
    expect(keys.at(-1)).toBe("search:192.0.2.7");
  });

  test("search the named instance, and take every search from the one object", async () => {
    const search = searchOf({
      SEARCH: namespace,
      SEARCH_INSTANCE: "pages",
      SEARCH_BUDGET: objects(
        new SearchBudget(memory(), {}, () => at("2026-12-10"), 1),
      ),
      SEARCH_LIMIT: limit,
    });
    expect(
      (await search?.index.search({ query: "x" }))?.chunks[0]?.item.key,
    ).toBe("pages.md");
    expect(await search?.take()).toEqual({ ok: true, used: 1, limit: 1 });
    expect((await search?.take())?.ok).toBe(false);
  });

  test("fail a take when the object doesn't answer 200", async () => {
    const search = searchOf({
      SEARCH: namespace,
      SEARCH_INSTANCE: "pages",
      SEARCH_BUDGET: {
        idFromName: () => "site",
        get: () => ({
          fetch: async () => new Response("overloaded", { status: 503 }),
        }),
      },
      SEARCH_LIMIT: limit,
    });
    await expect(search?.take() ?? Promise.resolve()).rejects.toThrow(
      "the search budget answered 503",
    );
  });
});
