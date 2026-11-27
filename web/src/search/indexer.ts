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
 * at a time (object.ts holds the lock).
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
 * stored. They're counted on the day they're sent, which built-in storage
 * indexes them on ("Files uploaded to built-in storage are indexed
 * immediately",
 * https://developers.cloudflare.com/ai-search/configuration/data-source/built-in-storage/);
 * if midnight passes between counting and sending, the count moves to the
 * new day first. The window is a day longer than any billing period.
 *
 * Its record of each page (`indexed`) is the Markdown's hash and its
 * item's id. A page whose hash is the one recorded is left alone. A
 * changed page's old item is removed (if that fails, nothing is sent, and
 * its bytes are given back), the page is marked pending, and then it's
 * uploaded and its item recorded. A run that stops part-way (a deploy
 * restarts the object) leaves the page pending: the next run with its
 * document removes whatever item its key holds and uploads it anew.
 *
 * What this doesn't do yet: remove a page the sitemap no longer lists, or
 * check that Cloudflare finished indexing an upload. Each is a change of
 * its own.
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
  /** Uploaded as `hash`, item `id`. */
  | { readonly hash: string; readonly id: string }
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
  /** Pages a stopped run left pending, whose items went before they're uploaded anew. */
  readonly reset: number;
  /** Pages whose upload or removal failed, by key: tried again next run. */
  readonly failed: ReadonlyArray<string>;
  /** Bytes sent in the window, this run's included, and its limit. */
  readonly used: number;
  readonly limit: number;
  /** Another run was indexing: it indexes this one's pages next. */
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

/** Each item Cloudflare holds under exactly `key`, through every page of its list. */
async function heldUnder(items: Items, key: string): Promise<Array<string>> {
  const ids: Array<string> = [];
  for (let page = 1; page <= 20; page++) {
    const { result } = await items.list({ search: key, per_page: 50, page });
    for (const item of result) if (item.key === key) ids.push(item.id);
    if (result.length < 50) break;
  }
  return ids;
}

/** Runs `work` on each of `entries`, {@link concurrency} at once, in order. */
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
 * Indexes `pages` into `items`, keeping the record in `state`. Pages are
 * let through the window in the order given. The caller holds the
 * object's lock (object.ts), so no other run is changing the record
 * meanwhile.
 */
export async function indexSite(
  state: BudgetState,
  items: Items,
  pages: ReadonlyArray<Page>,
  // Tests give a clock and a limit; the object gives neither.
  now: () => number = Date.now,
  limit = INGEST_BYTES_IN_WINDOW,
): Promise<IndexReport> {
  // The record and the counts live in memory for the run: each change is
  // made at once, then stored whole, so pages at once never lose one
  // another's.
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
  const keepCounts = () => state.storage.put(ingestedKey, counts);
  const failed: Array<string> = [];
  let uploaded = 0;
  let refused = 0;
  let reset = 0;

  // A page a stopped run left pending, which this run has the document of:
  // whatever its key holds now is removed, so it's uploaded anew below.
  const given = new Set(pages.map((page) => page.key));
  const pending = Object.entries(record).filter(
    ([key, entry]) => "pending" in entry && given.has(key),
  );
  await each(pending, async ([key]) => {
    try {
      for (const id of await heldUnder(items, key)) await remove(items, id);
      delete record[key];
      await keep();
      reset += 1;
    } catch {
      failed.push(key);
    }
  });

  const hashed = await Promise.all(
    pages.map(async (page) => ({
      ...page,
      hash: await sha256(page.markdown),
      bytes: new TextEncoder().encode(page.markdown).byteLength,
    })),
  );
  const changed = hashed.filter((page) => {
    const entry = record[page.key];
    return (
      entry === undefined || !("hash" in entry) || entry.hash !== page.hash
    );
  });
  await each(changed, async (page) => {
    const entry = record[page.key];
    if (entry !== undefined && "pending" in entry) return; // its reset failed
    // Counted, and the count stored, before anything is sent.
    const at = now();
    if (used(counts, at) + page.bytes > limit) {
      refused += 1;
      return;
    }
    const day = utcDay(at);
    counts[day] = (counts[day] ?? 0) + page.bytes;
    await keepCounts();
    if (entry !== undefined) {
      try {
        await remove(items, entry.id);
      } catch {
        // Nothing of the page was sent: its bytes go back, and it waits for
        // the next run with its old item in place.
        counts[day] = (counts[day] ?? 0) - page.bytes;
        await keepCounts();
        failed.push(page.key);
        return;
      }
    }
    try {
      record[page.key] = { pending: page.hash };
      await keep();
      // The count goes on the day the upload is sent: past midnight since
      // it was taken, it moves to the new day, stored before it's sent.
      const sending = utcDay(now());
      if (sending !== day) {
        counts[day] = (counts[day] ?? 0) - page.bytes;
        counts[sending] = (counts[sending] ?? 0) + page.bytes;
        await keepCounts();
      }
      const { id } = await items.upload(page.key, page.markdown);
      record[page.key] = { hash: page.hash, id };
      await keep();
      uploaded += 1;
    } catch {
      failed.push(page.key);
    }
  });

  return {
    uploaded,
    unchanged: hashed.length - changed.length,
    refused,
    reset,
    failed,
    used: used(counts, now()),
    limit,
  };
}
