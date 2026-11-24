import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { ahead, drafts, published, soonestFirst } from "../catalog.ts";
import type { DataSourceError } from "../errors.ts";
import { orDataSourceError } from "../sql.ts";
import { LumaApi, type LumaApiError } from "./api.ts";
import type { RehearsedEvening } from "./company-hosts.ts";

/**
 * Whether Luma shows each evening's venue to approved guests only (Luma's
 * "location_visibility": "guests-only"), kept in `events.venue_guests_only`
 * for every public surface to respect: while it is set and the evening is
 * not over, they show only the venue's city (src/catalog.ts,
 * `publicVenue`).
 *
 * Every published evening not over that has a Luma page is asked about,
 * whatever venue is stored: the calendar feed hides a guests-only venue but
 * says nothing of the setting, an organizer's venue (`venue_by_organizer`)
 * is still Luma's to hide, and a venue that was public may be hidden later,
 * or shown. An evening over keeps what was last read; its venue shows
 * again whatever it says. The feed sync hides a draft's venue on
 * publication until the API confirms it is public. The venue fill
 * (src/luma/venues.ts) marks a venue guests-only with each address it
 * fills where Luma says so, and never clears the mark.
 *
 * A venue stored as hidden is shown again only once Luma has said so twice,
 * the second time asked after the run announced the reveal by setting
 * `events.venue_reveal_token` to its own token. A guests-only answer, from
 * another run or the venue fill, clears the token as it is written, and
 * the run shows the venue only if its token is still there when it locks
 * the row to show it; one written after that hides the venue again. So
 * however runs overlap, an older answer never shows a venue that a newer
 * one, already written, found kept to guests. Comparing the stored
 * setting with the one the run read would not be enough: a run whose newer
 * answer agrees with what is stored writes nothing, so leaves nothing to
 * compare. Hiding needs no such care: an older guests-only answer only
 * keeps a venue hidden until the next run.
 *
 * Only evenings whose setting changes are written, each with the Clock's
 * now as its updated_at; announcing a reveal, or calling one off, writes
 * the token alone, so a run that changes nothing leaves the data's version
 * as it was. Each write is one statement that locks the rows it writes and
 * decides on each as it stands then. A guests-only answer is written as it
 * arrives (`markGuestsOnly`), whatever the run is still asking: hiding is
 * never wrong to keep, and committed after another run announced a reveal
 * and before that reveal locks the row, it calls the reveal off. The rest
 * waits for all of Luma's answers: a failure asking about any evening
 * writes nothing more. A failure asking again leaves the venue hidden, its
 * reveal announced, until a later answer settles it. An evening Luma
 * doesn't show us keeps what it has. Without LUMA_API_KEY it does nothing.
 */

/** Evenings asked about at once, far under the API's 200 requests a minute. */
export const concurrency = 4;

/** A published evening not over, with its setting as stored. */
const Ahead = Schema.Struct({
  eventId: Schema.String,
  slug: Schema.String,
  lumaEventId: Schema.String,
  guestsOnly: Schema.Boolean,
});
type Ahead = typeof Ahead.Type;

/** An evening whose setting Luma has changed, and what Luma says now. */
export interface VisibilityChange {
  readonly eventId: string;
  readonly slug: string;
  readonly lumaEventId: string;
  /** Whether Luma now shows the venue to guests only. */
  readonly guestsOnly: boolean;
}

/**
 * What a run did: skipped (no LUMA_API_KEY, with why), or the evenings it
 * asked about and what it found and wrote.
 */
export type VenueVisibility =
  | { readonly _tag: "Skipped"; readonly reason: string }
  | {
      readonly _tag: "Planned";
      /** Published evenings not over, with a Luma page, that were asked about. */
      readonly asked: number;
      /** Of those, the slugs of evenings Luma shows the venue of to guests only. */
      readonly guestsOnly: ReadonlyArray<string>;
      /** Of those asked about, the evenings whose setting changed on Luma. */
      readonly changed: ReadonlyArray<VisibilityChange>;
      /** Of those, the Luma ids of evenings Luma does not show us. */
      readonly unavailable: ReadonlyArray<string>;
      /** Evenings whose setting this run changed; null for a dry run. */
      readonly written: number | null;
    };

/** How one run asks and writes. */
export interface VenueVisibilityOptions {
  /** Plan only: ask Luma, write nothing. */
  readonly dryRun: boolean;
  /**
   * Ask about at most this many evenings, taken in turn hour by hour so
   * that later runs ask about the rest.
   */
  readonly maxEvents?: number;
  /**
   * A dry run's evenings as the rehearsed event sync would leave them
   * (src/luma/company-hosts.ts, `rehearsedEvenings`): one it would create
   * is asked about as `pending:<Luma id>`. A run that writes takes the
   * evenings as stored.
   */
  readonly rehearsed?: ReadonlyArray<RehearsedEvening>;
}

/** The service: one run of the venue visibility check. */
export interface LumaVenueVisibilityShape {
  /**
   * Asks Luma and, unless `dryRun`, writes what changed. Not all or
   * nothing: a guests-only answer is written as it arrives and stays
   * written though a later question fails, which then writes nothing more,
   * so a venue is shown again only by a run that got every answer it asked
   * for and found Luma still showing it when asked again.
   */
  readonly run: (
    options: VenueVisibilityOptions,
  ) => Effect.Effect<VenueVisibility, LumaApiError | DataSourceError>;
}

/**
 * What one answer does to its evening:
 * - `hide`: Luma keeps the venue to guests. It is marked so, and any
 *   announced reveal's token is cleared, so a reveal that locks the row
 *   after this shows nothing.
 * - `announce`: Luma shows a venue stored as hidden. The run announces the
 *   reveal with its token, replacing any other run's (whose reveal then
 *   shows nothing), and asks Luma again.
 * - `reveal`: asked again, Luma still shows it. It is shown, if the run's
 *   token is still there.
 * - `withdraw`: asked again, Luma doesn't show us the evening. The run's
 *   token is taken back, and the venue stays hidden.
 */
const Action = Schema.Literals(["hide", "announce", "reveal", "withdraw"]);
type Action = typeof Action.Type;

/** One evening, and what its answer does to it. */
interface Settlement {
  readonly eventId: string;
  readonly action: Action;
}

/** An evening a write wrote, why, and whether its setting changed. */
const Settled = Schema.Struct({
  eventId: Schema.String,
  action: Action,
  changed: Schema.Boolean,
});

/**
 * Writes what each answer does to its evening (`Action`), in one
 * statement, with `token` the run's own (none to hide alone). Each row it
 * writes is locked
 * first and decided on as it stands then, so a write another run commits
 * meanwhile is taken into account, never overwritten. Rows that need
 * nothing are left alone. Returns each evening written.
 */
const settle = (
  sql: SqlClient,
  actions: ReadonlyArray<Settlement>,
  token: string | null,
  now: DateTime.Utc,
) => {
  if (actions.length === 0) return Effect.succeed([]);
  const rows = JSON.stringify(
    actions.map(({ eventId, action }) => ({ event_id: eventId, action })),
  );
  return sql`
    WITH c AS (
      SELECT * FROM jsonb_to_recordset(${rows}::jsonb) AS c(
        event_id uuid, action text)
    ), locked AS (
      SELECT e.id, c.action,
        (c.action = 'hide' AND NOT e.venue_guests_only)
          OR c.action = 'reveal' AS changed
      FROM events e JOIN c ON c.event_id = e.id
      WHERE CASE c.action
        WHEN 'hide' THEN
          NOT e.venue_guests_only OR e.venue_reveal_token IS NOT NULL
        WHEN 'announce' THEN e.venue_guests_only
        WHEN 'reveal' THEN
          e.venue_guests_only AND e.venue_reveal_token = ${token}::uuid
        WHEN 'withdraw' THEN e.venue_reveal_token = ${token}::uuid
      END
      -- In one order, so two runs writing the same rows never deadlock.
      ORDER BY e.id
      FOR UPDATE OF e
    ), written AS (
      UPDATE events e SET
        venue_guests_only = CASE l.action
          WHEN 'hide' THEN true
          WHEN 'reveal' THEN false
          ELSE e.venue_guests_only
        END,
        venue_reveal_token = CASE WHEN l.action = 'announce'
          THEN ${token}::uuid END,
        updated_at = CASE WHEN l.changed
          THEN ${DateTime.formatIso(now)}::timestamptz ELSE e.updated_at END
      FROM locked l
      WHERE e.id = l.id
      RETURNING e.id::text AS "eventId", l.action, l.changed
    )
    SELECT "eventId", action, changed FROM written`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Settled))),
    orDataSourceError,
  );
};

/**
 * Marks `eventId`'s venue guests-only, as Luma has just answered, at once,
 * whatever else a run is still asking, since hiding is never wrong to keep.
 * A reveal already announced for it when this commits
 * (`events.venue_reveal_token`) is called off, and finds no token, unless
 * it locked the row first: then this waits for it and hides the venue
 * again. A reveal announced after this asks Luma again after this answer
 * was read, so that newer answer decides. The venue fill
 * (src/luma/venues.ts) marks each venue Luma keeps to guests with it too.
 * Whether its setting changed.
 */
export const markGuestsOnly = (
  sql: SqlClient,
  eventId: string,
  now: DateTime.Utc,
) =>
  Effect.map(settle(sql, [{ eventId, action: "hide" }], null, now), (rows) =>
    rows.some(({ changed }) => changed),
  );

const make = Effect.gen(function* () {
  const api = yield* LumaApi;
  const sql = yield* SqlClient;

  /**
   * The published evenings not over with a Luma page, soonest first: every
   * one, or `maxEvents` of them taken in turn, the next ones each hour
   * (from the start again after the last), so that of n evenings each is
   * asked about at least once in every ceil(n / maxEvents) hourly runs.
   */
  const read = (
    now: DateTime.Utc,
    maxEvents: number | null,
    rehearsed: ReadonlyArray<RehearsedEvening>,
  ) => {
    const hour = Math.floor(DateTime.toEpochMillis(now) / 3_600_000);
    const inTurn =
      maxEvents === null
        ? sql`true`
        : sql`(a.i - ${hour}::bigint * ${maxEvents}::bigint % a.n + a.n) % a.n
            < ${maxEvents}`;
    const overlay = JSON.stringify(
      rehearsed.map((row) => ({
        luma_event_id: row.lumaEventId,
        slug: row.slug,
        is_draft: row.isDraft,
        start_date: row.startDate,
        end_date: row.endDate,
      })),
    );
    // Stored evenings, with what a rehearsed sync would change laid over
    // them, and those it would create (public until Luma says otherwise),
    // as the company hosts' step reads them; a run that writes lays nothing.
    return sql`
      WITH r AS (
        SELECT * FROM jsonb_to_recordset(${overlay}::jsonb) AS r(
          luma_event_id text, slug text, is_draft boolean,
          start_date timestamptz, end_date timestamptz)
      ), x AS (
        SELECT e.id::text AS id, e.slug, e.luma_event_id,
          e.venue_guests_only OR COALESCE(${drafts(sql, "e")} AND ${published(sql, "r")}, false)
            AS venue_guests_only,
          COALESCE(r.is_draft, e.is_draft) AS is_draft,
          COALESCE(r.start_date, e.start_date) AS start_date,
          COALESCE(r.end_date, e.end_date) AS end_date
        FROM events e LEFT JOIN r ON r.luma_event_id = e.luma_event_id
        UNION ALL
        SELECT 'pending:' || r.luma_event_id, r.slug, r.luma_event_id, false,
          r.is_draft, r.start_date, r.end_date
        FROM r
        WHERE NOT EXISTS (
          SELECT 1 FROM events e WHERE e.luma_event_id = r.luma_event_id)
      )
      SELECT a."eventId", a.slug, a."lumaEventId", a."guestsOnly"
      FROM (
        SELECT x.id AS "eventId", x.slug, x.luma_event_id AS "lumaEventId",
          x.venue_guests_only AS "guestsOnly",
          row_number() OVER (ORDER BY ${soonestFirst(sql, "x")}) - 1 AS i,
          count(*) OVER () AS n
        FROM x
        WHERE ${published(sql, "x")} AND ${ahead(sql, "x", now)}
          AND x.luma_event_id IS NOT NULL
      ) a
      WHERE ${inTurn}
      ORDER BY a.i`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Ahead))),
      orDataSourceError,
    );
  };

  const run = ({ dryRun, maxEvents, rehearsed = [] }: VenueVisibilityOptions) =>
    Option.match(api.eventVenue, {
      onNone: () =>
        Effect.succeed<VenueVisibility>({
          _tag: "Skipped",
          reason: "LUMA_API_KEY is not set",
        }),
      onSome: (eventVenue) =>
        Effect.gen(function* () {
          /** The run's own token; none for a dry run, which writes nothing. */
          const token = dryRun
            ? null
            : yield* Effect.sync(() => crypto.randomUUID());
          /** Evenings whose setting this run changed. */
          let changes = 0;
          /** Luma's answers, each guests-only one marked as it arrives. */
          const ask = (asked: ReadonlyArray<Ahead>) =>
            Effect.forEach(
              asked,
              (evening) =>
                Effect.gen(function* () {
                  const venue = yield* eventVenue(evening.lumaEventId);
                  if (
                    token !== null &&
                    Option.isSome(venue) &&
                    venue.value.guestsOnly
                  ) {
                    const now = yield* DateTime.now;
                    if (yield* markGuestsOnly(sql, evening.eventId, now)) {
                      changes++;
                    }
                  }
                  return { evening, venue };
                }),
              { concurrency },
            );
          const evenings = yield* read(
            yield* DateTime.now,
            maxEvents ?? null,
            dryRun ? rehearsed : [],
          );
          const answers = yield* ask(evenings);
          /** Luma's latest answer for each evening, by id. */
          const latest = new Map(
            answers.map(({ evening, venue }) => [evening.eventId, venue]),
          );
          let written: number | null = null;
          if (token !== null) {
            const announced = new Set(
              (yield* settle(
                sql,
                answers.flatMap(
                  ({ evening, venue }): ReadonlyArray<Settlement> =>
                    Option.isSome(venue) &&
                    !venue.value.guestsOnly &&
                    evening.guestsOnly
                      ? [{ eventId: evening.eventId, action: "announce" }]
                      : [],
                ),
                token,
                yield* DateTime.now,
              )).map(({ eventId }) => eventId),
            );
            const again = yield* ask(
              evenings.filter(({ eventId }) => announced.has(eventId)),
            );
            for (const { evening, venue } of again) {
              latest.set(evening.eventId, venue);
            }
            // A guests-only answer was marked as it arrived, calling off
            // the reveal; the rest show the venue, or take the token back.
            const shown = yield* settle(
              sql,
              again.flatMap(
                ({ evening, venue }): ReadonlyArray<Settlement> =>
                  Option.isNone(venue)
                    ? [{ eventId: evening.eventId, action: "withdraw" }]
                    : venue.value.guestsOnly
                      ? []
                      : [{ eventId: evening.eventId, action: "reveal" }],
              ),
              token,
              yield* DateTime.now,
            );
            written = changes + shown.filter(({ changed }) => changed).length;
          }
          const guestsOnly: Array<string> = [];
          const changed: Array<VisibilityChange> = [];
          const unavailable: Array<string> = [];
          for (const evening of evenings) {
            const venue = latest.get(evening.eventId) ?? Option.none();
            if (Option.isNone(venue)) {
              unavailable.push(evening.lumaEventId);
              continue;
            }
            if (venue.value.guestsOnly) guestsOnly.push(evening.slug);
            if (venue.value.guestsOnly !== evening.guestsOnly) {
              changed.push({
                eventId: evening.eventId,
                slug: evening.slug,
                lumaEventId: evening.lumaEventId,
                guestsOnly: venue.value.guestsOnly,
              });
            }
          }
          return {
            _tag: "Planned",
            asked: evenings.length,
            guestsOnly,
            changed,
            unavailable,
            written,
          } satisfies VenueVisibility;
        }),
    }).pipe(
      Effect.withSpan("LumaVenueVisibility.run", { attributes: { dryRun } }),
    );

  return LumaVenueVisibility.of({ run });
});

/**
 * Keeps `events.venue_guests_only` to Luma's setting for every published
 * evening not over (see the top of this file).
 */
export class LumaVenueVisibility extends Context.Service<
  LumaVenueVisibility,
  LumaVenueVisibilityShape
>()("allthings/LumaVenueVisibility") {
  /** Needs `LumaApi` and a `SqlClient`. */
  static readonly layer = Layer.effect(LumaVenueVisibility, make);
}
