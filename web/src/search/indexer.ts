import type { Items } from "./bindings.ts";
import {
  type BudgetState,
  type DayCounts,
  used,
  utcDay,
  WINDOW_DAYS,
} from "./budget.ts";

/**
 * Indexing the site's pages for search (route.ts), done by the search's
 * Durable Object itself (worker.ts's `SearchBudget`, which also counts the
 * searches), so one place holds the index's record and changes it, one run
 * at a time.
 *
 * AI Search bills ingestion past each month's included 5,000,000 tokens,
 * $0.75 per million more, counted with the cl100k_base tokenizer on the
 * chunks it indexes, overlaps included
 * (https://developers.cloudflare.com/ai-search/platform/limits-pricing/).
 * Every cl100k_base token is at least one byte of the text it encodes, and
 * the index's chunks don't overlap (infra/src/search.ts), so a page's UTF-8
 * bytes bound the tokens it is billed. The object sends at most
 * {@link INGEST_BYTES_IN_WINDOW} bytes in any {@link WINDOW_DAYS} UTC days,
 * the searches' window, and leaves the rest until there's room.
 *
 * Each page's bytes are counted, and the count stored, before its upload
 * is sent: a Durable Object sends nothing out until what it wrote is
 * stored. They're counted on the day they're sent. Built-in storage
 * indexes a file as it arrives ("Files uploaded to built-in storage are
 * indexed immediately",
 * https://developers.cloudflare.com/ai-search/configuration/data-source/built-in-storage/),
 * and the window is a day longer than any billing period, so an upload
 * indexed after midnight still falls inside it.
 *
 * Its record of each page (`indexed`) is the Markdown's hash and its
 * item's id. A page whose hash is the one recorded is left alone. A
 * changed page's old item is removed, the page is marked pending, and
 * then it's uploaded and its item recorded. A run that stops part-way (a
 * deploy restarts the object) leaves pages pending: the next run removes
 * whatever item each one's key holds and uploads it anew. An upload only
 * queues a page, so a later run reads each new item's status, and one
 * Cloudflare failed to index is removed and uploaded again. A page the
 * sitemap no longer lists is removed once a run has every page.
 */

/**
 * The most bytes sent in any {@link WINDOW_DAYS} days: a million under the
 * 5,000,000 tokens included, since bytes bound tokens. English runs about
 * four bytes a token, so what's billed is well under it, and the million
 * left is for what Cloudflare indexes again on its own: all of it, about
 * 315,000 bytes, at most once for each change to how it indexes.
 */
export const INGEST_BYTES_IN_WINDOW = 4_000_000;

/** A page to index: its item's key and its Markdown. */
export interface Page {
  readonly key: string;
  readonly markdown: string;
}

/** What the object holds of each page. */
export type Entry =
  /** Uploaded as `hash`, item `id`; `settled` once Cloudflare said it indexed it. */
  | {
      readonly hash: string;
      readonly id: string;
      readonly settled?: true;
    }
  /** Its upload was on its way when a run stopped: what the key holds is unknown. */
  | { readonly pending: string };

/** What a run did, as the prewarm's answer says it. */
export interface IndexReport {
  /** Pages uploaded now. */
  readonly uploaded: number;
  /** Pages indexed as they are, so left alone. */
  readonly unchanged: number;
  /** Pages changed that the window has no room for yet. */
  readonly refused: number;
  /** Pages the sitemap no longer lists, removed. */
  readonly removed: number;
  /** Pages uploaded before that Cloudflare has now said it indexed. */
  readonly settled: number;
  /** Pages Cloudflare failed to index, or a stopped run left: removed, to upload again. */
  readonly reset: number;
  /** Pages whose upload, removal or check failed, by key: tried again next run. */
  readonly failed: ReadonlyArray<string>;
  /** Bytes sent in the window, this run's included, and its limit. */
  readonly used: number;
  readonly limit: number;
  /** Another run was indexing, so this one did nothing. */
  readonly busy?: true;
}

/** Requests to the index at once. */
export const concurrency = 4;

const ingestedKey = "ingested";
const indexedKey = "indexed";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `error` is Cloudflare saying the item isn't there
 * (`item_not_found`): one already gone, which is what a removal wants.
 */
export const gone = (error: unknown): boolean =>
  /not[_ ]found/i.test(error instanceof Error ? error.message : String(error));

/** Removes item `id`; one already gone is removed too. */
const remove = async (items: Items, id: string) => {
  await items.delete(id).catch((error: unknown) => {
    if (!gone(error)) throw error;
  });
};

/** Runs `work` on each of `entries`, {@link concurrency} at once. */
async function each<T>(
  entries: ReadonlyArray<T>,
  work: (entry: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      while (next < entries.length) {
        const entry = entries[next];
        next += 1;
        if (entry !== undefined) await work(entry);
      }
    }),
  );
}

const sha256 = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Indexes `pages` into `items`, keeping the record in `state`. `complete`
 * says the sitemap was read and every page it lists came back as a
 * document, so a page recorded and not given has left the site. The
 * caller holds the object's lock (worker.ts), so no other run is changing
 * the record meanwhile.
 */
export async function indexSite(
  state: BudgetState,
  items: Items,
  pages: ReadonlyArray<Page>,
  complete: boolean,
  // Tests give a clock and a limit; the object gives neither.
  now: () => number = Date.now,
  limit = INGEST_BYTES_IN_WINDOW,
): Promise<IndexReport> {
  // The record and the counts live in memory for the run: each change is
  // made at once, then stored whole, so runs of the pages at once never
  // lose one another's.
  const record: Record<string, Entry> = {
    ...(await state.storage.get<Record<string, Entry>>(indexedKey)),
  };
  const first = utcDay(now() - (WINDOW_DAYS - 1) * DAY_MS);
  const counts: Record<string, number> = Object.fromEntries(
    Object.entries(
      (await state.storage.get<DayCounts>(ingestedKey)) ?? {},
    ).filter(([day]) => day >= first),
  );
  const keep = () => state.storage.put(indexedKey, record);
  const failed: Array<string> = [];
  let uploaded = 0;
  let refused = 0;
  let removed = 0;
  let settled = 0;
  let reset = 0;

  // A run that stopped part-way left pages pending: whatever their keys
  // hold now is removed, so each is uploaded anew below.
  const pending = Object.entries(record).filter(
    ([, entry]) => "pending" in entry,
  );
  await each(pending, async ([key]) => {
    try {
      const { result } = await items.list({ search: key, per_page: 50 });
      for (const item of result) {
        if (item.key === key) await remove(items, item.id);
      }
      delete record[key];
      await keep();
      reset += 1;
    } catch {
      failed.push(key);
    }
  });

  const given = await Promise.all(
    pages.map(async (page) => ({
      ...page,
      hash: await sha256(page.markdown),
      bytes: new TextEncoder().encode(page.markdown).byteLength,
    })),
  );
  const changed = given.filter((page) => {
    const entry = record[page.key];
    return (
      entry === undefined || !("hash" in entry) || entry.hash !== page.hash
    );
  });
  await each(changed, async (page) => {
    const entry = record[page.key];
    if (entry !== undefined && "pending" in entry) return; // left above
    // Counted, and the count stored, before anything is sent.
    const at = now();
    if (used(counts, at) + page.bytes > limit) {
      refused += 1;
      return;
    }
    const day = utcDay(at);
    counts[day] = (counts[day] ?? 0) + page.bytes;
    await state.storage.put(ingestedKey, counts);
    try {
      if (entry !== undefined) await remove(items, entry.id);
      record[page.key] = { pending: page.hash };
      await keep();
      const { id } = await items.upload(page.key, page.markdown);
      record[page.key] = { hash: page.hash, id };
      await keep();
      uploaded += 1;
    } catch {
      failed.push(page.key);
    }
  });

  if (complete) {
    const listed = new Set(given.map((page) => page.key));
    const left = Object.entries(record).filter(
      ([key, entry]) => !listed.has(key) && "id" in entry,
    );
    await each(left, async ([key, entry]) => {
      try {
        if ("id" in entry) await remove(items, entry.id);
        delete record[key];
        await keep();
        removed += 1;
      } catch {
        failed.push(key);
      }
    });
  }

  // An upload only queues a page: its item says, later, how it went.
  // A page uploaded this run is still queued: it's asked about next run.
  const sent = new Set(changed.map((page) => page.key));
  const unsettled = given.flatMap((page) => {
    const entry = record[page.key];
    return entry !== undefined &&
      "id" in entry &&
      entry.settled !== true &&
      entry.hash === page.hash &&
      !sent.has(page.key)
      ? [{ key: page.key, id: entry.id, hash: entry.hash }]
      : [];
  });
  await each(unsettled, async ({ key, id, hash }) => {
    try {
      const { status } = await items.get(id).info();
      if (status === "completed") {
        record[key] = { hash, id, settled: true };
        settled += 1;
      } else if (status === "error" || status === "skipped") {
        await remove(items, id);
        delete record[key];
        reset += 1;
      } else {
        return; // queued or running: asked again next run
      }
      await keep();
    } catch (error) {
      // An item that's gone isn't indexed: the page is uploaded again next run.
      if (gone(error)) {
        delete record[key];
        await keep();
        reset += 1;
      } else {
        failed.push(key);
      }
    }
  });

  return {
    uploaded,
    unchanged: given.length - changed.length,
    refused,
    removed,
    settled,
    reset,
    failed,
    used: used(counts, now()),
    limit,
  };
}
