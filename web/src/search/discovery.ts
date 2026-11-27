import { searchPath } from "./path.ts";

/**
 * How the site tells agents where to search it, as Cloudflare's guide has a
 * site do ("Discover the search endpoint",
 * https://developers.cloudflare.com/ai-search/how-to/search-for-agents/):
 * `agent:` meta tags in every indexed page's head (pages/metadata.tsx), and
 * the same under an `agent:` key in the YAML front matter of the Markdown
 * the site answers (route.ts). Every stage names production's search: the
 * pages name their production address everywhere, too.
 */

/** What an agent is told the search does. */
export const agentInstructions =
  "Use this search API to find relevant content across allthings.dev (its evenings, talks, people and guides) with keywords or natural-language queries, instead of crawling individual pages. Results are returned in Markdown.";

/** Cloudflare's guide to the endpoint, which the site's own description links to. */
export const searchGuide =
  "https://developers.cloudflare.com/ai-search/how-to/search-for-agents/";

/**
 * Where the endpoint is described: the endpoint itself, asked with no `q`
 * (route.ts), on the site's own origin, as everything a page's head names
 * is.
 */
export const agentDocumentation = (origin: string): string =>
  `${origin}${searchPath}`;

/** The search's address on `origin`, with the query's place marked. */
export const agentEndpoint = (origin: string): string =>
  `${origin}${searchPath}?q={query}`;

/** The discovery fields, as each meta tag and the front matter name them. */
export const agentDiscovery = (origin: string) =>
  ({
    instructions: agentInstructions,
    endpoint: agentEndpoint(origin),
    method: "GET",
    documentation: agentDocumentation(origin),
  }) as const;

/** The YAML front matter a Markdown answer starts with. */
export const agentFrontMatter = (origin: string): string =>
  [
    "---",
    "agent:",
    ...Object.entries(agentDiscovery(origin)).map(
      ([field, value]) => `  ${field}: ${JSON.stringify(value)}`,
    ),
    "---",
    "",
  ].join("\n");
