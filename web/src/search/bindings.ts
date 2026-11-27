import { type Taken, takePath } from "./budget.ts";
import type { IndexReport, Page } from "./indexer.ts";

/**
 * The search's bindings (route.ts), as infra/src/web.ts gives them to prod
 * alone: `SEARCH`, the AI Search namespace that holds the site's index;
 * `SEARCH_INSTANCE`, the index's name in it; `SEARCH_BUDGET`, the Durable
 * Object that counts searches (budget.ts); and `SEARCH_LIMIT`, the rate
 * limit on each address. Every other stage has none of them, so it has no
 * search: the path is a page like any other there, not found.
 *
 * The route reads them on the first search (worker.ts), and
 * infra/src/web.ts reads the rate, so this module imports only the budget,
 * which imports nothing.
 */

export { searchPath } from "./path.ts";

/**
 * Searches one address may make a minute, as `SEARCH_LIMIT` counts them in
 * each Cloudflare location (infra/src/web.ts): an agent's errand, not a
 * loop's, so no one client spends the budget in a burst.
 */
export const perMinute = 10;

/** One passage the index retrieved, as the binding answers it. */
export interface Passage {
  readonly text: string;
  readonly score: number;
  readonly item: { readonly key: string };
}

/** What the Worker uses of an AI Search instance. */
export interface SearchIndex {
  readonly search: (request: {
    readonly query: string;
  }) => Promise<{ readonly chunks: ReadonlyArray<Passage> }>;
}

/** What the object uses of an instance's Items API (its built-in storage). */
export interface Items {
  readonly upload: (
    name: string,
    content: string,
  ) => Promise<{ readonly id: string; readonly key: string }>;
  readonly delete: (itemId: string) => Promise<void>;
  /** Items whose keys hold `search`: to find a key's item when its id isn't known. */
  readonly list: (options: {
    readonly search: string;
    readonly per_page: number;
    readonly page: number;
  }) => Promise<{
    readonly result: ReadonlyArray<{
      readonly id: string;
      readonly key: string;
    }>;
  }>;
}

/** What the Worker uses of an AI Search namespace binding. */
interface SearchNamespace {
  readonly get: (instance: string) => SearchIndex & { readonly items: Items };
}

/** What the Worker uses of a Rate Limiting binding. */
interface RateLimiter {
  readonly limit: (options: {
    readonly key: string;
  }) => Promise<{ readonly success: boolean }>;
}

/** What the Worker uses of a Durable Object namespace binding. */
interface BudgetNamespace {
  readonly idFromName: (name: string) => unknown;
  readonly get: (id: unknown) => {
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  };
}

// workerd's bindings expose their methods on their prototypes, so each is
// read, not looked up as an own property.
const has = (value: unknown, ...methods: ReadonlyArray<string>) =>
  typeof value === "object" &&
  value !== null &&
  methods.every(
    (method) =>
      typeof (value as Record<string, unknown>)[method] === "function",
  );

/** The name of the one object that counts every search and indexes the site. */
export const budgetName = "site";

/** What the route needs of the Worker's bindings. */
export interface Search {
  readonly index: SearchIndex;
  /** Takes one search from the budget: what it came to, or a failure. */
  readonly take: () => Promise<Taken>;
  /** Whether the address `client` may search now: false past its rate, a failure when it can't be read. */
  readonly allow: (client: string) => Promise<boolean>;
}

/** Where the indexer hands the object the pages to index (object.ts). */
export const indexPath = "/index";

/** The index's items, for the object that indexes them (prod alone). */
export function itemsOf(
  env: Readonly<Record<string, unknown>>,
): Items | undefined {
  const namespace = env["SEARCH"];
  const instance = env["SEARCH_INSTANCE"];
  if (
    !has(namespace, "get") ||
    typeof instance !== "string" ||
    instance === ""
  ) {
    return undefined;
  }
  return (namespace as SearchNamespace).get(instance).items;
}

/** What the prewarm needs to have the site's pages indexed (ingest.ts). */
export interface Indexing {
  /** Has the object index `pages`: what it did. */
  readonly index: (pages: ReadonlyArray<Page>) => Promise<IndexReport>;
}

/** Indexing, if the Worker has the index and the object (prod alone). */
export function indexingOf(
  env: Readonly<Record<string, unknown>>,
): Indexing | undefined {
  const budget = env["SEARCH_BUDGET"];
  if (itemsOf(env) === undefined || !has(budget, "idFromName", "get")) {
    return undefined;
  }
  const counter = budget as BudgetNamespace;
  return {
    index: async (pages) => {
      const response = await counter
        .get(counter.idFromName(budgetName))
        .fetch(`https://budget${indexPath}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pages }),
        });
      if (!response.ok) {
        throw new Error(`the search budget answered ${response.status}`);
      }
      return (await response.json()) as IndexReport;
    },
  };
}

/** The search, if the Worker has every binding it needs. */
export function searchOf(
  env: Readonly<Record<string, unknown>>,
): Search | undefined {
  const namespace = env["SEARCH"];
  const instance = env["SEARCH_INSTANCE"];
  const budget = env["SEARCH_BUDGET"];
  const limit = env["SEARCH_LIMIT"];
  if (
    !has(namespace, "get") ||
    typeof instance !== "string" ||
    instance === "" ||
    !has(budget, "idFromName", "get") ||
    !has(limit, "limit")
  ) {
    return undefined;
  }
  const counter = budget as BudgetNamespace;
  const limiter = limit as RateLimiter;
  return {
    index: (namespace as SearchNamespace).get(instance),
    allow: async (client) =>
      (await limiter.limit({ key: `search:${client}` })).success,
    take: async () => {
      const response = await counter
        .get(counter.idFromName(budgetName))
        .fetch(`https://budget${takePath}`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`the search budget answered ${response.status}`);
      }
      return (await response.json()) as Taken;
    },
  };
}
