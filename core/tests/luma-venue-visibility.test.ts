import { afterAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { DateTime, Effect, Exit, Layer } from "effect";
import { HttpClient } from "effect/http";
import { LumaApi } from "../src/luma/api.ts";
import {
  LumaVenueVisibility,
  type VenueVisibility,
  type VenueVisibilityOptions,
} from "../src/luma/venue-visibility.ts";
import { LumaVenues } from "../src/luma/venues.ts";
import {
  clockAt,
  clockLayer,
  seededDatabase,
  sqlLayer,
} from "./support/database.ts";
import {
  configFrom,
  fakeLumaBy,
  fixture,
  type Reply,
  settle,
} from "./support/luma.ts";

/**
 * Whether Luma shows each evening's venue to guests only, from Luma's API
 * (src/luma/venue-visibility.ts), against tests/seed.sql at its clock,
 * 2026-10-03T19:00:00Z, with Luma answering from fixtures in the shape
 * docs.luma.com documents. No test reaches Luma.
 */

const managed = await fixture("event-manage.json");
const withKey = { LUMA_API_KEY: "test-key" };

/** Luma's answer for `id`, its venue shown to `visibility`. */
const answer = (id: string, visibility = "guests-only"): Reply => {
  const event = JSON.parse(managed) as Record<string, unknown>;
  return {
    body: JSON.stringify({ ...event, id, location_visibility: visibility }),
  };
};

/** A fake Luma answering by the event each request asks about. */
const fakeApi = (replies: Readonly<Record<string, ReadonlyArray<Reply>>>) =>
  fakeLumaBy((url) => url.searchParams.get("event_id") ?? "", replies);

const opened: Array<PGlite> = [];
afterAll(() => Promise.all(opened.map((db) => db.close())));

/**
 * tests/seed.sql, with Luma ids on the upcoming evening, which also gets a
 * venue, and on the one live at the clock, which ends at it.
 */
const database = async () => {
  const db = await seededDatabase();
  opened.push(db);
  await db.exec(`
    UPDATE events SET luma_event_id = 'evt-upcoming',
        street_address = '201 Spear St', short_location = '201 Spear St',
        full_address = '201 Spear St, San Francisco, CA 94105, USA',
        updated_at = '2026-01-01T00:00:00Z'
      WHERE id = 'e0000000-0000-4000-8000-000000000004';
    UPDATE events SET luma_event_id = 'evt-endsnow', updated_at = '2026-01-01T00:00:00Z'
      WHERE id = 'e0000000-0000-4000-8000-000000000005';
  `);
  return db;
};

const check = async (
  db: PGlite,
  replies: Readonly<Record<string, ReadonlyArray<Reply>>>,
  options: Partial<VenueVisibilityOptions> & {
    env?: Record<string, string>;
    /** The clock's instant; the seed's by default. */
    at?: DateTime.Utc;
  } = {},
): Promise<{
  result: VenueVisibility;
  asked: ReadonlyArray<string | null>;
}> => {
  const { env = withKey, at, ...rest } = options;
  const luma = fakeApi(replies);
  const exit = await Effect.runPromiseExit(
    settle(
      LumaVenueVisibility.use((visibility) =>
        visibility.run({ dryRun: false, ...rest }),
      ),
    ).pipe(
      Effect.provide(
        LumaVenueVisibility.layer.pipe(
          Layer.provide(LumaApi.layer),
          Layer.provide(Layer.mergeAll(luma.layer, configFrom(env))),
          Layer.provideMerge(sqlLayer(db)),
          Layer.provideMerge(at === undefined ? clockLayer : clockAt(at)),
        ),
      ),
    ),
  );
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return {
    result: exit.value,
    asked: luma.requests.map(({ url }) =>
      new URL(url).searchParams.get("event_id"),
    ),
  };
};

/** Each evening's setting and when its row last changed, by slug. */
const stored = async (db: PGlite) =>
  Object.fromEntries(
    (
      await db.query<{
        slug: string;
        venue_guests_only: boolean;
        updated_at: Date;
      }>("SELECT slug, venue_guests_only, updated_at FROM events ORDER BY slug")
    ).rows.map(({ slug, venue_guests_only, updated_at }) => [
      slug,
      { guestsOnly: venue_guests_only, updatedAt: updated_at.toISOString() },
    ]),
  );

const both = {
  "evt-upcoming": [answer("evt-upcoming")],
  "evt-endsnow": [answer("evt-endsnow", "public")],
};

describe("the venue visibility", () => {
  test("does nothing without LUMA_API_KEY", async () => {
    const db = await database();
    const before = await stored(db);
    const { result, asked } = await check(db, both, { env: {} });
    expect(result).toEqual({
      _tag: "Skipped",
      reason: "LUMA_API_KEY is not set",
    });
    expect(asked).toEqual([]);
    expect(await stored(db)).toEqual(before);
  });

  test("asks about every published evening not over with a Luma page, its venue stored or not, and marks the ones kept to guests", async () => {
    const db = await database();
    const before = await stored(db);
    const { result, asked } = await check(db, both);
    // Soonest first. React at Acme is over and the draft is a draft: neither
    // is asked about.
    expect(asked).toEqual(["evt-endsnow", "evt-upcoming"]);
    expect(result).toEqual({
      _tag: "Planned",
      asked: 2,
      guestsOnly: ["2026-11-05-upcoming"],
      changed: [
        {
          eventId: "e0000000-0000-4000-8000-000000000004",
          slug: "2026-11-05-upcoming",
          lumaEventId: "evt-upcoming",
          guestsOnly: true,
        },
      ],
      unavailable: [],
      written: 1,
    });
    expect(await stored(db)).toEqual({
      ...before,
      "2026-11-05-upcoming": {
        guestsOnly: true,
        updatedAt: "2026-10-03T19:00:00.000Z",
      },
    });
    // Asked again, Luma says the same: nothing changes.
    const again = await check(db, both);
    expect(again.result).toMatchObject({ changed: [], written: 0 });
  });

  test("clears the mark once Luma shows the venue to everyone", async () => {
    const db = await database();
    await db.exec(
      `UPDATE events SET venue_guests_only = true WHERE slug = '2026-11-05-upcoming'`,
    );
    const { result } = await check(db, {
      ...both,
      "evt-upcoming": [answer("evt-upcoming", "public")],
    });
    expect(result).toMatchObject({
      guestsOnly: [],
      changed: [{ slug: "2026-11-05-upcoming", guestsOnly: false }],
      written: 1,
    });
    expect((await stored(db))["2026-11-05-upcoming"]?.guestsOnly).toBe(false);
  });

  test("never asks about an evening over, which keeps what was last read", async () => {
    const db = await database();
    await db.exec(
      `UPDATE events SET venue_guests_only = true WHERE slug = '2026-08-12-react-at-acme'`,
    );
    const { asked } = await check(db, both);
    expect(asked).not.toContain("evt-react");
    expect((await stored(db))["2026-08-12-react-at-acme"]?.guestsOnly).toBe(
      true,
    );
  });

  test("asks about at most maxEvents, in turn, the next ones each hour", async () => {
    const db = await database();
    // Both evenings are ahead at either hour; each asks about the other.
    const asked: Array<ReadonlyArray<string | null>> = [];
    for (const instant of [
      "2026-10-03T17:00:00Z",
      "2026-10-03T18:00:00Z",
      "2026-10-03T19:00:00Z",
    ]) {
      const run = await check(db, both, {
        maxEvents: 1,
        dryRun: true,
        at: DateTime.makeUnsafe(instant),
      });
      expect(run.result).toMatchObject({ asked: 1 });
      asked.push(run.asked);
    }
    expect(asked).toEqual([
      ["evt-upcoming"],
      ["evt-endsnow"],
      ["evt-upcoming"],
    ]);
    // As many as there are, or more, asks about every one, soonest first.
    const all = await check(db, both, { maxEvents: 2, dryRun: true });
    expect(all.asked).toEqual(["evt-endsnow", "evt-upcoming"]);
  });

  test("a dry run asks about the evenings as the rehearsed sync would leave them; a run that writes, as stored", async () => {
    const db = await database();
    const before = await stored(db);
    const rehearsed = [
      // The seed's draft, published and moved ahead.
      {
        lumaEventId: "evt-draft",
        slug: "2026-09-01-draft-night",
        isDraft: false,
        startDate: "2026-10-09T01:00:00Z",
        endDate: "2026-10-09T04:00:00Z",
      },
      // An evening the sync would create.
      {
        lumaEventId: "evt-new",
        slug: "2026-10-08-new-night-evt-new",
        isDraft: false,
        startDate: "2026-10-09T02:00:00Z",
        endDate: "2026-10-09T05:00:00Z",
      },
      // The upcoming meetup, cancelled: a draft now.
      {
        lumaEventId: "evt-upcoming",
        slug: "2026-11-05-upcoming",
        isDraft: true,
        startDate: null,
        endDate: null,
      },
    ];
    const replies = {
      ...both,
      "evt-draft": [answer("evt-draft", "public")],
      "evt-new": [answer("evt-new")],
    };
    const dry = await check(db, replies, { dryRun: true, rehearsed });
    expect(dry.asked).toEqual(["evt-endsnow", "evt-draft", "evt-new"]);
    expect(dry.result).toMatchObject({
      asked: 3,
      guestsOnly: ["2026-10-08-new-night-evt-new"],
      changed: [
        {
          slug: "2026-09-01-draft-night",
          guestsOnly: false,
        },
        {
          eventId: "pending:evt-new",
          slug: "2026-10-08-new-night-evt-new",
          guestsOnly: true,
        },
      ],
      written: null,
    });
    expect(await stored(db)).toEqual(before);
    const wrote = await check(db, replies, { rehearsed });
    expect(wrote.asked).toEqual(["evt-endsnow", "evt-upcoming"]);
  });

  test("a dry run plans the same and writes nothing", async () => {
    const db = await database();
    const before = await stored(db);
    const { result } = await check(db, both, { dryRun: true });
    expect(result).toMatchObject({
      asked: 2,
      changed: [{ slug: "2026-11-05-upcoming", guestsOnly: true }],
      written: null,
    });
    expect(await stored(db)).toEqual(before);
  });

  test("leaves an evening Luma doesn't show us as it is", async () => {
    const db = await database();
    const before = await stored(db);
    const { result } = await check(db, {
      ...both,
      "evt-upcoming": [{ status: 404 }],
    });
    expect(result).toMatchObject({
      unavailable: ["evt-upcoming"],
      changed: [],
      written: 0,
    });
    expect(await stored(db)).toEqual(before);
  });

  test("a failure asking about any evening writes nothing but the guests-only answers already read", async () => {
    // Luma keeps failing about the evening live now, until the retries run
    // out; meanwhile it keeps the upcoming one to guests, which is marked.
    const marked = await database();
    const before = await stored(marked);
    await expect(
      check(marked, { ...both, "evt-endsnow": [{ status: 503 }] }),
    ).rejects.toThrow();
    expect(await stored(marked)).toEqual({
      ...before,
      "2026-11-05-upcoming": {
        guestsOnly: true,
        updatedAt: "2026-10-03T19:00:00.000Z",
      },
    });
    // Luma would show the upcoming one's venue again: that waits for every
    // answer, so nothing is written.
    const kept = await database();
    await kept.exec(
      `UPDATE events SET venue_guests_only = true WHERE slug = '2026-11-05-upcoming'`,
    );
    const hidden = await stored(kept);
    await expect(
      check(kept, {
        "evt-upcoming": [answer("evt-upcoming", "public")],
        "evt-endsnow": [{ status: 503 }],
      }),
    ).rejects.toThrow();
    expect(await stored(kept)).toEqual(hidden);
    expect((await upcoming(kept))?.venue_reveal_token).toBeNull();
  });
});

/**
 * A fake Luma that, once it has answered about `id` for the `nth` time,
 * holds that answer until `release`: whoever asked has read the evening and
 * has Luma's answer, and goes on only when released. `paused` settles once
 * it holds it.
 */
const heldLuma = (
  replies: Readonly<Record<string, ReadonlyArray<Reply>>>,
  id: string,
  nth: number,
) => {
  const luma = fakeApi(replies);
  let hold!: () => void;
  const paused = new Promise<void>((resolve) => {
    hold = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = 0;
  const layer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (inner) =>
      HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const response = yield* inner.execute(request);
          if (url.searchParams.get("event_id") === id && ++asked === nth) {
            hold();
            yield* Effect.promise(() => released);
          }
          return response;
        }),
      ),
    ),
  ).pipe(Layer.provide(luma.layer));
  return { layer, paused, release };
};

/**
 * A run that writes, started now on a clock that stands still (so a held
 * answer never times out), with Luma held as {@link heldLuma} holds it.
 */
const startHeld = (
  db: PGlite,
  replies: Readonly<Record<string, ReadonlyArray<Reply>>>,
  id: string,
  nth: number,
) => {
  const { layer, paused, release } = heldLuma(replies, id, nth);
  const done = Effect.runPromise(
    LumaVenueVisibility.use((visibility) =>
      visibility.run({ dryRun: false }),
    ).pipe(
      Effect.provide(
        LumaVenueVisibility.layer.pipe(
          Layer.provide(LumaApi.layer),
          Layer.provide(Layer.mergeAll(layer, configFrom(withKey))),
          Layer.provideMerge(sqlLayer(db)),
          Layer.provideMerge(clockLayer),
        ),
      ),
    ),
  );
  return { paused, release, done };
};

/** The upcoming meetup's setting and reveal token, as stored. */
const upcoming = async (db: PGlite) =>
  (
    await db.query<{
      venue_guests_only: boolean;
      venue_reveal_token: string | null;
    }>(
      `SELECT venue_guests_only, venue_reveal_token FROM events
       WHERE slug = '2026-11-05-upcoming'`,
    )
  ).rows[0];

describe("two runs at once", () => {
  /** The seed, its upcoming meetup's venue kept to guests. */
  const hidden = async () => {
    const db = await database();
    await db.exec(
      `UPDATE events SET venue_guests_only = true WHERE slug = '2026-11-05-upcoming'`,
    );
    return db;
  };

  test("a run whose answer is older than another run's never shows a venue that run found kept to guests", async () => {
    const db = await hidden();
    // A reads the venue as hidden and Luma, asked first, shows it to
    // everyone; A pauses there. Then Luma keeps it to guests.
    const a = startHeld(
      db,
      {
        ...both,
        "evt-upcoming": [
          answer("evt-upcoming", "public"),
          answer("evt-upcoming"),
        ],
      },
      "evt-upcoming",
      1,
    );
    await a.paused;
    // B reads it as hidden too, and Luma says it is: nothing to write.
    const b = await check(db, both);
    expect(b.result).toMatchObject({ changed: [], written: 0 });
    // A goes on with its older answer, and must not show the venue.
    a.release();
    const result = await a.done;
    expect(await upcoming(db)).toEqual({
      venue_guests_only: true,
      venue_reveal_token: null,
    });
    expect(result).toMatchObject({
      guestsOnly: ["2026-11-05-upcoming"],
      changed: [],
      written: 0,
    });
  });

  test("a guests-only answer read while a run asks again calls off the venue it was about to show", async () => {
    const db = await hidden();
    // A has announced the reveal and Luma, asked again, still shows the
    // venue; A pauses before writing it. Then Luma keeps it to guests.
    const a = startHeld(
      db,
      { ...both, "evt-upcoming": [answer("evt-upcoming", "public")] },
      "evt-upcoming",
      2,
    );
    await a.paused;
    expect((await upcoming(db))?.venue_reveal_token).not.toBeNull();
    // B's answer, the newest, keeps it hidden and calls off A's reveal.
    const b = await check(db, both);
    expect(b.result).toMatchObject({ changed: [], written: 0 });
    expect(await upcoming(db)).toEqual({
      venue_guests_only: true,
      venue_reveal_token: null,
    });
    a.release();
    const result = await a.done;
    expect(result).toMatchObject({ written: 0 });
    expect(await upcoming(db)).toEqual({
      venue_guests_only: true,
      venue_reveal_token: null,
    });
  });

  test("the venue fill's guests-only answer, read while a run asks again, calls off that run's reveal", async () => {
    const db = await hidden();
    await db.exec(`UPDATE events SET street_address = NULL,
        short_location = NULL, full_address = NULL
      WHERE slug = '2026-11-05-upcoming'`);
    const a = startHeld(
      db,
      { ...both, "evt-upcoming": [answer("evt-upcoming", "public")] },
      "evt-upcoming",
      2,
    );
    await a.paused;
    const luma = fakeApi({ "evt-upcoming": [answer("evt-upcoming")] });
    const fill = await Effect.runPromise(
      settle(LumaVenues.use((venues) => venues.run({ dryRun: false }))).pipe(
        Effect.provide(
          LumaVenues.layer.pipe(
            Layer.provide(LumaApi.layer),
            Layer.provide(Layer.mergeAll(luma.layer, configFrom(withKey))),
            Layer.provideMerge(sqlLayer(db)),
            Layer.provideMerge(clockLayer),
          ),
        ),
      ),
    );
    expect(fill).toMatchObject({ written: 1 });
    a.release();
    expect(await a.done).toMatchObject({ written: 0 });
    expect(await upcoming(db)).toEqual({
      venue_guests_only: true,
      venue_reveal_token: null,
    });
  });
});

describe("the venue fill, beside a run showing a venue again", () => {
  test("marks a venue Luma keeps to guests, and calls off the reveal, though another fill wrote the address meanwhile", async () => {
    const db = await database();
    await db.exec(`UPDATE events SET venue_guests_only = true,
        venue_reveal_token = '00000000-0000-4000-8000-0000000000aa',
        street_address = NULL, short_location = NULL, full_address = NULL
      WHERE slug = '2026-11-05-upcoming'`);
    // This fill has read the evening without a venue, and Luma keeps it
    // to guests; it pauses there, while another fill writes an address.
    const luma = heldLuma(
      { "evt-upcoming": [answer("evt-upcoming")] },
      "evt-upcoming",
      1,
    );
    const done = Effect.runPromise(
      LumaVenues.use((venues) => venues.run({ dryRun: false })).pipe(
        Effect.provide(
          LumaVenues.layer.pipe(
            Layer.provide(LumaApi.layer),
            Layer.provide(Layer.mergeAll(luma.layer, configFrom(withKey))),
            Layer.provideMerge(sqlLayer(db)),
            Layer.provideMerge(clockLayer),
          ),
        ),
      ),
    );
    await luma.paused;
    await db.exec(`UPDATE events SET street_address = '201 Spear St',
        full_address = '201 Spear St, San Francisco, CA 94105, USA'
      WHERE slug = '2026-11-05-upcoming'`);
    luma.release();
    // Its address isn't written over the other's, but the mark is, and the
    // reveal announced is called off.
    expect(await done).toMatchObject({ written: 0 });
    expect(await upcoming(db)).toEqual({
      venue_guests_only: true,
      venue_reveal_token: null,
    });
  });
});

describe("showing a venue again", () => {
  /** The seed, its upcoming meetup's venue kept to guests. */
  const hidden = async () => {
    const db = await database();
    await db.exec(
      `UPDATE events SET venue_guests_only = true WHERE slug = '2026-11-05-upcoming'`,
    );
    return db;
  };

  test("asks Luma again first, and shows it only if Luma still does", async () => {
    const shown = await hidden();
    const twice = await check(shown, {
      ...both,
      "evt-upcoming": [answer("evt-upcoming", "public")],
    });
    expect(twice.asked).toEqual([
      "evt-endsnow",
      "evt-upcoming",
      "evt-upcoming",
    ]);
    expect(twice.result).toMatchObject({
      changed: [{ slug: "2026-11-05-upcoming", guestsOnly: false }],
      written: 1,
    });
    expect(await upcoming(shown)).toEqual({
      venue_guests_only: false,
      venue_reveal_token: null,
    });

    const kept = await hidden();
    const before = await stored(kept);
    const again = await check(kept, {
      ...both,
      "evt-upcoming": [
        answer("evt-upcoming", "public"),
        answer("evt-upcoming"),
      ],
    });
    expect(again.result).toMatchObject({
      guestsOnly: ["2026-11-05-upcoming"],
      changed: [],
      written: 0,
    });
    expect(await stored(kept)).toEqual(before);
    expect((await upcoming(kept))?.venue_reveal_token).toBeNull();
  });

  test("keeps it hidden when Luma, asked again, doesn't show us the evening", async () => {
    const db = await hidden();
    const before = await stored(db);
    const { result } = await check(db, {
      ...both,
      "evt-upcoming": [answer("evt-upcoming", "public"), { status: 404 }],
    });
    expect(result).toMatchObject({
      changed: [],
      unavailable: ["evt-upcoming"],
      written: 0,
    });
    expect(await stored(db)).toEqual(before);
    expect((await upcoming(db))?.venue_reveal_token).toBeNull();
  });
});
