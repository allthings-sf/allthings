import { describe, expect, test } from "bun:test";
import { ogCards } from "../src/og/cards.ts";
import { lockup, Metadata } from "../src/pages/metadata.tsx";
import type { PrewarmReport } from "../src/prewarm.ts";
import {
  type Indexing,
  indexingOf,
  type Items,
} from "../src/search/bindings.ts";
import type { BudgetState } from "../src/search/budget.ts";
import { agentFrontMatter } from "../src/search/discovery.ts";
import { cut, decode, pageDocument } from "../src/search/document.ts";
import { indexPages, withIndex } from "../src/search/ingest.ts";
import {
  INGEST_BYTES_IN_WINDOW,
  type Indexed,
  leaseMs,
  ledgerAnswer,
  plan,
  planPath,
  recordPath,
} from "../src/search/ledger.ts";
import { objectAnswer } from "../src/search/object.ts";

/**
 * Indexing the site for search (src/search/ingest.ts): each page as
 * Markdown, only what changed uploaded, within what the object lets it
 * ingest (ledger.ts), and what left the site removed; and how the pages
 * tell agents where to search.
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

describe("a page as the search indexes it", () => {
  const page = `<!doctype html><html><head><title>allthings/effect &amp; friends</title>
<meta name="description" content="An evening of &quot;Effect&quot;."></head>
<body><nav><a href="/">home</a></nav>
<main id="main"><h1>allthings/<span>effect</span></h1>
<svg><text>a drawing</text></svg>
<p>When <time>Wed Sep 30, 2026</time> at <a href="/x">CodeRabbit</a>.</p>
<ul><li><div>Michael Arnaldi</div><span>Founder &amp; CEO</span></li><li>Mirela&nbsp;Prifti</li></ul>
<h2>On stage</h2><p hidden>a draft</p><p aria-hidden="true">_</p>
<script>alert(1)</script><p>&#x1F440; &#8212; done</p></main>
<footer>signed off</footer></body></html>`;

  test("is its title, address and description, then the text of its main, block by block", async () => {
    expect(await pageDocument(page, "https://allthings.dev/effect")).toBe(
      [
        "# allthings/effect & friends",
        "",
        "https://allthings.dev/effect",
        "",
        'An evening of "Effect".',
        "",
        "## allthings/ effect",
        "",
        "When",
        "Wed Sep 30, 2026 at CodeRabbit.",
        "",
        "- Michael Arnaldi Founder & CEO",
        "- Mirela Prifti",
        "",
        "### On stage",
        "",
        "👀 — done",
        "",
      ].join("\n"),
    );
  });

  test("leaves out everything outside main, and what a reader doesn't read", async () => {
    const lines = (
      (await pageDocument(page, "https://allthings.dev/effect")) ?? ""
    ).split("\n");
    for (const absent of [
      "home",
      "signed off",
      "a drawing",
      "a draft",
      "alert(1)",
      "_",
    ]) {
      expect(
        lines.some(
          (line) =>
            line.includes(absent) && line !== "# allthings/effect & friends",
        ),
      ).toBe(false);
    }
  });

  test("reads past a void element it leaves out, as an <img aria-hidden>", async () => {
    expect(
      await pageDocument(
        '<main><img aria-hidden="true" alt=""><br hidden><p>Visible</p></main>',
        "https://allthings.dev/x",
      ),
    ).toBe("https://allthings.dev/x\n\nVisible\n");
  });

  test("is nothing for a page with no main", async () => {
    expect(
      await pageDocument(
        "<html><body><p>hi</p></body></html>",
        "https://allthings.dev/x",
      ),
    ).toBeUndefined();
  });

  test("reads character references, and leaves what isn't one", () => {
    expect(decode("&amp; &lt;&gt; &#39; &#x41; &copy;")).toBe(
      "& <> ' A &copy;",
    );
  });

  test("is cut at its limit, at a character's end", () => {
    expect(cut("aé", 2)).toBe("a");
    expect(
      new TextEncoder().encode(cut("é".repeat(40_000))).byteLength,
    ).toBeLessThanOrEqual(65_536);
    expect(cut("short")).toBe("short");
  });
});

describe("what indexing may ingest", () => {
  test("stays under the included 5,000,000 tokens, a byte for every token it could be billed", () => {
    expect(INGEST_BYTES_IN_WINDOW).toBe(4_000_000);
  });

  const page = (key: string, hash: string, bytes: number) => ({
    key,
    hash,
    bytes,
  });

  test("lets a changed page through while there's room, counted on its day, and leaves an unchanged one", () => {
    const indexed: Indexed = { "a.md": { hash: "1", id: "item-a" } };
    const { planned, ingested } = plan(
      { "2026-12-01": 50 },
      indexed,
      [page("a.md", "1", 10), page("b.md", "2", 30), page("c.md", "3", 30)],
      false,
      at("2026-12-10"),
      100,
    );
    expect(planned).toEqual({
      upload: ["b.md"],
      previous: [],
      refused: ["c.md"],
      unchanged: 1,
      remove: [],
      // a.md was uploaded as it is, but its indexing isn't confirmed yet.
      check: [{ key: "a.md", id: "item-a" }],
      used: 80,
      limit: 100,
    });
    expect(ingested).toEqual({ "2026-12-01": 50, "2026-12-10": 30 });
  });

  test("counts a run's bytes on the day its uploads can last be sent, so one crossing midnight counts on the day billed", () => {
    const { ingested } = plan(
      {},
      {},
      [page("a.md", "1", 10)],
      false,
      at("2026-12-10", "23:55:00"),
    );
    expect(ingested).toEqual({ "2026-12-11": 10 });
  });

  test("checks no page whose indexing Cloudflare has confirmed", () => {
    const { planned } = plan(
      {},
      { "a.md": { hash: "1", id: "item-a", settled: true } },
      [page("a.md", "1", 10)],
      false,
      at("2026-12-10"),
    );
    expect(planned.check).toEqual([]);
  });

  test("names the item a changed page was indexed as, to replace", () => {
    const { planned } = plan(
      {},
      { "a.md": { hash: "1", id: "item-a" } },
      [page("a.md", "2", 10)],
      false,
      at("2026-12-10"),
    );
    expect(planned.previous).toEqual([{ key: "a.md", id: "item-a" }]);
  });

  test("removes what the site no longer lists, only after a complete run", () => {
    const indexed: Indexed = {
      "a.md": { hash: "1", id: "item-a" },
      "gone.md": { hash: "9", id: "item-gone" },
    };
    const pages = [page("a.md", "1", 10)];
    expect(
      plan({}, indexed, pages, false, at("2026-12-10")).planned.remove,
    ).toEqual([]);
    expect(
      plan({}, indexed, pages, true, at("2026-12-10")).planned.remove,
    ).toEqual([{ key: "gone.md", id: "item-gone" }]);
  });

  test("frees a day's bytes once it leaves the window", () => {
    const full = { "2026-11-01": 100 };
    expect(
      plan(full, {}, [page("a.md", "1", 1)], false, at("2026-12-02"), 100)
        .planned.upload,
    ).toEqual([]);
    const later = plan(
      full,
      {},
      [page("a.md", "1", 1)],
      false,
      at("2026-12-03"),
      100,
    );
    expect(later.planned.upload).toEqual(["a.md"]);
    expect(later.ingested).toEqual({ "2026-12-03": 1 });
  });

  test("the object keeps the bytes it lets through, and what was indexed", async () => {
    const state = memory();
    const post = (path: string, body: unknown) =>
      objectAnswer(
        state,
        new Request(`https://budget${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    const first = await (
      await post(planPath, {
        run: "r1",
        pages: [page("a.md", "1", 10)],
        complete: true,
      })
    ).json();
    expect(first).toMatchObject({ upload: ["a.md"], used: 10 });
    await post(recordPath, {
      run: "r1",
      uploaded: [{ key: "a.md", hash: "1", id: "item-a" }],
      removed: [],
    });
    const again = await (
      await post(planPath, {
        run: "r2",
        pages: [page("a.md", "1", 10)],
        complete: true,
      })
    ).json();
    expect(again).toMatchObject({ upload: [], unchanged: 1, used: 10 });
    expect(state.held.get("indexed")).toEqual({
      "a.md": { hash: "1", id: "item-a" },
    });
  });

  test("the object refuses what isn't a plan or a record", async () => {
    const state = memory();
    const statuses = await Promise.all(
      [
        [planPath, "not json"],
        [planPath, JSON.stringify({ pages: [], complete: true })],
        [
          planPath,
          JSON.stringify({
            run: "r",
            pages: [{ key: "a.md" }],
            complete: true,
          }),
        ],
        [planPath, JSON.stringify({ run: "r", pages: [], complete: "yes" })],
        [
          recordPath,
          JSON.stringify({
            run: "r",
            uploaded: [{ key: "a.md" }],
            removed: [],
          }),
        ],
        [
          recordPath,
          JSON.stringify({ run: "r", uploaded: [], removed: ["a.md"] }),
        ],
      ].map(
        async ([path, body]) =>
          (
            await objectAnswer(
              state,
              new Request(`https://budget${path}`, { method: "POST", body }),
            )
          ).status,
      ),
    );
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400]);
    expect(state.held.size).toBe(0);
  });

  const post = (state: BudgetState, path: string, body: unknown) =>
    objectAnswer(
      state,
      new Request(`https://budget${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

  test("the object lets one run index at a time: another's plan is busy until the first records", async () => {
    const state = memory();
    const pages = [page("a.md", "1", 10)];
    expect(
      await (
        await post(state, planPath, { run: "r1", pages, complete: true })
      ).json(),
    ).toMatchObject({ upload: ["a.md"] });
    expect(
      await (
        await post(state, planPath, { run: "r2", pages, complete: true })
      ).json(),
    ).toMatchObject({ busy: true, upload: [], remove: [] });
    // A record from a run that doesn't hold the index is refused.
    expect(
      (await post(state, recordPath, { run: "r2", uploaded: [], removed: [] }))
        .status,
    ).toBe(409);
    await post(state, recordPath, {
      run: "r1",
      uploaded: [{ key: "a.md", hash: "1", id: "item-a" }],
      removed: [],
    });
    expect(
      await (
        await post(state, planPath, { run: "r2", pages, complete: true })
      ).json(),
    ).toMatchObject({ unchanged: 1 });
  });

  test("the object lets a run's hold go once it's past its time", async () => {
    let clock = Date.parse("2026-12-10T12:00:00Z");
    const state = memory();
    const planFor = (run: string) =>
      ledgerAnswer(
        state,
        new Request(`https://budget${planPath}`, {
          method: "POST",
          body: JSON.stringify({ run, pages: [], complete: false }),
        }),
        () => clock,
      ).then((response) => response.json());
    await planFor("r1");
    expect(await planFor("r2")).toMatchObject({ busy: true });
    clock += leaseMs + 1;
    expect(await planFor("r2")).not.toHaveProperty("busy");
  });

  test("the object forgets a removed page only if its item is the one removed", async () => {
    const state = memory();
    await post(state, planPath, { run: "r1", pages: [], complete: false });
    await post(state, recordPath, {
      run: "r1",
      uploaded: [
        { key: "a.md", hash: "1", id: "item-new" },
        { key: "b.md", hash: "2", id: "item-b" },
      ],
      removed: [],
    });
    await post(state, planPath, { run: "r2", pages: [], complete: false });
    await post(state, recordPath, {
      run: "r2",
      uploaded: [],
      removed: [
        { key: "a.md", id: "item-old" },
        { key: "b.md", id: "item-b" },
      ],
    });
    expect(state.held.get("indexed")).toEqual({
      "a.md": { hash: "1", id: "item-new" },
    });
  });
});

/**
 * An index's items, kept in memory, one a key as Cloudflare keeps them: an
 * upload of a key it holds replaces its item under a new id, or, with
 * `refuse`, is refused.
 */
const itemsIn = (refuse = false) => {
  const items = new Map<string, { key: string; markdown: string }>();
  /** How each item's indexing went, by id: completed unless set. */
  const statuses = new Map<string, string>();
  let made = 0;
  const api: Items = {
    get: (id) => ({
      info: async () => {
        if (!items.has(id)) throw new Error(`no item ${id}`);
        return { status: statuses.get(id) ?? "completed" };
      },
    }),
    upload: async (key, markdown) => {
      const held = [...items].find(([, item]) => item.key === key);
      if (held !== undefined) {
        if (refuse) throw new Error(`${key} exists`);
        items.delete(held[0]);
      }
      made += 1;
      const id = `item-${made}`;
      items.set(id, { key, markdown });
      return { id, key };
    },
    delete: async (id) => {
      if (!items.delete(id)) throw new Error(`no item ${id}`);
    },
  };
  return {
    api,
    items,
    statuses,
    keys: () => [...items.values()].map(({ key }) => key).toSorted(),
    idOf: (key: string) =>
      [...items].find(([, item]) => item.key === key)?.[0] ?? "",
  };
};

/** Indexing over `items` and an object on `state`. */
const indexingWith = (
  items: Items,
  state: BudgetState,
  limit?: number,
): Indexing => {
  const post = async (path: string, body: unknown) =>
    (
      await objectAnswer(
        state,
        new Request(`https://budget${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      )
    ).json();
  return {
    items,
    plan: async (run, pages, complete) => {
      const planned = (await post(planPath, {
        run,
        pages,
        complete,
      })) as Awaited<ReturnType<Indexing["plan"]>>;
      // A low limit stands in for a window that's nearly full.
      return limit === undefined
        ? planned
        : {
            ...planned,
            upload: planned.upload.filter((_, index) => index < limit),
            refused: [...planned.refused, ...planned.upload.slice(limit)],
          };
    },
    record: async (run, uploaded, removed, settled) => {
      await post(recordPath, { run, uploaded, removed, settled });
    },
  };
};

describe("indexing the site's pages", () => {
  const documents = (entries: Record<string, string>) =>
    new Map(Object.entries(entries));

  test("uploads every page the first time, then only what changed, one item each", async () => {
    const { api, items, keys } = itemsIn();
    const state = memory();
    const indexing = indexingWith(api, state);
    const first = await indexPages(
      documents({
        "/": "# home",
        "/effect": "# effect",
        "/people/erik": "# erik",
      }),
      true,
      indexing,
    );
    expect(first).toMatchObject({
      uploaded: 3,
      unchanged: 0,
      removed: 0,
      failed: [],
    });
    expect(keys()).toEqual(["effect.md", "index.md", "people/erik.md"]);
    const second = await indexPages(
      documents({
        "/": "# home",
        "/effect": "# effect, changed",
        "/people/erik": "# erik",
      }),
      true,
      indexing,
    );
    expect(second).toMatchObject({ uploaded: 1, unchanged: 2, removed: 0 });
    // The changed page's old item is gone: one item a page.
    expect(keys()).toEqual(["effect.md", "index.md", "people/erik.md"]);
    expect(
      [...items.values()].find(({ key }) => key === "effect.md")?.markdown,
    ).toBe("# effect, changed");
  });

  test("removes a page the site took down, once a run is complete", async () => {
    const { api, keys } = itemsIn();
    const indexing = indexingWith(api, memory());
    await indexPages(
      documents({ "/": "# home", "/people/gone": "# gone" }),
      true,
      indexing,
    );
    await indexPages(documents({ "/": "# home" }), false, indexing);
    expect(keys()).toEqual(["index.md", "people/gone.md"]);
    const run = await indexPages(documents({ "/": "# home" }), true, indexing);
    expect(run.removed).toBe(1);
    expect(keys()).toEqual(["index.md"]);
  });

  test("leaves a page the window has no room for to a later run, and counts what it let through", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    const run = await indexPages(
      documents({ "/": "# home", "/effect": "# effect" }),
      true,
      indexingWith(api, state, 1),
    );
    expect(run).toMatchObject({ uploaded: 1, refused: 1 });
    expect(keys()).toHaveLength(1);
    const later = await indexPages(
      documents({ "/": "# home", "/effect": "# effect" }),
      true,
      indexingWith(api, state),
    );
    expect(later).toMatchObject({ uploaded: 1, unchanged: 1 });
  });

  test("lets a changed page's old item go when the upload is refused, and uploads it anew next run, counted again", async () => {
    const { api, items, keys } = itemsIn(true);
    const state = memory();
    const indexing = indexingWith(api, state);
    await indexPages(documents({ "/": "# home" }), true, indexing);
    const refused = await indexPages(
      documents({ "/": "# home, changed" }),
      true,
      indexing,
    );
    expect(refused).toMatchObject({ uploaded: 0, failed: ["index.md"] });
    expect(keys()).toEqual([]);
    const anew = await indexPages(
      documents({ "/": "# home, changed" }),
      true,
      indexing,
    );
    expect(anew).toMatchObject({ uploaded: 1, unchanged: 0 });
    expect([...items.values()]).toEqual([
      { key: "index.md", markdown: "# home, changed" },
    ]);
    // Each upload was counted: three of the home page's sizes.
    expect(anew.used).toBe(
      new TextEncoder().encode("# home").byteLength +
        2 * new TextEncoder().encode("# home, changed").byteLength,
    );
  });

  test("confirms on the next run that Cloudflare indexed each upload, then checks it no more", async () => {
    const { api } = itemsIn();
    const state = memory();
    const indexing = indexingWith(api, state);
    await indexPages(documents({ "/": "# home" }), true, indexing);
    const next = await indexPages(documents({ "/": "# home" }), true, indexing);
    expect(next).toMatchObject({ uploaded: 0, unchanged: 1, settled: 1 });
    const after = await indexPages(
      documents({ "/": "# home" }),
      true,
      indexing,
    );
    expect(after).toMatchObject({ unchanged: 1, settled: 0 });
  });

  test("uploads a page again, counted again, when Cloudflare failed to index it", async () => {
    const { api, statuses, keys, idOf } = itemsIn();
    const state = memory();
    const indexing = indexingWith(api, state);
    await indexPages(documents({ "/": "# home" }), true, indexing);
    statuses.set(idOf("index.md"), "error");
    const found = await indexPages(
      documents({ "/": "# home" }),
      true,
      indexing,
    );
    expect(found).toMatchObject({ unindexed: 1, removed: 0, uploaded: 0 });
    expect(keys()).toEqual([]);
    const again = await indexPages(
      documents({ "/": "# home" }),
      true,
      indexing,
    );
    expect(again).toMatchObject({ uploaded: 1 });
    expect(keys()).toEqual(["index.md"]);
    expect(again.used).toBe(2 * new TextEncoder().encode("# home").byteLength);
  });

  test("asks again next run about a page still queued", async () => {
    const { api, statuses, idOf } = itemsIn();
    const state = memory();
    const indexing = indexingWith(api, state);
    await indexPages(documents({ "/": "# home" }), true, indexing);
    statuses.set(idOf("index.md"), "queued");
    expect(
      await indexPages(documents({ "/": "# home" }), true, indexing),
    ).toMatchObject({ settled: 0, unindexed: 0, uploaded: 0 });
    statuses.delete(idOf("index.md"));
    expect(
      await indexPages(documents({ "/": "# home" }), true, indexing),
    ).toMatchObject({ settled: 1 });
  });

  test("does nothing while another prewarm is indexing", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    await ledgerAnswer(
      state,
      new Request(`https://budget${planPath}`, {
        method: "POST",
        body: JSON.stringify({ run: "other", pages: [], complete: false }),
      }),
    );
    const run = await indexPages(
      documents({ "/": "# home" }),
      true,
      indexingWith(api, state),
    );
    expect(run).toMatchObject({ busy: true, uploaded: 0 });
    expect(keys()).toEqual([]);
  });

  test("tries a page whose upload failed again next run, and doesn't record it", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    let fail = true;
    const flaky: Items = {
      ...api,
      upload: async (key, markdown) => {
        if (fail) throw new Error("upload refused");
        return api.upload(key, markdown);
      },
    };
    const run = await indexPages(
      documents({ "/": "# home" }),
      true,
      indexingWith(flaky, state),
    );
    expect(run.failed).toEqual(["index.md"]);
    fail = false;
    const retried = await indexPages(
      documents({ "/": "# home" }),
      true,
      indexingWith(flaky, state),
    );
    expect(retried.uploaded).toBe(1);
    expect(keys()).toEqual(["index.md"]);
  });
});

describe("a prewarm that indexes", () => {
  const report: PrewarmReport = {
    build: "b1",
    paths: 3,
    kept: 2,
    built: 1,
    passed: 0,
    unreachable: 0,
    failed: [],
    sitemapRead: true,
    waitedMs: 0,
  };
  const html = (title: string) =>
    `<html><head><title>${title}</title></head><body><main><p>${title}</p></main></body></html>`;

  test("is the prewarm alone where the Worker has no index", async () => {
    let handed: unknown = "unset";
    const result = await withIndex({}, async (onPage) => {
      handed = onPage;
      return report;
    });
    expect(handed).toBeUndefined();
    expect(result).toEqual(report);
  });

  test("indexes the pages the prewarm read, and says so in its report", async () => {
    const { api, items } = itemsIn();
    const state = memory();
    const env = {
      ORIGIN: "https://allthings.dev",
      SEARCH: {
        get: () => ({ search: async () => ({ chunks: [] }), items: api }),
      },
      SEARCH_INSTANCE: "pages",
      SEARCH_BUDGET: {
        idFromName: () => "site",
        get: () => ({
          fetch: (url: string, init: RequestInit) =>
            objectAnswer(state, new Request(url, init)),
        }),
      },
    };
    expect(indexingOf(env)).toBeDefined();
    const result = await withIndex(env, async (onPage) => {
      onPage?.("/sitemap.xml", "<urlset/>");
      onPage?.("/", html("allthings/_"));
      onPage?.("/about", html("about"));
      return report;
    });
    expect(result.search).toMatchObject({ uploaded: 2, failed: [] });
    expect([...items.values()].map(({ key }) => key).toSorted()).toEqual([
      "about.md",
      "index.md",
    ]);
    expect(
      [...items.values()].find(({ key }) => key === "about.md")?.markdown,
    ).toContain("https://allthings.dev/about");
  });

  test("removes nothing when a page couldn't be made into a document", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    const env = (object: BudgetState) => ({
      SEARCH: {
        get: () => ({ search: async () => ({ chunks: [] }), items: api }),
      },
      SEARCH_INSTANCE: "pages",
      SEARCH_BUDGET: {
        idFromName: () => "site",
        get: () => ({
          fetch: (url: string, init: RequestInit) =>
            objectAnswer(object, new Request(url, init)),
        }),
      },
    });
    await withIndex(env(state), async (onPage) => {
      onPage?.("/", html("home"));
      onPage?.("/about", html("about"));
      return report;
    });
    expect(keys()).toEqual(["about.md", "index.md"]);
    const result = await withIndex(
      env(state),
      async (onPage) => {
        onPage?.("/", html("home"));
        onPage?.("/about", html("about"));
        return report;
      },
      async (page, url) => {
        if (url.endsWith("/about")) throw new Error("couldn't read it");
        return pageDocument(page, url);
      },
    );
    expect(result.search).toMatchObject({ removed: 0 });
    expect(keys()).toEqual(["about.md", "index.md"]);
  });

  test("never fails the prewarm when indexing does", async () => {
    const env = {
      SEARCH: {
        get: () => ({
          search: async () => ({ chunks: [] }),
          items: itemsIn().api,
        }),
      },
      SEARCH_INSTANCE: "pages",
      SEARCH_BUDGET: {
        idFromName: () => "site",
        get: () => ({
          fetch: async () => new Response("down", { status: 503 }),
        }),
      },
    };
    const result = await withIndex(env, async (onPage) => {
      onPage?.("/", html("home"));
      return report;
    });
    expect(result).toMatchObject({
      ...report,
      search: { error: "the search budget answered 503" },
    });
  });
});

describe("where agents are told to search", () => {
  test("is the front matter every search answer starts with", () => {
    expect(agentFrontMatter("https://allthings.dev")).toStartWith(
      '---\nagent:\n  instructions: "Use this search API',
    );
    expect(agentFrontMatter("https://allthings.dev")).toContain(
      '  endpoint: "https://allthings.dev/.well-known/search?q={query}"\n  method: "GET"\n',
    );
  });

  test("is in every indexed page's head, and no page kept from search engines", async () => {
    const meta = {
      title: lockup("about"),
      description: "About.",
      path: "/about",
      image: ogCards.home,
    } as const;
    const indexed = await Metadata({
      meta,
      origin: "https://allthings.dev",
      theme: undefined,
    });
    expect(indexed).toContain(
      '<meta name="agent:endpoint" content="https://allthings.dev/.well-known/search?q={query}"/>',
    );
    expect(indexed).toContain('<meta name="agent:method" content="GET"/>');
    const hidden = await Metadata({
      meta: { ...meta, noindex: true },
      origin: "https://allthings.dev",
      theme: undefined,
    });
    expect(hidden).not.toContain("agent:");
  });
});
