import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Migrator from "effect/sql/Migrator";
import { migrations } from "../migrations/index.ts";
import * as Migrations from "../src/migrator.ts";
import { migratedDatabase, sqlLayer } from "./support/database.ts";

/**
 * migrations/0042_venue_guests_only.ts on a database holding evenings as
 * production does before it: each one the venue visibility will ask about,
 * published, not over and with a Luma page, starts hidden, and no other.
 * The migration reads the database's clock, so the evenings ahead end in
 * 2099 and those over ended in 2020.
 */

/** The migrations before `id`, as production had them then. */
const before = (id: string) =>
  Migrator.fromRecord(
    Object.fromEntries(Object.entries(migrations).filter(([key]) => key < id)),
  );

const db = await migratedDatabase(before("0042"));
afterAll(() => db.close());

/** Each evening, and whether its venue starts hidden. */
const evenings = [
  {
    slug: "upcoming",
    draft: false,
    luma: "evt-upcoming",
    start: "2099-01-01T02:00:00Z",
    end: "2099-01-01T05:00:00Z",
    hidden: true,
  },
  {
    slug: "live",
    draft: false,
    luma: "evt-live",
    start: "2020-01-01T02:00:00Z",
    end: "2099-01-01T05:00:00Z",
    hidden: true,
  },
  {
    slug: "over",
    draft: false,
    luma: "evt-over",
    start: "2020-01-01T02:00:00Z",
    end: "2020-01-01T05:00:00Z",
    hidden: false,
  },
  // The feed sync hides a draft's venue when it is published.
  {
    slug: "draft",
    draft: true,
    luma: "evt-draft",
    start: "2099-01-01T02:00:00Z",
    end: "2099-01-01T05:00:00Z",
    hidden: false,
  },
  // Never asked about, so nothing would ever show it again.
  {
    slug: "no-luma-page",
    draft: false,
    luma: null,
    start: "2099-01-01T02:00:00Z",
    end: "2099-01-01T05:00:00Z",
    hidden: false,
  },
] as const;

test("hides the venue of each evening the venue visibility will ask about, until it has, and of no other", async () => {
  for (const evening of evenings) {
    await db.query(
      `INSERT INTO events (slug, name, tagline, start_date, end_date, attendee_limit, is_draft, luma_event_id, updated_at)
       VALUES ($1, $1, '', $2, $3, 100, $4, $5, '2020-01-01T00:00:00Z')`,
      [evening.slug, evening.start, evening.end, evening.draft, evening.luma],
    );
  }
  expect(
    await Effect.runPromise(
      Migrations.run(before("0043")).pipe(Effect.provide(sqlLayer(db))),
    ),
  ).toEqual([{ id: 42, name: "venue_guests_only" }]);
  const stored = await db.query<{
    slug: string;
    venue_guests_only: boolean;
    venue_reveal_token: string | null;
    changed: boolean;
  }>(
    `SELECT slug, venue_guests_only, venue_reveal_token,
       updated_at > '2020-01-01T00:00:00Z' AS changed
     FROM events ORDER BY slug`,
  );
  expect(stored.rows).toEqual(
    evenings
      .map(({ slug, hidden }) => ({
        slug,
        venue_guests_only: hidden,
        venue_reveal_token: null,
        changed: hidden,
      }))
      .toSorted((a, b) => a.slug.localeCompare(b.slug)),
  );
});
