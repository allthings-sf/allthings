import {
  type BudgetState,
  type DayCounts,
  used,
  utcDay,
  WINDOW_DAYS,
} from "./budget.ts";

/**
 * What indexing may ingest (ingest.ts), kept by the same Durable Object as
 * the searches' count (budget.ts). AI Search bills ingestion past each
 * month's included 5,000,000 tokens, $0.75 per million more, counted with
 * the cl100k_base tokenizer on the chunks it indexes, overlaps included
 * (https://developers.cloudflare.com/ai-search/platform/limits-pricing/).
 * Every cl100k_base token is at least one byte of the text it encodes, and
 * the index's chunks don't overlap (infra/src/search.ts), so a page's UTF-8
 * bytes bound the tokens it is billed. The object lets through at most
 * {@link INGEST_BYTES_IN_WINDOW} bytes in any {@link WINDOW_DAYS} UTC days,
 * in the window the searches use, and refuses the rest until there's room.
 *
 * It also keeps what each page was indexed as (its Markdown's hash and its
 * item's id), so only a page that changed is uploaded, and one the site no
 * longer lists is removed.
 */

/**
 * The most bytes indexed in any {@link WINDOW_DAYS} days: a million under
 * the 5,000,000 tokens included, since bytes bound tokens. English runs
 * about four bytes a token, so what's billed is well under it. The million
 * left is for what Cloudflare indexes again on its own, all of it at most
 * once for each change to how it indexes, when the whole site is about
 * 315,000 bytes.
 */
export const INGEST_BYTES_IN_WINDOW = 4_000_000;

/** A page the indexer would upload: its key, and its Markdown's hash and size. */
export interface PlannedPage {
  readonly key: string;
  readonly hash: string;
  readonly bytes: number;
}

/** A page as it was indexed. */
export interface IndexedPage {
  readonly hash: string;
  /** The item's id in the index, to remove it by. */
  readonly id: string;
}

/** Every page indexed, by key. */
export type Indexed = Readonly<Record<string, IndexedPage>>;

/** What the object lets the indexer do. */
export interface Planned {
  /** Keys to upload, whose bytes are counted now. */
  readonly upload: ReadonlyArray<string>;
  /** The items those keys were indexed as before, if they were. */
  readonly previous: ReadonlyArray<{
    readonly key: string;
    readonly id: string;
  }>;
  /** Keys that changed, for which the window has no room. */
  readonly refused: ReadonlyArray<string>;
  /** Pages indexed as they are. */
  readonly unchanged: number;
  /** Pages indexed that the site no longer lists. */
  readonly remove: ReadonlyArray<{ readonly key: string; readonly id: string }>;
  /** Bytes counted in the window, these included. */
  readonly used: number;
  readonly limit: number;
}

/**
 * Plans an indexing run at `at`: each page whose hash isn't the one indexed
 * is let through, in the order given, while the window has room for its
 * bytes, and counted on `at`'s day; the rest are refused. With `complete`
 * (the sitemap was read and every page it lists came back), each page
 * indexed and not given is to be removed. The counts come back without
 * the days the window has left.
 */
export function plan(
  ingested: DayCounts,
  indexed: Indexed,
  pages: ReadonlyArray<PlannedPage>,
  complete: boolean,
  at: number,
  limit = INGEST_BYTES_IN_WINDOW,
  days = WINDOW_DAYS,
): { readonly planned: Planned; readonly ingested: DayCounts } {
  const first = utcDay(at - (days - 1) * 24 * 60 * 60 * 1000);
  const kept: Record<string, number> = Object.fromEntries(
    Object.entries(ingested).filter(([day]) => day >= first),
  );
  let counted = used(kept, at, days);
  const upload: Array<string> = [];
  const refused: Array<string> = [];
  let unchanged = 0;
  for (const page of pages) {
    if (indexed[page.key]?.hash === page.hash) {
      unchanged += 1;
    } else if (counted + page.bytes <= limit) {
      counted += page.bytes;
      upload.push(page.key);
    } else {
      refused.push(page.key);
    }
  }
  const given = new Set(pages.map((page) => page.key));
  const remove = complete
    ? Object.entries(indexed)
        .filter(([key]) => !given.has(key))
        .map(([key, { id }]) => ({ key, id }))
    : [];
  const today = utcDay(at);
  const added = counted - used(kept, at, days);
  const previous = upload.flatMap((key) => {
    const id = indexed[key]?.id;
    return id === undefined ? [] : [{ key, id }];
  });
  return {
    planned: {
      upload,
      previous,
      refused,
      unchanged,
      remove,
      used: counted,
      limit,
    },
    ingested:
      added > 0 ? { ...kept, [today]: (kept[today] ?? 0) + added } : kept,
  };
}

/** Where the indexer asks the object for a plan. */
export const planPath = "/plan";

/** Where the indexer tells the object what it uploaded and removed. */
export const recordPath = "/record";

/** The most pages one plan takes: far past the site's. */
export const pagesLimit = 2_000;

const ingestedKey = "ingested";
const indexedKey = "indexed";

const isPage = (value: unknown): value is PlannedPage =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PlannedPage).key === "string" &&
  typeof (value as PlannedPage).hash === "string" &&
  Number.isSafeInteger((value as PlannedPage).bytes) &&
  (value as PlannedPage).bytes >= 0;

const refusal = (problem: string) =>
  Response.json({ error: problem }, { status: 400 });

/**
 * The object's answer to {@link planPath} (`{ pages, complete }` → a
 * {@link Planned}) and {@link recordPath} (`{ uploaded, removed }`). Each
 * reads, decides and writes with nothing awaited between but the storage
 * itself, as budget.ts's count does.
 */
export async function ledgerAnswer(
  state: BudgetState,
  request: Request,
  now: () => number = Date.now,
  limit = INGEST_BYTES_IN_WINDOW,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const body: unknown = await request.json().catch(() => undefined);
  if (typeof body !== "object" || body === null) {
    return refusal("the body isn't a JSON object");
  }
  if (path === planPath) {
    const { pages, complete } = body as { pages?: unknown; complete?: unknown };
    if (
      !Array.isArray(pages) ||
      pages.length > pagesLimit ||
      !pages.every(isPage) ||
      typeof complete !== "boolean"
    ) {
      return refusal(
        "a plan takes { pages: [{ key, hash, bytes }], complete }",
      );
    }
    const ingested = (await state.storage.get<DayCounts>(ingestedKey)) ?? {};
    const indexed = (await state.storage.get<Indexed>(indexedKey)) ?? {};
    const result = plan(ingested, indexed, pages, complete, now(), limit);
    await state.storage.put(ingestedKey, result.ingested);
    return Response.json(result.planned);
  }
  const { uploaded, removed } = body as {
    uploaded?: unknown;
    removed?: unknown;
  };
  if (
    !Array.isArray(uploaded) ||
    !uploaded.every(
      (page: unknown) =>
        typeof page === "object" &&
        page !== null &&
        typeof (page as { key?: unknown }).key === "string" &&
        typeof (page as { hash?: unknown }).hash === "string" &&
        typeof (page as { id?: unknown }).id === "string",
    ) ||
    !Array.isArray(removed) ||
    !removed.every((key: unknown) => typeof key === "string")
  ) {
    return refusal(
      "a record takes { uploaded: [{ key, hash, id }], removed: [key] }",
    );
  }
  const indexed: Record<string, IndexedPage> = {
    ...(await state.storage.get<Indexed>(indexedKey)),
  };
  for (const { key, hash, id } of uploaded as ReadonlyArray<
    IndexedPage & { readonly key: string }
  >) {
    indexed[key] = { hash, id };
  }
  for (const key of removed as ReadonlyArray<string>) delete indexed[key];
  await state.storage.put(indexedKey, indexed);
  return Response.json({ indexed: Object.keys(indexed).length });
}
