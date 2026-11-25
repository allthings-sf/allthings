import { statements } from "./statements.ts";

/**
 * Hides the venue of every evening the venue visibility will ask about
 * (src/luma/venue-visibility.ts): published, not over (catalog.ts's
 * `ahead`) and with a Luma page.
 */
export const hideUntilAsked = `UPDATE "public"."events"
  SET "venue_guests_only" = true, "updated_at" = now()
  WHERE "is_draft" = false AND "luma_event_id" IS NOT NULL
    AND "end_date" >= now()`;

/**
 * Whether Luma shows an evening's venue to approved guests only
 * (`events.venue_guests_only`, Luma's "location_visibility": "guests-only"),
 * as the hourly sync last read it from Luma's API
 * (src/luma/venue-visibility.ts). While it is set and the evening is not
 * over, every public surface shows only the venue's city (src/catalog.ts,
 * `publicVenue`); once the evening is over, the venue shows again.
 *
 * Until Luma has been asked, an evening's visibility is unknown, and
 * unknown hides the venue, as it does for a draft just published
 * (src/luma/sync.ts): every evening the sync will ask about, published, not
 * over and with a Luma page, starts hidden ({@link hideUntilAsked}), and the
 * sync's next run shows again each one Luma shows to everyone. So no venue
 * is public before Luma has said so, whenever that run comes and even if it
 * lacks Luma's key. An evening the sync never asks about starts public.
 *
 * `events.venue_reveal_token` is set only while a run that found Luma
 * showing a hidden venue asks Luma again before showing it: a guests-only
 * answer clears it as it is written, and the run shows the venue only if
 * its token is still there when it locks the row to show it. So an older
 * answer never shows a venue that a newer one, already written, found kept
 * to guests. No public surface reads it.
 *
 * site_sync, the role the hourly sync writes as, may read and write both
 * where the role exists (infra/scripts/site-sync.ts); site_reader and the
 * studio read every column of `events` already.
 */
export const venueGuestsOnly: ReadonlyArray<string> = [
  `ALTER TABLE "public"."events" ADD COLUMN "venue_guests_only" boolean DEFAULT false NOT NULL`,
  `ALTER TABLE "public"."events" ADD COLUMN "venue_reveal_token" uuid`,
  hideUntilAsked,
  `DO $grant$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'site_sync') THEN
      GRANT SELECT ("venue_guests_only", "venue_reveal_token"),
        UPDATE ("venue_guests_only", "venue_reveal_token")
        ON "public"."events" TO site_sync;
    END IF;
  END
  $grant$`,
];

export default statements(venueGuestsOnly);
