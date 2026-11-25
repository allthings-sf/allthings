import { describe, expect, test } from "bun:test";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/server";
import * as Contract from "allthings-core/src/contract.ts";
import eventDetails from "allthings-core/tests/fixtures/event-details.json" with { type: "json" };
import speakerDirectory from "allthings-core/tests/fixtures/speakers.json" with { type: "json" };
import { Schema } from "effect";
import { JSDOM } from "jsdom";
import type { ViewedTool } from "../src/mcp/apps.ts";
import { viewDocument } from "../src/mcp/views.ts";
import { axeProblems } from "./support/a11y.ts";

/**
 * The view (src/client/mcp-app), as a host runs it: its built document in
 * a window whose parent is the host, speaking MCP Apps with the extension's
 * own host bridge, @modelcontextprotocol/ext-apps's AppBridge. The view
 * speaks the protocol without the SDK, so these hold the two to one wire:
 * the handshake, the tool's input and result, the host's theme, the size
 * it reports, the links it asks the host to open and the tools it calls.
 */

// The data the views draw, in the contract's shapes: core's fixtures, with
// the fields the contract has gained since, checked by the contract itself.
const [effectNight, ...otherEvenings] = eventDetails.events.map((event) =>
  Schema.decodeUnknownSync(Contract.Event)({
    ...event,
    curation: "ours",
    organizer: null,
    talks: event.talks.map((talk, index) => ({
      ...talk,
      recording: null,
      artifacts:
        index === 0
          ? [
              {
                kind: "slides",
                url: "https://example.com/slides",
                label: null,
                elsewhere: null,
              },
            ]
          : [],
    })),
  }),
);
if (effectNight === undefined) throw new Error("No events in the fixture");
const evenings = [effectNight, ...otherEvenings];
const summaries = evenings.map(
  ({ talks: _, hosts: __, ...summary }) => summary,
);
const speakers = speakerDirectory.speakers.map((speaker) =>
  Schema.decodeUnknownSync(Contract.Speaker)(speaker),
);

const result = (value: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

/** The little of a jsdom window and its elements the tests touch. */
interface ViewElement {
  readonly textContent: string | null;
  readonly outerHTML: string;
  readonly id: string;
  value: string;
  readonly form: { requestSubmit(): void } | null;
  click(): void;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<ViewElement>;
}

interface ViewWindow {
  readonly document: {
    readonly documentElement: ViewElement & {
      readonly dataset: Record<string, string | undefined>;
    };
    readonly activeElement: ViewElement | null;
    querySelector(selector: string): ViewElement | null;
    querySelectorAll(selector: string): ArrayLike<ViewElement>;
    getElementById(id: string): ViewElement | null;
  };
  readonly Event: new (type: string, init?: object) => object;
  readonly MouseEvent: new (type: string, init?: object) => object;
  dispatchEvent(event: object): boolean;
  close(): void;
}

/** Waits for `check` to hold, as the view answers in its own time. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

interface Mounted {
  readonly window: ViewWindow;
  readonly bridge: AppBridge;
  readonly calls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  /** The links the host was asked to open, and refused when `refuseLinks`. */
  readonly opened: Array<string>;
  /** What the view opened on its own, with window.open: nothing, ever. */
  readonly windowOpened: Array<string>;
  readonly sizes: Array<{ width?: number; height?: number }>;
  /** What axe finds in the view as drawn. */
  readonly axe: () => Promise<Array<string>>;
}

/**
 * Runs `tool`'s view in a window framed by an AppBridge host, which answers
 * the view's tool calls with `answer` and refuses every link it's asked to
 * open when `refuseLinks`, until the view has initialized.
 */
async function mount(
  tool: ViewedTool,
  answer: (
    name: string,
    args: Record<string, unknown>,
  ) => CallToolResult | Promise<CallToolResult> = () => result({}),
  { refuseLinks = false }: { readonly refuseLinks?: boolean } = {},
): Promise<Mounted> {
  const windowOpened: Array<string> = [];
  // What the view posts to its parent, until the bridge is listening.
  const queued: Array<JSONRPCMessage> = [];
  let deliver: ((message: JSONRPCMessage) => void) | undefined;
  const host = {
    postMessage(message: JSONRPCMessage) {
      const copy = structuredClone(message);
      setTimeout(() =>
        deliver === undefined ? queued.push(copy) : deliver(copy),
      );
    },
  };
  // The document as served, its script run once the page is parsed (jsdom
  // runs inline scripts through a global Bun's VM refuses), and its style
  // left out: jsdom lays nothing out, and its CSS parser can't read the
  // theme's modern rules.
  const document = viewDocument(tool, "https://allthings.dev");
  const script = /<script>([\s\S]*)<\/script>/.exec(document)?.[1] ?? "";
  const dom = new JSDOM(
    document
      .replace(/<script>[\s\S]*<\/script>/, "")
      .replace(/<style>[\s\S]*<\/style>/, ""),
    {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: host });
        Object.defineProperty(window, "open", {
          value: (url: unknown) => {
            windowOpened.push(String(url));
            return null;
          },
        });
      },
    },
  );
  const window = dom.window as unknown as ViewWindow;
  dom.window.eval(script);
  const transport: Transport = {
    start: async () => {
      deliver = (message) => transport.onmessage?.(message);
      for (const message of queued.splice(0)) deliver(message);
    },
    send: async (message) => {
      // A message from the host, as postMessage delivers it: from the parent.
      setTimeout(() => {
        const event = new window.Event("message");
        Object.defineProperties(event, {
          data: { value: structuredClone(message) },
          source: { value: host },
        });
        window.dispatchEvent(event);
      });
    },
    close: async () => transport.onclose?.(),
  };
  const calls: Mounted["calls"] = [];
  const opened: Array<string> = [];
  const sizes: Mounted["sizes"] = [];
  const bridge = new AppBridge(
    null,
    { name: "allthings tests", version: "1.0.0" },
    { openLinks: {}, serverTools: {} },
    {
      hostContext: {
        theme: "dark",
        platform: "web",
        containerDimensions: { maxHeight: 6000 },
      },
    },
  );
  bridge.oncalltool = async (params) => {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: params.name, arguments: args });
    return answer(params.name, args);
  };
  bridge.onopenlink = async ({ url }) => {
    opened.push(url);
    if (refuseLinks) throw new Error("The reader didn't want to leave");
    return {};
  };
  bridge.onsizechange = (size) => sizes.push(size);
  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });
  await bridge.connect(transport);
  await initialized;
  return {
    window,
    bridge,
    calls,
    opened,
    windowOpened,
    sizes,
    axe: () =>
      axeProblems(
        `<!doctype html>\n${window.document.documentElement.outerHTML}`,
      ),
  };
}

/** axe takes seconds over a page, and a view is checked as each state draws. */
const slow = { timeout: 60_000 };

const text = (element: ViewElement | null | undefined) =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

const all = (window: ViewWindow, selector: string) =>
  Array.from(window.document.querySelectorAll(selector));

describe("the handshake", () => {
  test(
    "introduces the view and follows the host's theme",
    async () => {
      const view = await mount("list_events");
      try {
        expect(view.bridge.getAppVersion()).toEqual({
          name: "allthings",
          version: "1.0.0",
        });
        expect(view.bridge.getAppCapabilities()).toEqual({
          availableDisplayModes: ["inline"],
        });
        const root = view.window.document.documentElement;
        expect(root.dataset["theme"]).toBe("dark");
        view.bridge.setHostContext({ theme: "light" });
        await until(() => root.dataset["theme"] === "light", "the light theme");
        // It tells the host how tall it is, so the host sizes its frame.
        await until(() => view.sizes.length > 0, "a size");
      } finally {
        view.window.close();
      }
    },
    slow,
  );
});

describe("list_events's view", () => {
  test(
    "draws each evening, and opens its lineup through get_event",
    async () => {
      const view = await mount("list_events", (name, args) =>
        name === "get_event" && args["slug"] === effectNight.slug
          ? result(effectNight)
          : {
              isError: true,
              content: [{ type: "text", text: "No such event" }],
            },
      );
      try {
        await view.bridge.sendToolInput({ arguments: { when: "past" } });
        await view.bridge.sendToolResult(result({ events: summaries }));
        const { document } = view.window;
        await until(
          () => all(view.window, ".evening").length > 0,
          "the evenings",
        );
        expect(text(document.querySelector("h1"))).toBe("Recently");
        expect(all(view.window, ".evening")).toHaveLength(summaries.length);
        // at/effect, its slash and its neighborhood, as the site's lists say it.
        const first = all(view.window, ".evening")[0];
        expect(text(first?.querySelectorAll(".evening-name")[0])).toBe(
          "at/effect",
        );
        expect(text(first?.querySelectorAll(".evening-place")[0])).toBe(
          "Neighborhood: East Cut",
        );
        expect(await view.axe()).toEqual([]);

        // A link opens through the host.
        const link = first?.querySelectorAll(".evening-name a")[0];
        link?.click();
        await until(() => view.opened.length > 0, "the link to open");
        expect(view.opened).toEqual([effectNight.url]);

        // Who's on stage: the view asks get_event through the host.
        first?.querySelectorAll("button")[0]?.click();
        await until(
          () => document.querySelector(".evening-page") !== null,
          "the lineup",
        );
        expect(view.calls).toEqual([
          { name: "get_event", arguments: { slug: effectNight.slug } },
        ]);
        expect(text(document.querySelector("h1"))).toBe("allthings/effect");
        expect(await view.axe()).toEqual([]);

        // And back to the list.
        document.querySelector(".back")?.click();
        await until(
          () => all(view.window, ".evening").length === summaries.length,
          "the list again",
        );
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "says when no evenings are on the calendar",
    async () => {
      const view = await mount("list_events");
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult(result({ events: [] }));
        await until(
          () => view.window.document.querySelector(".notice") !== null,
          "the notice",
        );
        expect(text(view.window.document.querySelector("h1"))).toBe(
          "Coming up",
        );
        expect(text(view.window.document.querySelector(".notice"))).toStartWith(
          "No evenings are on the calendar yet.",
        );
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "says what went wrong when the tool couldn't answer",
    async () => {
      const view = await mount("list_events");
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult({
          isError: true,
          content: [
            {
              type: "text",
              text: "allthings events are temporarily unavailable. Please retry in a minute.",
            },
          ],
        });
        await until(
          () => view.window.document.querySelector("[role=alert]") !== null,
          "the alert",
        );
        expect(text(view.window.document.querySelector("[role=alert]"))).toBe(
          "allthings events are temporarily unavailable. Please retry in a minute.",
        );
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "keeps the way back when an evening's lineup can't be had",
    async () => {
      const view = await mount("list_events", () => ({
        isError: true,
        content: [
          {
            type: "text",
            text: "allthings event details are temporarily unavailable. Please retry in a minute.",
          },
        ],
      }));
      try {
        await view.bridge.sendToolInput({ arguments: { when: "past" } });
        await view.bridge.sendToolResult(result({ events: summaries }));
        const { document } = view.window;
        await until(
          () => all(view.window, ".evening").length > 0,
          "the evenings",
        );
        all(view.window, ".evening")[0]?.querySelectorAll("button")[0]?.click();
        await until(
          () => document.querySelector("[role=alert]") !== null,
          "the alert",
        );
        expect(text(document.querySelector("[role=alert]"))).toBe(
          "allthings event details are temporarily unavailable. Please retry in a minute.",
        );
        expect(await view.axe()).toEqual([]);
        // The list it replaced is one press away.
        document.querySelector(".back")?.click();
        await until(
          () => all(view.window, ".evening").length === summaries.length,
          "the list again",
        );
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "opens nothing the host refused to open",
    async () => {
      const view = await mount("list_events", undefined, {
        refuseLinks: true,
      });
      try {
        await view.bridge.sendToolInput({ arguments: { when: "past" } });
        await view.bridge.sendToolResult(result({ events: summaries }));
        await until(
          () => all(view.window, ".evening").length > 0,
          "the evenings",
        );
        all(view.window, ".evening-name a")[0]?.click();
        await until(() => view.opened.length > 0, "the host to be asked");
        // Long enough for the refusal to come back to the view.
        await Bun.sleep(200);
        expect(view.opened).toEqual([effectNight.url]);
        expect(view.windowOpened).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );
});

describe("get_event's view", () => {
  test(
    "draws the evening, its talks with their people, and its hosts",
    async () => {
      const view = await mount("get_event");
      try {
        await view.bridge.sendToolInput({
          arguments: { slug: effectNight.slug },
        });
        await view.bridge.sendToolResult(result(effectNight));
        const { document } = view.window;
        await until(
          () => document.querySelector(".evening-page") !== null,
          "the evening",
        );
        expect(text(document.querySelector("h1"))).toBe("allthings/effect");
        expect(all(view.window, ".talk")).toHaveLength(
          effectNight.talks.length,
        );
        expect(all(view.window, ".talk-title").map(text)).toEqual(
          effectNight.talks.map((talk) => talk.title),
        );
        expect(all(view.window, ".host-name").map(text)).toEqual(
          effectNight.hosts.map((host) => host.name),
        );
        // A past evening has no "I'm in"; its page and what it left are links.
        expect(text(document.querySelector(".evening-head .actions"))).toBe(
          "On allthings.dev",
        );
        expect(text(document.querySelector(".artifacts"))).toBe("Slides");
        // Headings go down one level at a time: h1, then h2s with h3s under them.
        const levels = all(view.window, "h1, h2, h3").map((heading) =>
          Number(heading.outerHTML.slice(2, 3)),
        );
        expect(levels[0]).toBe(1);
        for (const [index, level] of levels.entries()) {
          if (index > 0)
            expect(level - (levels[index - 1] ?? 0)).toBeLessThanOrEqual(1);
        }
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );
});

describe("list_speakers's view", () => {
  test(
    "draws the people and searches again through list_speakers",
    async () => {
      const view = await mount("list_speakers", (name, args) =>
        name === "list_speakers"
          ? result({
              speakers: speakers.filter((speaker) =>
                speaker.name
                  .toLowerCase()
                  .includes(
                    typeof args["query"] === "string" ? args["query"] : "",
                  ),
              ),
            })
          : result({}),
      );
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult(result({ speakers }));
        const { document } = view.window;
        await until(
          () => all(view.window, ".person-row").length > 0,
          "the people",
        );
        expect(all(view.window, ".person-row")).toHaveLength(speakers.length);
        expect(await view.axe()).toEqual([]);

        const [someone] = speakers;
        const query = someone?.name.split(" ")[0]?.toLowerCase() ?? "";
        const field = document.getElementById("people-query");
        if (field === null) throw new Error("No search field");
        field.value = query;
        field.form?.requestSubmit();
        await until(
          () => text(document.querySelector(".view-count")).includes(query),
          "the search's results",
        );
        expect(view.calls).toEqual([
          { name: "list_speakers", arguments: { query } },
        ]);
        expect(all(view.window, ".person-row").length).toBeGreaterThan(0);
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );
  test(
    "keeps the people and the search when a search fails",
    async () => {
      const view = await mount("list_speakers", () => ({
        isError: true,
        content: [
          {
            type: "text",
            text: "allthings speakers are temporarily unavailable. Please retry in a minute.",
          },
        ],
      }));
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult(result({ speakers }));
        const { document } = view.window;
        await until(
          () => all(view.window, ".person-row").length > 0,
          "the people",
        );
        const field = document.getElementById("people-query");
        if (field === null) throw new Error("No search field");
        field.value = "nobody";
        field.form?.requestSubmit();
        await until(
          () => document.querySelector("[role=alert]") !== null,
          "the alert",
        );
        expect(text(document.querySelector(".search + [role=alert]"))).toBe(
          "allthings speakers are temporarily unavailable. Please retry in a minute.",
        );
        // The people shown before, and the search to try again, stay.
        expect(all(view.window, ".person-row")).toHaveLength(speakers.length);
        expect(document.getElementById("people-query")).not.toBeNull();
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );
  test(
    "draws only the latest search when an earlier one answers last",
    async () => {
      const [first, second] = speakers;
      if (first === undefined || second === undefined) {
        throw new Error("The fixture needs two speakers");
      }
      const firstName = first.name.toLowerCase();
      const secondName = second.name.toLowerCase();
      const view = await mount("list_speakers", async (_, args) => {
        const query = typeof args["query"] === "string" ? args["query"] : "";
        // The first search answers well after the second.
        if (query === firstName) await Bun.sleep(400);
        return result({
          speakers: speakers.filter((speaker) =>
            speaker.name.toLowerCase().includes(query),
          ),
        });
      });
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult(result({ speakers }));
        const { document } = view.window;
        await until(
          () => all(view.window, ".person-row").length > 0,
          "the people",
        );
        const search = (query: string) => {
          const field = document.getElementById("people-query");
          if (field === null) throw new Error("No search field");
          field.value = query;
          field.form?.requestSubmit();
        };
        search(firstName);
        search(secondName);
        await until(
          () =>
            text(document.querySelector(".view-count")).includes(secondName),
          "the second search's answer",
        );
        // Long enough for the first search's late answer to arrive.
        await Bun.sleep(600);
        expect(view.calls).toHaveLength(2);
        expect(text(document.querySelector(".view-count"))).toContain(
          secondName,
        );
        expect(
          all(view.window, ".person-name").map((name) => text(name)),
        ).toContain(second.name);
      } finally {
        view.window.close();
      }
    },
    slow,
  );
});
