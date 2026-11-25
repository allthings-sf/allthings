import { describe, expect, test } from "bun:test";
import { terminalText } from "../src/terminal.ts";

/** Text from outside, as the review commands print it (src/terminal.ts). */

describe("text for a terminal", () => {
  test("writes control characters as escapes", () => {
    expect(terminalText("a\u001b[2Jb")).toBe("a\\u001b[2Jb");
    expect(terminalText("bell\u0007, cr\r, lf\n, del\u007f")).toBe(
      "bell\\u0007, cr\\u000d, lf\\u000a, del\\u007f",
    );
    expect(terminalText("c1 \u009b31m \u0085")).toBe("c1 \\u009b31m \\u0085");
    expect(terminalText("\u0000")).toBe("\\u0000");
  });

  test("leaves text, tabs and every other character as they are", () => {
    for (const text of [
      "Ada Lovelace",
      "a\tb",
      "José Valim,  , ÿ, Ā",
      "\u{1f3a4}   ‮",
      "https://example.com/?a=1&b=%1b",
      "",
    ]) {
      expect(terminalText(text)).toBe(text);
    }
  });
});
