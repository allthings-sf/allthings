import { statements } from "./statements.ts";

/**
 * `x_reads`: each post and user X's API returned to us on a UTC day, once,
 * as X bills them on pay-per-use (src/x-budget.ts): what the day has cost
 * so far, which every caller of X checks against the daily budget before
 * it asks X again. A row per day, kind and X's id for it, nothing else:
 * the ids are public ones, of posts and accounts anyone can see on X. The
 * budget bounds how many rows a day can add (at most 400 posts at $2.00),
 * so nothing prunes them; they are what sizes the next budget.
 *
 * The sync Worker writes it as site_sync (infra/scripts/site-sync.ts grants
 * that role the columns it inserts, and the day and kind to count, nothing
 * else), and the studio's commands that read X as the studio, once its own
 * script grants it (infra/scripts/studio.ts). The site never reads it, so
 * site_reader has no grant.
 */
export const xReads: ReadonlyArray<string> = [
  `CREATE TABLE "public"."x_reads" (
    "day" date NOT NULL,
    "kind" text NOT NULL,
    "id" text NOT NULL,
    CONSTRAINT "x_reads_day_kind_id_pk" PRIMARY KEY("day","kind","id"),
    CONSTRAINT "x_reads_kind_check" CHECK ("kind" IN ('post', 'user')),
    CONSTRAINT "x_reads_id_check" CHECK ("id" ~ '^[0-9]{1,20}$')
  )`,
  // site_sync gets here what its script lists (infra/scripts/site-sync.ts),
  // as migration 0037 granted community_metrics: the Sync Worker counts the
  // day's reads without the script rerunning and its password changing.
  // The studio holds nothing until its own script grants it.
  `DO $grant$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'site_sync') THEN
      GRANT SELECT ("day", "kind"), INSERT ("day", "kind", "id") ON "public"."x_reads" TO site_sync;
    END IF;
  END
  $grant$`,
];

export default statements(xReads);
