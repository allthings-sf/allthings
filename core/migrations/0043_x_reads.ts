import { statements } from "./statements.ts";

/**
 * X's daily budget (src/x-budget.ts), kept where the sync Worker and the
 * CLI both see it, so they spend one budget:
 *
 * - `x_holds`: before each request to X, the most its answer can bill, in
 *   thousandths of a dollar, held for its UTC day. A hold is taken under a
 *   lock, against the day's spend with every other hold, so two callers
 *   never both take the last of it. It is settled once what X returned is
 *   recorded, or X answered with something it doesn't bill; a request
 *   unanswered, cut short or unrecorded keeps its hold, counted at its most
 *   for the rest of its day.
 * - `x_reads`: each post and user X returned on a UTC day, once, as X bills
 *   them: a row per day, kind and X's id for it, nothing else. The ids are
 *   public ones, of posts and accounts anyone can see on X.
 *
 * A day's spend is its reads, priced, and its open holds. It is an
 * estimate: X calls its once-a-day billing of a resource "a soft
 * guarantee", so its bill can run past what these record. The budget
 * bounds how many rows a day adds (at most 400 posts at $2.00), so nothing
 * prunes them; they are what sizes the next budget.
 *
 * The sync Worker writes both as site_sync (infra/scripts/site-sync.ts
 * grants that role the columns it inserts and updates, and those it reads
 * to sum the day, nothing else), and the studio's commands that read X as
 * the studio, once its own script grants it (infra/scripts/studio.ts
 * --apply, after this migration). The site never reads them, so
 * site_reader has no grant.
 */
export const xReads: ReadonlyArray<string> = [
  `CREATE TABLE "public"."x_holds" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "day" date NOT NULL,
    "mills" integer NOT NULL,
    "settled" boolean DEFAULT false NOT NULL,
    CONSTRAINT "x_holds_id_pk" PRIMARY KEY("id"),
    CONSTRAINT "x_holds_mills_check" CHECK ("mills" >= 0)
  )`,
  `CREATE TABLE "public"."x_reads" (
    "day" date NOT NULL,
    "kind" text NOT NULL,
    "id" text NOT NULL,
    CONSTRAINT "x_reads_day_kind_id_pk" PRIMARY KEY("day","kind","id"),
    CONSTRAINT "x_reads_kind_check" CHECK ("kind" IN ('post', 'user')),
    CONSTRAINT "x_reads_id_check" CHECK ("id" ~ '^[0-9]{1,20}$')
  )`,
  // site_sync gets here what its script lists (infra/scripts/site-sync.ts),
  // as migration 0037 granted community_metrics: the Sync Worker keeps to
  // the budget without the script rerunning and its password changing.
  // The studio holds nothing until its own script grants it.
  `DO $grant$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'site_sync') THEN
      GRANT SELECT ("id", "day", "mills", "settled"), INSERT ("day", "mills"), UPDATE ("settled") ON "public"."x_holds" TO site_sync;
      GRANT SELECT ("day", "kind"), INSERT ("day", "kind", "id") ON "public"."x_reads" TO site_sync;
    END IF;
  END
  $grant$`,
];

export default statements(xReads);
