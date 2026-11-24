import { statements } from "./statements.ts";

/**
 * Whether Luma shows an evening's venue to approved guests only
 * (`events.venue_guests_only`, Luma's "location_visibility": "guests-only"),
 * as the hourly sync last read it from Luma's API
 * (src/luma/venue-visibility.ts). While it is set and the evening is not
 * over, every public surface shows only the venue's city (src/catalog.ts,
 * `publicVenue`); once the evening is over, the venue shows again. Every
 * evening starts as public; the sync's next run reads each one ahead.
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
