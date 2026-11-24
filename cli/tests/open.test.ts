import { describe, expect, test } from "bun:test";
import { openCommand } from "../src/open.ts";

/** How a link printed by `rsvp` and `open` reaches the system's browser. */

const windows = { SystemRoot: "C:\\Windows" };
const link = "https://lu.ma/event/evt-1?utm_source=cli&ref=a^b%PATH%|c";

describe("opening a link", () => {
  test("Windows hands the whole link to its URL handler, with no command processor", () => {
    expect(openCommand("win32", link, windows)).toEqual([
      "C:\\Windows\\System32\\rundll32.exe",
      "url.dll,FileProtocolHandler",
      link,
    ]);
  });

  test("Windows finds its URL handler where SystemRoot says", () => {
    expect(
      openCommand("win32", "https://allthings.dev/", {
        SystemRoot: "D:\\WINDOWS",
      })?.[0],
    ).toBe("D:\\WINDOWS\\System32\\rundll32.exe");
    for (const SystemRoot of [
      undefined,
      "",
      "Windows",
      "\\Windows",
      "C:Windows",
    ]) {
      expect(
        openCommand("win32", "https://allthings.dev/", { SystemRoot })?.[0],
      ).toBe("C:\\Windows\\System32\\rundll32.exe");
    }
  });

  test("macOS and Linux open the link as one argument", () => {
    expect(openCommand("darwin", link, {})).toEqual(["open", link]);
    expect(openCommand("linux", link, {})).toEqual(["xdg-open", link]);
  });

  test("a link is opened as the URL parser writes it", () => {
    expect(openCommand("linux", "https://allthings.dev/a b", {})).toEqual([
      "xdg-open",
      "https://allthings.dev/a%20b",
    ]);
  });

  test("only http and https links are opened", () => {
    for (const other of [
      "file:///etc/hosts",
      "mailto:hello@allthings.dev",
      "allthings.dev",
      "",
    ]) {
      expect([other, openCommand("win32", other, windows)]).toEqual([
        other,
        undefined,
      ]);
    }
    expect(openCommand("darwin", "http://localhost:8787/", {})).toEqual([
      "open",
      "http://localhost:8787/",
    ]);
  });
});
