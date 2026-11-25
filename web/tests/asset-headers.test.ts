import { describe, expect, test } from "bun:test";
import { immutable } from "../scripts/build.ts";

/**
 * The headers Cloudflare's asset layer sends with the built files
 * (web/dist/public/_headers, scripts/build.ts). Content-hashed files are
 * kept for a year, and any origin may read them: browsers fetch every face
 * with CORS, so a page on another origin that sets the site's faces needs
 * the header to get them.
 */

const headers = await Bun.file(
  new URL("../dist/public/_headers", import.meta.url),
).text();

/** The header lines of the rule for `path`, as `_headers` writes them. */
function rule(path: string): ReadonlyArray<string> {
  const lines = headers.split("\n");
  const start = lines.indexOf(path);
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex(
    (line, index) => index > start && !line.startsWith("  "),
  );
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .map((line) => line.trim());
}

describe("/assets/*", () => {
  test("is kept for a year, sniffed never, and readable from any origin", () => {
    expect(rule("/assets/*")).toEqual([
      `Cache-Control: ${immutable}`,
      "X-Content-Type-Options: nosniff",
      "Access-Control-Allow-Origin: *",
    ]);
  });
});
