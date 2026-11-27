import { type Taken, takePath } from "./budget.ts";

/**
 * The search's bindings (route.ts), as infra/src/web.ts gives them to prod
 * alone: `SEARCH`, the AI Search namespace that holds the site's index;
 * `SEARCH_INSTANCE`, the index's name in it; and `SEARCH_BUDGET`, the
 * Durable Object that counts searches (budget.ts). Every other stage has
 * none of them, so it has no search: the path is a page like any other
 * there, not found.
 *
 * worker.ts reads them on each cold start, so this module imports only the
 * budget, which imports nothing.
 */

/** Where the site answers searches. */
export const searchPath = "/.well-known/search";

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

/** What the Worker uses of an AI Search namespace binding. */
interface SearchNamespace {
  readonly get: (instance: string) => SearchIndex;
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

/** The name of the one object that counts every search. */
export const budgetName = "site";

/** What the route needs of the Worker's bindings. */
export interface Search {
  readonly index: SearchIndex;
  /** Takes one search from the budget: what it came to, or a failure. */
  readonly take: () => Promise<Taken>;
}

/** The search, if the Worker has every binding it needs. */
export function searchOf(
  env: Readonly<Record<string, unknown>>,
): Search | undefined {
  const namespace = env["SEARCH"];
  const instance = env["SEARCH_INSTANCE"];
  const budget = env["SEARCH_BUDGET"];
  if (
    !has(namespace, "get") ||
    typeof instance !== "string" ||
    instance === "" ||
    !has(budget, "idFromName", "get")
  ) {
    return undefined;
  }
  const counter = budget as BudgetNamespace;
  return {
    index: (namespace as SearchNamespace).get(instance),
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
