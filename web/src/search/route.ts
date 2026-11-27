import { boundedBody } from "../bounded-body.ts";
import { CacheControl } from "../cache.ts";
import {
  type Passage,
  perMinute,
  type Search,
  type SearchIndex,
  searchOf,
  searchPath,
} from "./bindings.ts";
import { QUERIES_IN_WINDOW, WINDOW_DAYS } from "./budget.ts";
import { agentFrontMatter, searchGuide } from "./discovery.ts";

/**
 * Search for agents: `/.well-known/search`, as Cloudflare's guide describes
 * it (https://developers.cloudflare.com/ai-search/how-to/search-for-agents/),
 * answered by the site's own Worker from the site's AI Search index
 * (infra/src/search.ts) rather than by Cloudflare's dashboard toggle, which
 * would put an uncapped, publicly queryable bill on the account. Each
 * search is first taken from the budget (budget.ts): past it the answer is
 * 503, and the index isn't asked.
 *
 * - `GET /.well-known/search?q=…` searches for `q`; with no `q` at all, it
 *   describes itself ({@link description}), which is what the pages'
 *   `agent:documentation` names, and counts nothing.
 * - `QUERY /.well-known/search` searches for its body: UTF-8 text
 *   (`Content-Type: text/plain`), or JSON with a `q` field
 *   (`application/json`).
 *
 * The answer is Markdown, as Cloudflare's endpoint answers: the passages
 * the index retrieved, each under its page's address and its score, never
 * a generated answer, after the `agent:` front matter (discovery.ts). A
 * search with nothing to search for is refused before it is counted, and
 * so is one past its address's rate
 * ({@link perMinute} a minute), so no one client can spend the budget in a
 * burst.
 */

export { searchPath };
export type { Passage, SearchIndex };

/** The longest search taken, in characters: far past any question an agent asks. */
export const queryLimit = 500;

/** The most of a QUERY's body read, in bytes. */
export const bodyLimit = 4_096;

/** The media types a QUERY's body may have (`Accept-Query`). */
export const acceptQuery = "text/plain, application/json";

/** What the route needs: the bindings (bindings.ts) and the site's origin. */
export interface SearchOptions extends Search {
  /** The site's origin, which the passages' addresses name. */
  readonly origin: string;
}

/** The address a request came from, as Cloudflare names it; "unknown" without one (tests). */
const clientOf = (request: Request): string =>
  request.headers.get("cf-connecting-ip") ?? "unknown";

/**
 * The item key a page is indexed under: its path without the leading
 * slash, `index` for the home page, as a Markdown file (`/effect` is
 * `effect.md`, `/people/erik` is `people/erik.md`).
 */
export const pageKey = (path: string): string =>
  `${path === "/" ? "index" : path.replace(/^\//, "")}.md`;

/** The path of the page indexed under `key`, the inverse of {@link pageKey}. */
export const pagePath = (key: string): string => {
  const name = key.replace(/\.md$/, "");
  return name === "index" ? "/" : `/${name}`;
};

const markdown = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // It quotes what it was asked, so no browser may take it for a page.
      "x-content-type-options": "nosniff",
      "accept-query": acceptQuery,
      "cache-control": CacheControl.failure,
      ...headers,
    },
  });

/** A refusal before anything is counted, saying how to ask. */
const usage = (status: number, problem: string, headers = {}) =>
  markdown(
    status,
    `${problem}\n\nSearch allthings.dev with \`GET ${searchPath}?q=<words>\`, or \`QUERY ${searchPath}\` with the words as a \`text/plain\` body or as \`{"q": "<words>"}\` in \`application/json\`.\n`,
    headers,
  );

/** How the endpoint describes itself, asked with no `q`. */
export const description = (origin: string): string =>
  `# Search allthings.dev

Search allthings.dev's pages (its evenings, talks, people and guides) with keywords or a question, instead of crawling them. The answer is Markdown: the passages that match, each under its page's address with its score, best first. It never generates an answer.

- \`GET ${origin}${searchPath}?q=<words>\`
- \`QUERY ${origin}${searchPath}\` with the words as a \`text/plain\` body, or as \`{"q": "<words>"}\` in \`application/json\`

A search may be at most ${queryLimit} characters. One address may search ${perMinute} times a minute (429 past it), and the site answers at most ${QUERIES_IN_WINDOW} searches in any ${WINDOW_DAYS} UTC days (503 past them, with \`Retry-After\`). Every page is also listed at ${origin}/sitemap.xml.

This is the endpoint Cloudflare's guide describes: ${searchGuide}
`;

/** The search a request asks for, or the refusal that says why it can't be read. */
async function queryOf(request: Request): Promise<string | Response> {
  if (request.method === "GET") {
    return new URL(request.url).searchParams.get("q") ?? "";
  }
  const type = (request.headers.get("content-type") ?? "text/plain")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (type !== "text/plain" && type !== "application/json") {
    return usage(415, `A QUERY body must be ${acceptQuery}.`);
  }
  // Read no further than the limit, whatever the body says its length is.
  const bytes = await boundedBody(request, bodyLimit);
  if (bytes === undefined) {
    return usage(413, `A QUERY body may be at most ${bodyLimit} bytes.`);
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return usage(400, "A QUERY body must be UTF-8.");
  }
  if (type === "text/plain") return body;
  try {
    const parsed: unknown = JSON.parse(body);
    const q =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { q?: unknown }).q
        : undefined;
    return typeof q === "string"
      ? q
      : usage(400, 'The JSON needs a "q" string.');
  } catch {
    return usage(400, "The body isn't JSON.");
  }
}

/** The answer to `query`'s passages, in Markdown. */
export function resultsMarkdown(
  query: string,
  passages: ReadonlyArray<Passage>,
  origin: string,
): string {
  const heading = `# Search results for: "${query}"`;
  if (passages.length === 0) {
    return `${heading}\n\nNothing on allthings.dev matches.\n`;
  }
  return `${heading}\n\n${passages
    .map(
      (passage) =>
        `## ${origin}${pagePath(passage.item.key)} (score: ${passage.score.toFixed(3)})\n\n${passage.text.trim()}\n`,
    )
    .join("\n---\n\n")}`;
}

/** The answer to a request at {@link searchPath}. */
export async function searchRequest(
  request: Request,
  { index, take, allow, origin }: SearchOptions,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "QUERY") {
    return usage(405, `${request.method} isn't a search.`, {
      allow: "GET, QUERY",
    });
  }
  if (request.method === "GET" && !new URL(request.url).searchParams.has("q")) {
    return markdown(200, agentFrontMatter(origin) + description(origin), {
      "cache-control": CacheControl.page,
    });
  }
  const read = await queryOf(request);
  if (read instanceof Response) return read;
  // One line, as the heading shows it: a search is words, not a document.
  const query = read.replace(/\s+/g, " ").trim();
  if (query === "") return usage(400, "There's nothing to search for.");
  if (query.length > queryLimit) {
    return usage(400, `A search may be at most ${queryLimit} characters.`);
  }
  // An address past its rate is refused before it counts; a rate limit
  // that can't be read refuses too.
  const allowed = await allow(clientOf(request)).catch(
    (): undefined => undefined,
  );
  if (allowed !== true) {
    return markdown(
      allowed === false ? 429 : 503,
      allowed === false
        ? `# Too many searches\n\nOne address may search allthings.dev ${perMinute} times a minute. Try again in a minute.\n`
        : "# Search is resting\n\nThe search's rate limit couldn't be read, so it isn't searching. Try again in a minute.\n",
      { "retry-after": "60" },
    );
  }
  // A budget that can't be read refuses: the index is never asked uncounted.
  const taken = await take().catch((): undefined => undefined);
  if (taken === undefined) {
    return markdown(
      503,
      "# Search is resting\n\nThe search's count couldn't be read, so it isn't searching. Try again in a minute.\n",
      { "retry-after": "60" },
    );
  }
  if (!taken.ok) {
    return markdown(
      503,
      `# Search is resting\n\nallthings.dev answers at most ${taken.limit} searches in any ${WINDOW_DAYS} UTC days (today and the ${WINDOW_DAYS - 1} before it), and it has answered them, so it isn't searching again for about ${Math.ceil(taken.retryAfter / 3600)} hours. Every page is still there: ${origin}/sitemap.xml lists them.\n`,
      { "retry-after": String(taken.retryAfter) },
    );
  }
  let passages: ReadonlyArray<Passage>;
  try {
    passages = (await index.search({ query })).chunks;
  } catch {
    return markdown(
      502,
      "# Search failed\n\nThe index didn't answer. Try again in a minute.\n",
    );
  }
  return markdown(
    200,
    agentFrontMatter(origin) + resultsMarkdown(query, passages, origin),
    {
      // A search is public data: the same words get the same passages until
      // the pages change, so Workers Cache (cache.ts) may answer a repeat
      // without counting it again.
      "cache-control": CacheControl.publicData,
    },
  );
}

/**
 * The answer to a request at {@link searchPath} on a Worker with `env`'s
 * bindings: the search, where the Worker has every one it needs
 * (bindings.ts), and `otherwise` where it doesn't, as on every stage but
 * prod.
 */
export function searchFrom(
  env: Readonly<Record<string, unknown>>,
  request: Request,
  otherwise: () => Promise<Response>,
): Promise<Response> {
  const search = searchOf(env);
  if (search === undefined) return otherwise();
  const origin = typeof env["ORIGIN"] === "string" ? env["ORIGIN"] : "";
  return searchRequest(request, { ...search, origin });
}
