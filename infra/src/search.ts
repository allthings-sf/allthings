import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The site's search for agents (web/src/search/): an AI Search index of
 * its own pages that the Web Worker searches through its `SEARCH` binding
 * to answer `/.well-known/search`, on prod alone. Cloudflare's own toggle
 * ("Search for Agents") serves that path from an instance with no limit on
 * what it is asked, and AI Search bills past each month's included usage
 * (from December 1, 2026) where no spending limit reaches. So the Worker
 * answers it instead, counting every search against a budget under the
 * included queries first (web/src/search/budget.ts).
 *
 * The index is AI Search's built-in storage, with no data source: it
 * indexes only what is uploaded to it, when it is uploaded, and never
 * syncs or crawls on a schedule of its own. Alchemy's `SearchInstance`
 * can't declare one (it always sends a source type, `r2` by default), and
 * an R2 or website source would index on Cloudflare's schedule. So
 * {@link SearchIndex} is a resource of our own, as the alerts are
 * (alerts.ts), whose provider makes the instance with Alchemy's own client
 * for the AI Search API, on the deploy's credentials. It lives in a
 * namespace of its own ({@link searchNamespace}), which the Worker binds.
 */

/** The namespace's name: the site's alone. */
export const SEARCH_NAMESPACE = "allthings";

/** The index's name in it. */
export const SEARCH_INSTANCE = "pages";

/**
 * How the index is kept and searched. Each setting is one Cloudflare
 * applies when it is left out too, or one chosen here; every one is sent,
 * so the deploy says all of it:
 *
 * - Hybrid: vector and keyword (porter) search, fused by reciprocal rank,
 *   so a name or a library ("effect") is found as written.
 * - Chunks of 512 tokens with no overlap, so the tokens indexed are the
 *   page's own and counted once each (an overlap is billed in every chunk
 *   it repeats in).
 * - No OCR and no file summaries, which bill as images and as Workers AI.
 * - The similarity cache on (48 hours), which answers a repeated search
 *   without searching again; no query rewriting and no reranking.
 * - No public endpoint: no REST, MCP or snippet search Cloudflare would
 *   answer beside the Worker, uncounted.
 */
export const SEARCH_SETTINGS = {
  indexMethod: { vector: true, keyword: true },
  fusionMethod: "rrf",
  indexingOptions: { keywordTokenizer: "porter", useOcr: false },
  chunk: true,
  chunkSize: 512,
  chunkOverlap: 0,
  maxNumResults: 10,
  cache: true,
  cacheThreshold: "close_enough",
  cacheTtl: 172_800,
  rewriteQuery: false,
  reranking: false,
  publicEndpointParams: { enabled: false },
} as const satisfies Partial<aisearch.CreateNamespaceInstanceRequest>;

export type SearchSettings = typeof SEARCH_SETTINGS;

export interface SearchIndexProps {
  /** The namespace that holds it. */
  readonly namespace: string;
  /** Its name there, which the Worker gets it by. */
  readonly instanceId: string;
  readonly settings: SearchSettings;
}

export type SearchIndex = Resource<
  "Allthings.Cloudflare.SearchIndex",
  SearchIndexProps,
  {
    readonly instanceId: string;
    readonly namespace: string;
    /** The account that holds it. */
    readonly accountId: string;
  }
>;

export const SearchIndex = Resource<SearchIndex>(
  "Allthings.Cloudflare.SearchIndex",
);

/** What Cloudflare holds of an instance. */
type Observed = aisearch.ReadNamespaceInstanceResponse;

/**
 * Whether Cloudflare's `observed` value is the `wanted` one. It answers
 * `null` for what it holds no value of: an object it holds none of is
 * compared as empty, and a switch it holds none of is off, as Cloudflare
 * takes one left out (the similarity cache aside, which is on, and which
 * the settings turn on).
 */
const same = (observed: unknown, wanted: unknown): boolean =>
  typeof wanted === "object" && wanted !== null
    ? Object.entries(wanted).every(([key, value]) =>
        same(
          typeof observed === "object" && observed !== null
            ? (observed as Record<string, unknown>)[key]
            : undefined,
          value,
        ),
      )
    : (observed ?? (wanted === false ? false : undefined)) === wanted;

/** Settings Cloudflare takes but never answers with, so never drift. */
const writeOnly: ReadonlyArray<string> = ["chunk"];

/**
 * The settings `observed` doesn't hold as `settings` says, by name: what an
 * update would change. Only what the settings name is compared, so what
 * Cloudflare adds (a public endpoint's empty host list, say) is no drift.
 */
export const drifted = (
  observed: Observed,
  settings: SearchSettings,
): ReadonlyArray<string> =>
  Object.entries(settings)
    .filter(
      ([key, value]) =>
        !writeOnly.includes(key) &&
        !same((observed as unknown as Record<string, unknown>)[key], value),
    )
    .map(([key]) => key);

/**
 * Why `observed` isn't the site's index, if it isn't: one with a data
 * source would index on Cloudflare's schedule, past the budget's count.
 */
export const notBuiltIn = (observed: Observed): string | undefined =>
  (observed.type ?? undefined) !== undefined || (observed.source ?? "") !== ""
    ? `the AI Search instance "${observed.id}" has a data source (${observed.type ?? "?"}: ${observed.source ?? "?"}); the site's index holds only what the Worker uploads`
    : undefined;

/** The instance, or undefined when Cloudflare holds no such instance or namespace. */
const observe = (accountId: string, namespace: string, id: string) =>
  aisearch
    .readNamespaceInstance({ accountId, name: namespace, id })
    .pipe(
      Effect.catchTag(["AiSearchInstanceNotFound", "NamespaceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const SearchIndexProvider = () =>
  Provider.succeed(SearchIndex, {
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      const request = {
        accountId,
        name: news.namespace,
        id: news.instanceId,
        ...news.settings,
      };
      const observed = yield* observe(
        accountId,
        news.namespace,
        news.instanceId,
      );
      if (observed === undefined) {
        // No `type` and no `source`: built-in storage alone.
        yield* aisearch.createNamespaceInstance(request);
      } else {
        const refusal = notBuiltIn(observed);
        if (refusal !== undefined)
          return yield* Effect.fail(new Error(refusal));
        // An update sends every setting; one that changes how pages are
        // indexed has Cloudflare index them all again, so it waits for one.
        if (drifted(observed, news.settings).length > 0) {
          yield* aisearch.updateNamespaceInstance(request);
        }
      }
      return {
        instanceId: news.instanceId,
        namespace: news.namespace,
        accountId: output?.accountId ?? accountId,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      // Gone already is gone.
      yield* aisearch
        .deleteNamespaceInstance({
          accountId: output.accountId,
          name: output.namespace,
          id: output.instanceId,
        })
        .pipe(
          Effect.catchTag(
            ["AiSearchInstanceNotFound", "NamespaceNotFound"],
            () => Effect.void,
          ),
        );
    }),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(
        output.accountId,
        output.namespace,
        output.instanceId,
      );
      return observed === undefined ? undefined : output;
    }),
    list: () => Effect.succeed([]),
  });

/** {@link SearchIndexProvider} beside `providers`, on the same credentials and account. */
export const withSearchProviders = <A, E, R>(providers: Layer.Layer<A, E, R>) =>
  SearchIndexProvider().pipe(Layer.provideMerge(providers));

/** The namespace the index lives in, which the Web Worker binds as `SEARCH`. */
export const searchNamespace = Cloudflare.AI.SearchNamespace("Search", {
  name: SEARCH_NAMESPACE,
  description: "allthings.dev's own pages, for /.well-known/search",
});

/**
 * Prod's search: the namespace, and the index in it, which it orders after
 * the namespace on deploy and before it on destroy.
 */
export const makeSearch = Effect.gen(function* () {
  const namespace = yield* searchNamespace;
  const index = yield* SearchIndex("Pages", {
    namespace: namespace.name,
    instanceId: SEARCH_INSTANCE,
    settings: SEARCH_SETTINGS,
  });
  return { namespace, instance: index.instanceId };
});
