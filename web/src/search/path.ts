/**
 * Where the site answers searches (route.ts). Apart from everything else
 * the search is made of, so the Worker's entry (worker.ts), which every
 * cold start parses, can tell a search by its path and load the rest only
 * then.
 */
export const searchPath = "/.well-known/search";
