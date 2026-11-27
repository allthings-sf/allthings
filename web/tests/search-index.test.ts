import { describe, expect, test } from "bun:test";
import type { PrewarmReport } from "../src/prewarm.ts";
import { indexingOf, type Items } from "../src/search/bindings.ts";
import { type BudgetState, used } from "../src/search/budget.ts";
import { cut, decode, pageDocument } from "../src/search/document.ts";
import {
  INGEST_BYTES_IN_WINDOW,
  indexSite,
  planIndex,
  type Run,
} from "../src/search/indexer.ts";
import { planWithIndex, withIndex } from "../src/search/ingest.ts";
import { objectAnswer } from "../src/search/object.ts";

/**
 * Indexing the site for search: each page as Markdown (document.ts), and
 * the search's Durable Object indexing it (indexer.ts), only what changed,
 * within what ingestion includes, one run at a time; what a stopped run
 * left, what Cloudflare failed to index and what left the site, put right.
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

/**
 * An index's items, kept in memory, one a key as Cloudflare keeps them: an
 * upload of a key it holds replaces its item under a new id. `statuses`
 * says how an item's indexing went (completed unless set).
 */
const itemsIn = () => {
  const items = new Map<string, { key: string; markdown: string }>();
  const statuses = new Map<string, string>();
  let made = 0;
  const api: Items = {
    upload: async (key, markdown) => {
      const held = [...items].find(([, item]) => item.key === key);
      if (held !== undefined) items.delete(held[0]);
      made += 1;
      const id = `item-${made}`;
      items.set(id, { key, markdown });
      return { id, key };
    },
    delete: async (id) => {
      if (!items.delete(id)) throw new Error(`item_not_found: ${id}`);
    },
    list: async ({ search }) => ({
      result: [...items]
        .filter(([, item]) => item.key.includes(search))
        .map(([id, item]) => ({ id, key: item.key })),
    }),
    get: (id) => ({
      info: async () => {
        if (!items.has(id)) throw new Error(`item_not_found: ${id}`);
        return { status: statuses.get(id) ?? "completed" };
      },
    }),
  };
  return {
    api,
    items,
    statuses,
    keys: () => [...items.values()].map(({ key }) => key).toSorted(),
    idOf: (key: string) =>
      [...items].find(([, item]) => item.key === key)?.[0] ?? "",
    markdownOf: (key: string) =>
      [...items.values()].find((item) => item.key === key)?.markdown,
  };
};

/** The run of these pages, each by its key: the sitemap lists them all, and only them. */
const run = (
  entries: Record<string, string>,
  complete = true,
  { listed, bare = [] }: { listed?: Array<string>; bare?: Array<string> } = {},
): Run => ({
  pages: Object.entries(entries).map(([key, markdown]) => ({ key, markdown })),
  listed: listed ?? Object.keys(entries),
  bare,
  complete,
});

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

describe("what indexing may send", () => {
  test("stays under the included 5,000,000 tokens, a byte for every token it could be billed", () => {
    expect(INGEST_BYTES_IN_WINDOW).toBe(4_000_000);
  });

  test("is counted before it's sent, on the day it's sent, and left for later past the window's room", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    const now = () => at("2026-12-10", "23:59:00");
    const result = await indexSite(
      state,
      api,
      run({ "a.md": "# a", "b.md": "# bb", "c.md": "# ccc" }, true),
      now,
      bytes("# a") + bytes("# bb"),
    );
    expect(result).toMatchObject({ uploaded: 2, refused: 1, used: 7 });
    expect(keys()).toEqual(["a.md", "b.md"]);
    expect(state.held.get("ingested")).toEqual({ "2026-12-10": 7 });
  });

  test("counts nothing for a page left as it is, and frees a day's bytes once it leaves the window", async () => {
    const { api } = itemsIn();
    const state = memory();
    await indexSite(state, api, run({ "a.md": "# a" }, true), () =>
      at("2026-11-01"),
    );
    const later = await indexSite(
      state,
      api,
      run({ "a.md": "# a" }, true),
      () => at("2026-12-03"),
    );
    expect(later).toMatchObject({ uploaded: 0, unchanged: 1, used: 0 });
    expect(used({ "2026-11-01": 3 }, at("2026-12-02"))).toBe(3);
  });

  test("moves a page's count to the day its upload is sent, when midnight passes first", async () => {
    const { api } = itemsIn();
    const state = memory();
    let clock = at("2026-12-10", "23:59:59");
    await indexSite(state, api, run({ "a.md": "# old" }), () => clock);
    // The old item's removal takes the clock past midnight.
    const slow: Items = {
      ...api,
      delete: async (id) => {
        clock = at("2026-12-11", "00:00:01");
        await api.delete(id);
      },
    };
    await indexSite(state, slow, run({ "a.md": "# new!" }), () => clock);
    expect(state.held.get("ingested")).toEqual({
      "2026-12-10": bytes("# old"),
      "2026-12-11": bytes("# new!"),
    });
  });

  test("counts a failed upload all the same", async () => {
    const { api } = itemsIn();
    const state = memory();
    const result = await indexSite(
      state,
      {
        ...api,
        upload: async () => {
          throw new Error("refused");
        },
      },
      run({ "a.md": "# a" }, true),
    );
    expect(result).toMatchObject({ uploaded: 0, failed: ["a.md"], used: 3 });
  });
});

describe("a dry run of indexing", () => {
  test("says what a run would upload, leave for later, remove and ask about, and does none of it", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    await indexSite(
      state,
      api,
      run({ "index.md": "# home", "people/gone.md": "# gone" }),
    );
    const before = structuredClone([...state.held]);
    const plan = await planIndex(
      state,
      run({ "index.md": "# home", "about.md": "# about", "big.md": "# big!" }),
      Date.now,
      2 * bytes("# home") + bytes("# about") + 1,
    );
    expect(plan).toMatchObject({
      dryRun: true,
      upload: ["about.md"],
      refused: ["big.md"],
      remove: ["people/gone.md"],
      check: ["index.md"],
      reset: [],
    });
    expect([...state.held]).toEqual(before);
    expect(keys()).toEqual(["index.md", "people/gone.md"]);
  });
});

describe("indexing the site's pages", () => {
  test("uploads every page the first time, then only what changed, one item each", async () => {
    const { api, keys, markdownOf } = itemsIn();
    const state = memory();
    const first = await indexSite(
      state,
      api,
      run({ "index.md": "# home", "effect.md": "# effect" }, true),
    );
    expect(first).toMatchObject({ uploaded: 2, unchanged: 0, failed: [] });
    const second = await indexSite(
      state,
      api,
      run({ "index.md": "# home", "effect.md": "# effect, changed" }, true),
    );
    expect(second).toMatchObject({ uploaded: 1, unchanged: 1 });
    expect(keys()).toEqual(["effect.md", "index.md"]);
    expect(markdownOf("effect.md")).toBe("# effect, changed");
  });

  test("removes a page the site took down, only after a complete run", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    const both = { "index.md": "# home", "people/gone.md": "# gone" };
    await indexSite(state, api, run(both, true));
    await indexSite(state, api, run({ "index.md": "# home" }, false));
    expect(keys()).toEqual(["index.md", "people/gone.md"]);
    const result = await indexSite(
      state,
      api,
      run({ "index.md": "# home" }, true),
    );
    expect(result.removed).toBe(1);
    expect(keys()).toEqual(["index.md"]);
  });

  test("keeps a listed page that didn't come back, and removes one that came back with no document", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    await indexSite(
      state,
      api,
      run({ "index.md": "# home", "about.md": "# about", "lab.md": "# lab" }),
    );
    // about.md answered 503 this time; lab.md answered with no <main>.
    const result = await indexSite(
      state,
      api,
      run({ "index.md": "# home" }, true, {
        listed: ["index.md", "about.md", "lab.md"],
        bare: ["lab.md"],
      }),
    );
    expect(result.removed).toBe(1);
    expect(keys()).toEqual(["about.md", "index.md"]);
  });

  test("confirms on a later run that Cloudflare indexed each upload, then checks it no more", async () => {
    const { api } = itemsIn();
    const state = memory();
    const home = { "index.md": "# home" };
    await indexSite(state, api, run(home, true));
    expect(await indexSite(state, api, run(home, true))).toMatchObject({
      settled: 1,
    });
    expect(await indexSite(state, api, run(home, true))).toMatchObject({
      settled: 0,
      unchanged: 1,
    });
  });

  test("uploads a page again, counted again, when Cloudflare failed to index it", async () => {
    const { api, statuses, idOf, keys } = itemsIn();
    const state = memory();
    const home = { "index.md": "# home" };
    await indexSite(state, api, run(home, true));
    statuses.set(idOf("index.md"), "error");
    expect(await indexSite(state, api, run(home, true))).toMatchObject({
      reset: 1,
    });
    expect(keys()).toEqual([]);
    const again = await indexSite(state, api, run(home, true));
    expect(again).toMatchObject({ uploaded: 1, used: 2 * bytes("# home") });
    expect(keys()).toEqual(["index.md"]);
  });

  test("asks again next run about a page still queued", async () => {
    const { api, statuses, idOf } = itemsIn();
    const state = memory();
    const home = { "index.md": "# home" };
    await indexSite(state, api, run(home, true));
    statuses.set(idOf("index.md"), "queued");
    expect(await indexSite(state, api, run(home, true))).toMatchObject({
      settled: 0,
      reset: 0,
    });
    statuses.delete(idOf("index.md"));
    expect(await indexSite(state, api, run(home, true))).toMatchObject({
      settled: 1,
    });
  });

  test("puts right what a run that stopped mid-upload left, even for a page that has since left the site", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    // The object restarts after the upload is sent, before its item is recorded.
    const stopped = await indexSite(
      state,
      {
        ...api,
        upload: async (key, markdown) => {
          await api.upload(key, markdown);
          throw new Error("the object was restarted");
        },
      },
      run({ "people/new.md": "# new" }, true),
    );
    expect(stopped.failed).toEqual(["people/new.md"]);
    expect(state.held.get("indexed")).toEqual({
      "people/new.md": { pending: expect.any(String) },
    });
    expect(keys()).toEqual(["people/new.md"]);
    // The page has left the sitemap since: its item still goes.
    const next = await indexSite(state, api, run({}, true));
    expect(next).toMatchObject({ reset: 1, failed: [] });
    expect(keys()).toEqual([]);
    expect(state.held.get("indexed")).toEqual({});
  });

  test("uploads anew a page a stopped run left, when it's still listed", async () => {
    const { api, keys, markdownOf } = itemsIn();
    const state = memory();
    await indexSite(
      state,
      {
        ...api,
        upload: async () => {
          throw new Error("the object was restarted");
        },
      },
      run({ "index.md": "# home" }, true),
    );
    const next = await indexSite(
      state,
      api,
      run({ "index.md": "# home" }, true),
    );
    expect(next).toMatchObject({ reset: 1, uploaded: 1 });
    expect(keys()).toEqual(["index.md"]);
    expect(markdownOf("index.md")).toBe("# home");
  });

  test("takes an item already gone as removed", async () => {
    const { api, idOf, keys } = itemsIn();
    const state = memory();
    await indexSite(state, api, run({ "people/gone.md": "# gone" }, true));
    await api.delete(idOf("people/gone.md"));
    const result = await indexSite(state, api, run({}, true));
    expect(result).toMatchObject({ removed: 1, failed: [] });
    expect(keys()).toEqual([]);
  });

  test("tries again next run what failed for another reason", async () => {
    const { api } = itemsIn();
    const state = memory();
    await indexSite(state, api, run({ "people/gone.md": "# gone" }, true));
    const result = await indexSite(
      state,
      {
        ...api,
        delete: async () => {
          throw new Error("timeout");
        },
      },
      run({}, true),
    );
    expect(result).toMatchObject({ removed: 0, failed: ["people/gone.md"] });
    expect(await indexSite(state, api, run({}, true))).toMatchObject({
      removed: 1,
    });
  });
});

describe("the object that indexes", () => {
  const post = (
    state: BudgetState,
    env: Readonly<Record<string, unknown>>,
    lock: { running: boolean },
    body: unknown,
  ) =>
    objectAnswer(
      state,
      env,
      new Request("https://budget/index", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      lock,
    );
  const envFor = (items: Items) => ({
    SEARCH: {
      get: () => ({ search: async () => ({ chunks: [] }), items }),
    },
    SEARCH_INSTANCE: "pages",
  });

  test("indexes one run at a time: a run while another holds the lock does nothing", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    const lock = { running: false };
    let release = () => {};
    let entered = () => {};
    const uploadEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow: Items = {
      ...api,
      upload: async (key, markdown) => {
        await new Promise<void>((resolve) => {
          release = resolve;
          entered();
        });
        return api.upload(key, markdown);
      },
    };
    const body = run({ "index.md": "# home" });
    const first = post(state, envFor(slow), lock, body);
    // The first run holds the lock once it's in its upload.
    await uploadEntered;
    const second = await (await post(state, envFor(api), lock, body)).json();
    expect(second).toMatchObject({ busy: true, uploaded: 0 });
    release();
    expect(await (await first).json()).toMatchObject({ uploaded: 1 });
    expect(lock.running).toBe(false);
    expect(keys()).toEqual(["index.md"]);
  });

  test("lets go of the lock when a run fails", async () => {
    const lock = { running: false };
    const state: BudgetState = {
      storage: {
        get: async () => {
          throw new Error("storage is down");
        },
        put: async () => {},
      },
    };
    await expect(
      post(state, envFor(itemsIn().api), lock, run({})),
    ).rejects.toThrow("storage is down");
    expect(lock.running).toBe(false);
  });

  test("refuses what isn't an index, and answers 503 with no index bound", async () => {
    const lock = { running: false };
    const statuses = await Promise.all(
      [
        { pages: [{ key: "a.md" }], complete: true },
        { pages: [{ key: "", markdown: "x" }], complete: true },
        { pages: [{ key: "a".repeat(129), markdown: "x" }], complete: true },
        { pages: [], complete: "yes" },
      ].map(
        async (body) =>
          (await post(memory(), envFor(itemsIn().api), lock, body)).status,
      ),
    );
    expect(statuses).toEqual([400, 400, 400, 400]);
    expect(
      (await post(memory(), {}, lock, run({}))).status,
    ).toBe(503);
  });

  test("still takes searches at its other path", async () => {
    const response = await objectAnswer(
      memory(),
      {},
      new Request("https://budget/take", { method: "POST" }),
      { running: false },
    );
    expect(await response.json()).toMatchObject({ ok: true, used: 1 });
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
  /** A Worker's bindings whose object indexes into `items` over `state`. */
  const envWith = (items: Items, state: BudgetState) => {
    const lock = { running: false };
    const env: Record<string, unknown> = {
      ORIGIN: "https://allthings.dev",
      SEARCH: {
        get: () => ({ search: async () => ({ chunks: [] }), items }),
      },
      SEARCH_INSTANCE: "pages",
      SEARCH_BUDGET: {
        idFromName: () => "site",
        get: () => ({
          fetch: (url: string, init: RequestInit) =>
            objectAnswer(state, env, new Request(url, init), lock),
        }),
      },
    };
    return env;
  };

  test("is the prewarm alone where the Worker has no index", async () => {
    let handed: unknown = "unset";
    const result = await withIndex({}, async (onPage) => {
      handed = onPage;
      return report;
    });
    expect(handed).toBeUndefined();
    expect(result).toEqual(report);
  });

  test("indexes the pages the prewarm read, under each page's key, and says so in its report", async () => {
    const { api, keys, markdownOf } = itemsIn();
    const env = envWith(api, memory());
    expect(indexingOf(env)).toBeDefined();
    const result = await withIndex(env, async (onPage) => {
      onPage?.("/sitemap.xml", "<urlset/>");
      onPage?.("/", html("allthings/_"));
      onPage?.("/about", html("about"));
      return report;
    });
    expect(result.search).toMatchObject({ uploaded: 2, failed: [] });
    expect(keys()).toEqual(["about.md", "index.md"]);
    expect(markdownOf("about.md")).toContain("https://allthings.dev/about");
  });

  test("leaves out a page whose key is too long for the index, and indexes the rest", async () => {
    const { api, keys } = itemsIn();
    const long = `/people/${"a".repeat(140)}`;
    const result = await withIndex(envWith(api, memory()), async (onPage) => {
      onPage?.("/", html("home"));
      onPage?.(long, html("long"));
      return report;
    });
    expect(result.search).toMatchObject({ uploaded: 1, skipped: [long] });
    expect(keys()).toEqual(["index.md"]);
  });

  test("keeps the item of a listed page that failed to come back", async () => {
    const { api, keys } = itemsIn();
    const env = envWith(api, memory());
    await withIndex(env, async (onPage) => {
      onPage?.("/", html("home"));
      onPage?.("/about", html("about"));
      return report;
    });
    const result = await withIndex(env, async (onPage) => {
      onPage?.("/", html("home"));
      onPage?.("/about", undefined);
      return report;
    });
    expect(result.search).toMatchObject({ removed: 0 });
    expect(keys()).toEqual(["about.md", "index.md"]);
  });

  test("plans in a dry run from pages rendered without keeping them, and writes nothing", async () => {
    const { api, keys } = itemsIn();
    const state = memory();
    const env = envWith(api, state);
    const rendered: Array<string> = [];
    const plan = await planWithIndex(env, { dryRun: true }, async (path) => {
      rendered.push(path);
      return path === "/sitemap.xml"
        ? new Response(
            "<urlset><url><loc>https://allthings.dev/</loc></url><url><loc>https://allthings.dev/about</loc></url></urlset>",
          )
        : new Response(html(path));
    });
    expect(plan).toMatchObject({
      dryRun: true,
      search: { dryRun: true, upload: ["index.md", "about.md"] },
    });
    expect(rendered.toSorted()).toEqual(["/", "/about", "/sitemap.xml"]);
    expect(keys()).toEqual([]);
    expect(state.held.size).toBe(0);
  });

  test("removes nothing when a page couldn't be made into a document", async () => {
    const { api, keys } = itemsIn();
    const env = envWith(api, memory());
    const both = async (onPage?: (path: string, html: string) => void) => {
      onPage?.("/", html("home"));
      onPage?.("/about", html("about"));
      return report;
    };
    await withIndex(env, both);
    const result = await withIndex(env, both, async (page, url) => {
      if (url.endsWith("/about")) throw new Error("couldn't read it");
      return pageDocument(page, url);
    });
    expect(result.search).toMatchObject({ removed: 0 });
    expect(keys()).toEqual(["about.md", "index.md"]);
  });

  test("never fails the prewarm when indexing does", async () => {
    const env = {
      ...envWith(itemsIn().api, memory()),
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
