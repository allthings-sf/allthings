import { describe, expect, test } from "bun:test";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { chooseTheme } from "../src/pages/theme.ts";

/** Where `?theme=` sends the visitor back to (theme.ts). */

const site = "https://allthings.dev";

const location = (path: `/${string}`, url: string) => {
  const response = chooseTheme("dark", path, url);
  expect(response.status).toBe(303);
  return HttpServerResponse.toWeb(response).headers.get("location");
};

describe("choosing a mode", () => {
  test("goes back to the page without the theme parameter", () => {
    expect(location("/events", "/events?theme=dark")).toBe("/events");
    expect(location("/events", "/events?a=1&theme=dark&b=2")).toBe(
      "/events?a=1&b=2",
    );
    expect(location("/", "/?theme=dark")).toBe("/");
  });

  test("goes back to a page on this site, as a browser reads the path", () => {
    for (const path of [
      "/\t/elsewhere.example",
      "/\n/elsewhere.example",
      "/\r\n/elsewhere.example",
      "/\t\\elsewhere.example",
      "/%2E//elsewhere.example",
      "/./\t/elsewhere.example",
      "/\t/[",
    ] as const) {
      const sent = location(path, `${encodeURI(path)}?theme=dark`);
      expect([path, sent?.startsWith("//")]).toEqual([path, false]);
      expect([path, /[\t\n\r\\]/.test(sent ?? "")]).toEqual([path, false]);
      expect([path, new URL(sent ?? "", site).origin]).toEqual([path, site]);
    }
  });

  test("goes home from a path that would name another host", () => {
    expect(
      location("/\t/elsewhere.example", "/%09/elsewhere.example?theme=dark"),
    ).toBe("/");
    expect(location("/\t/[", "/%09/%5B?theme=dark")).toBe("/");
  });

  test("keeps the page's own path, as the URL parser writes it", () => {
    expect(location("/people/erik", "/people/erik?theme=dark&x=1")).toBe(
      "/people/erik?x=1",
    );
    expect(location("/people/peña", "/people/pe%C3%B1a?theme=dark")).toBe(
      "/people/pe%C3%B1a",
    );
    expect(location("/a?b#c", "/a%3Fb%23c?theme=dark&d=1")).toBe(
      "/a%3Fb%23c?d=1",
    );
  });
});
