import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { pendingLines } from "../src/posts/review.ts";

/** A pending post as `bun run posts pending` and `sweep` print it (src/posts/review.ts). */

const post = {
  eventSlug: "2026-08-12-react-at-acme",
  url: "https://bsky.app/profile/someone.example/post/3abc",
  platform: "bluesky",
  authorName: "Some\u001b[2K One",
  authorHandle: "someone.example",
  postedAt: DateTime.makeUnsafe("2026-08-13T02:00:00.000Z"),
  text: "Great evening,\n  thanks!\u001b]8;;https://x.example\u0007 \u009b31m",
};

describe("a pending post, for review", () => {
  test("its link, who posted it and when, and its text on one line", () => {
    expect(
      pendingLines({
        ...post,
        authorName: "Some One",
        text: "Great\n evening",
      }),
    ).toEqual([
      "https://bsky.app/profile/someone.example/post/3abc",
      "Some One (someone.example), 2026-08-13T02:00:00.000Z",
      "Great evening",
    ]);
    expect(pendingLines({ ...post, authorHandle: null })[1]).toContain("(-)");
  });

  test("shows what its author wrote, never a control character", () => {
    const lines = pendingLines(post);
    expect(lines[1]).toBe(
      "Some\\u001b[2K One (someone.example), 2026-08-13T02:00:00.000Z",
    );
    expect(lines[2]).toBe(
      "Great evening, thanks!\\u001b]8;;https://x.example\\u0007 \\u009b31m",
    );
  });

  test("keeps at most 200 characters of the text before it escapes any", () => {
    const lines = pendingLines({
      ...post,
      text: `${"a".repeat(199)}\u001bbcd`,
    });
    expect(lines[2]).toBe(`${"a".repeat(199)}\\u001b`);
  });
});
