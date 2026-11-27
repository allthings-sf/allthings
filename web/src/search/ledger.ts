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
  /**
   * Cloudflare has said it indexed the item. An upload only queues it, so
   * until a later run reads its status, it isn't taken as indexed for good.
   */
  readonly settled?: true;
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
  /** Pages uploaded as they are, whose indexing hasn't been confirmed yet. */
  readonly check: ReadonlyArray<{ readonly key: string; readonly id: string }>;
  /** Bytes counted in the window, these included. */
  readonly used: number;
  readonly limit: number;
  /** Another run holds the index, so this one does nothing. */
  readonly busy?: true;
}

/**
 * How long one run holds the index, in milliseconds: past the longest
 * prewarm a deploy waits for (10 minutes), so a run that never records
 * lets go of it on its own. Its uploads are all sent by then.
 */
export const leaseMs = 15 * 60 * 1000;

/**
 * Plans an indexing run at `at`: each page whose hash isn't the one indexed
 * is let through, in the order given, while the window has room for its
 * bytes, and counted on the day the run's hold ends ({@link leaseMs}), the
 * latest any of its uploads can be sent, so a run that crosses midnight is
 * counted on the day Cloudflare can bill it; the rest are refused. With `complete`
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
  const check: Array<{ key: string; id: string }> = [];
  let unchanged = 0;
  for (const page of pages) {
    const before = indexed[page.key];
    if (before?.hash === page.hash) {
      unchanged += 1;
      if (before.settled !== true) check.push({ key: page.key, id: before.id });
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
  const today = utcDay(at + leaseMs);
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
      check,
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
const leaseKey = "lease";

/** The run that holds the index, and until when. */
interface Lease {
  readonly run: string;
  readonly until: number;
}

const isPage = (value: unknown): value is PlannedPage =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PlannedPage).key === "string" &&
  typeof (value as PlannedPage).hash === "string" &&
  Number.isSafeInteger((value as PlannedPage).bytes) &&
  (value as PlannedPage).bytes >= 0;

/** Whether `value` names a page and an item: `{ key, id }`, and `hash` if `withHash`. */
const isItem = (value: unknown, withHash: boolean): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { key?: unknown }).key === "string" &&
  typeof (value as { id?: unknown }).id === "string" &&
  (!withHash || typeof (value as { hash?: unknown }).hash === "string");

const refusal = (problem: string, status = 400) =>
  Response.json({ error: problem }, { status });

/**
 * The object's answer to {@link planPath} (`{ run, pages, complete }` → a
 * {@link Planned}) and {@link recordPath} (`{ run, uploaded, removed }`).
 * One run holds the index from its plan to its record, so two prewarms at
 * once (the hourly sync's and a deploy's) never plan the same pages or
 * record over each other: a plan while another run holds it is `busy`, and
 * plans nothing. Each request reads, decides and writes with nothing
 * awaited between but the storage itself, as budget.ts's count does.
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
  const { run } = body as { run?: unknown };
  if (typeof run !== "string" || run === "") {
    return refusal("a plan or a record names its run");
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
        "a plan takes { run, pages: [{ key, hash, bytes }], complete }",
      );
    }
    const at = now();
    const lease = await state.storage.get<Lease>(leaseKey);
    const ingested = (await state.storage.get<DayCounts>(ingestedKey)) ?? {};
    if (lease !== undefined && lease.run !== run && lease.until > at) {
      const busy: Planned = {
        upload: [],
        previous: [],
        refused: [],
        unchanged: 0,
        remove: [],
        check: [],
        used: used(ingested, at),
        limit,
        busy: true,
      };
      return Response.json(busy);
    }
    const indexed = (await state.storage.get<Indexed>(indexedKey)) ?? {};
    const result = plan(ingested, indexed, pages, complete, at, limit);
    await state.storage.put(ingestedKey, result.ingested);
    await state.storage.put(leaseKey, { run, until: at + leaseMs });
    return Response.json(result.planned);
  }
  const { uploaded, removed, settled } = body as {
    uploaded?: unknown;
    removed?: unknown;
    settled?: unknown;
  };
  const items = (value: unknown, withHash: boolean) =>
    Array.isArray(value) &&
    value.every((page: unknown) => isItem(page, withHash));
  if (
    !items(uploaded, true) ||
    !items(removed, false) ||
    !items(settled ?? [], false)
  ) {
    return refusal(
      "a record takes { run, uploaded: [{ key, hash, id }], removed: [{ key, id }], settled: [{ key, id }] }",
    );
  }
  const lease = await state.storage.get<Lease>(leaseKey);
  if (lease?.run !== run) {
    return refusal("another run holds the index, or none does", 409);
  }
  const indexed: Record<string, IndexedPage> = {
    ...(await state.storage.get<Indexed>(indexedKey)),
  };
  for (const { key, hash, id } of uploaded as ReadonlyArray<
    IndexedPage & { readonly key: string }
  >) {
    indexed[key] = { hash, id };
  }
  // Indexed for good, by Cloudflare's word.
  for (const { key, id } of (settled ?? []) as ReadonlyArray<{
    readonly key: string;
    readonly id: string;
  }>) {
    const page = indexed[key];
    if (page?.id === id) indexed[key] = { ...page, settled: true };
  }
  // Only the item the run removed: one uploaded since stays recorded.
  for (const { key, id } of removed as ReadonlyArray<{
    readonly key: string;
    readonly id: string;
  }>) {
    if (indexed[key]?.id === id) delete indexed[key];
  }
  await state.storage.put(indexedKey, indexed);
  await state.storage.put(leaseKey, { run, until: 0 });
  return Response.json({ indexed: Object.keys(indexed).length });
}
