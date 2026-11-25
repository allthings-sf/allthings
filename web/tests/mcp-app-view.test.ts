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

/** A year, as get_year answers it: two evenings, one with its photo. */
const yearOf = (year: number) =>
  Schema.decodeUnknownSync(Contract.Year)({
    year,
    url: `https://allthings.dev/year/${year}`,
    timeZone: "America/Los_Angeles",
    tally: { evenings: 2, speakers: 3, hostingCompanies: 2, guests: 450 },
    evenings: [
      {
        slug: effectNight.slug,
        name: "Effect San Francisco",
        topic: "effect",
        url: effectNight.url,
        startsAt: `${year}-01-21T01:30:00.000Z`,
        neighborhood: "East Cut",
        hosts: ["CodeRabbit"],
        onStage: [
          {
            name: "Michael Arnaldi",
            url: "https://allthings.dev/people/michael-arnaldi",
          },
          {
            name: "Simon Farshid",
            url: "https://allthings.dev/people/simon-farshid",
          },
        ],
        guests: 250,
        photo: {
          url: "https://media.allthings.dev/events/effect.jpg",
          alt: "Michael Arnaldi on stage",
          width: 2048,
          height: 1536,
        },
      },
      {
        slug: "sync",
        name: "allthings/sync",
        topic: "sync",
        url: "https://allthings.dev/sync",
        startsAt: `${year}-04-29T01:30:00.000Z`,
        neighborhood: "East Cut",
        hosts: ["CodeRabbit"],
        onStage: [
          {
            name: "Andre Landgraf",
            url: "https://allthings.dev/people/andre-landgraf",
          },
        ],
        guests: 200,
        photo: null,
      },
    ],
    years: [2026, 2025],
  });

/** The guide, as get_guide answers it: two three-star happenings, one two. */
const guide = Schema.decodeUnknownSync(Contract.Guide)({
  about:
    "Happenings worth the trip, starred the way the Michelin guide stars a restaurant.",
  url: "https://allthings.dev/guide",
  entries: [
    {
      id: "react-miami",
      name: "React Miami",
      stars: 3,
      meaning: "worth a special journey",
      city: "Miami, Florida",
      organizer: "G2i",
      url: "https://www.reactmiami.com",
      why: "Two days of React's best speakers.",
      next: { from: "2099-04-29", to: "2099-04-30" },
      guideUrl: "https://allthings.dev/guide#react-miami",
    },
    {
      id: "ai-engineer-miami",
      name: "AI Engineer Miami",
      stars: 3,
      meaning: "worth a special journey",
      city: "Miami, Florida",
      organizer: "G2i",
      url: "https://www.ai.engineer",
      why: "Talks from engineers who ship AI.",
      next: { from: "2099-04-26", to: "2099-04-27" },
      guideUrl: "https://allthings.dev/guide#ai-engineer-miami",
    },
    {
      id: "chain-react",
      name: "Chain React",
      stars: 2,
      meaning: "worth a detour",
      city: "Portland, Oregon",
      organizer: "Infinite Red",
      url: "https://chainreactconf.com",
      why: "The React Native conference.",
      next: null,
      guideUrl: "https://allthings.dev/guide#chain-react",
    },
  ],
});

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
  readonly hidden: boolean;
  click(): void;
  focus(): void;
  dispatchEvent(event: object): boolean;
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
  readonly KeyboardEvent: new (type: string, init?: object) => object;
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
  /** What the view told the agent the reader has open, in order. */
  readonly contexts: Array<string>;
  /** What the view put in the chat as the reader's. */
  readonly messages: Array<string>;
  /** The files the view asked the host to save, by URL. */
  readonly downloads: Array<string>;
  /** The display modes the view asked for. */
  readonly modes: Array<string>;
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
  {
    refuseLinks = false,
    offers = {},
    transitions = false,
  }: {
    readonly refuseLinks?: boolean;
    /**
     * Whether the window has view transitions, which, as a browser runs
     * them, update the page only a moment after they're started.
     */
    readonly transitions?: boolean;
    /**
     * What the host offers beyond opening links and calling tools: the
     * model's context, chat messages, saving files and full screen.
     */
    readonly offers?: {
      readonly context?: boolean;
      /** Chat messages, of text, of images alone, or answered as failed. */
      readonly message?: boolean | "images" | "failing";
      readonly download?: boolean;
      readonly fullscreen?: boolean;
    };
  } = {},
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
        if (transitions) {
          Object.defineProperty(window.document, "startViewTransition", {
            value: (update: () => void) => ({
              updateCallbackDone: new Promise<void>((resolve) => {
                setTimeout(() => {
                  update();
                  resolve();
                }, 30);
              }),
            }),
          });
        }
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
    {
      openLinks: {},
      serverTools: {},
      ...(offers.context === true ? { updateModelContext: { text: {} } } : {}),
      ...(offers.message === true || offers.message === "failing"
        ? { message: { text: {} } }
        : offers.message === "images"
          ? { message: { image: {} } }
          : {}),
      ...(offers.download === true ? { downloadFile: {} } : {}),
    },
    {
      hostContext: {
        theme: "dark",
        platform: "web",
        containerDimensions: { maxHeight: 6000 },
        displayMode: "inline",
        availableDisplayModes:
          offers.fullscreen === true ? ["inline", "fullscreen"] : ["inline"],
      },
    },
  );
  const contexts: Array<string> = [];
  const messages: Array<string> = [];
  const downloads: Array<string> = [];
  const modes: Array<string> = [];
  const textOf = (blocks: ReadonlyArray<unknown> | undefined) =>
    (blocks ?? [])
      .map((block) =>
        block !== null && typeof block === "object" && "text" in block
          ? String(block.text)
          : "",
      )
      .join("");
  bridge.onupdatemodelcontext = async ({ content }) => {
    contexts.push(textOf(content));
    return {};
  };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- AppBridge's onmessage answers the view's ui/message requests; it isn't a DOM event
  bridge.onmessage = async ({ content }) => {
    messages.push(textOf(content));
    return offers.message === "failing" ? { isError: true } : {};
  };
  bridge.ondownloadfile = async ({ contents }) => {
    for (const item of contents) {
      if ("uri" in item && typeof item.uri === "string")
        downloads.push(item.uri);
    }
    return {};
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    modes.push(mode);
    return { mode };
  };
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
    contexts,
    messages,
    downloads,
    modes,
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
          availableDisplayModes: ["inline", "fullscreen"],
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

describe("browsing evenings", () => {
  test(
    "lists another selection through list_events, from its tabs",
    async () => {
      const view = await mount("list_events", (name, args) =>
        name === "list_events" && args["when"] === "past"
          ? result({ events: summaries })
          : result({ events: [] }),
      );
      try {
        await view.bridge.sendToolInput({ arguments: { when: "upcoming" } });
        await view.bridge.sendToolResult(result({ events: [] }));
        const { document } = view.window;
        await until(
          () => document.getElementById("tab-past") !== null,
          "the tabs",
        );
        expect(text(document.querySelector("h1"))).toBe("Coming up");
        expect(
          document
            .getElementById("tab-upcoming")
            ?.getAttribute("aria-selected"),
        ).toBe("true");
        expect(await view.axe()).toEqual([]);

        // Arrows move between the tabs without listing anything.
        document.getElementById("tab-upcoming")?.focus();
        document.querySelector("[role=tablist]")?.dispatchEvent(
          new view.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
          }),
        );
        expect(view.window.document.activeElement?.id).toBe("tab-past");
        expect(view.calls).toEqual([]);

        document.getElementById("tab-past")?.click();
        await until(
          () => all(view.window, ".evening").length === summaries.length,
          "the past evenings",
        );
        expect(view.calls).toEqual([
          { name: "list_events", arguments: { when: "past" } },
        ]);
        expect(text(document.querySelector("h1"))).toBe("Recently");
        expect(
          document.getElementById("tab-past")?.getAttribute("aria-selected"),
        ).toBe("true");
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "moves focus only once a view transition has put the next view in",
    async () => {
      const view = await mount(
        "list_events",
        (name) =>
          name === "get_event"
            ? result(effectNight)
            : result({ events: summaries }),
        { transitions: true },
      );
      try {
        await view.bridge.sendToolInput({ arguments: { when: "upcoming" } });
        await view.bridge.sendToolResult(result({ events: [] }));
        const { document } = view.window;
        await until(
          () => document.getElementById("tab-past") !== null,
          "the tabs",
        );

        // The chosen tab, as drawn again with the list it chose.
        document.getElementById("tab-past")?.click();
        await until(
          () => all(view.window, ".evening").length === summaries.length,
          "the past evenings",
        );
        expect(document.activeElement).toBe(
          document.getElementById("tab-past"),
        );

        // The lineup's title, once the lineup is in.
        all(view.window, ".evening")[0]?.querySelectorAll("button")[0]?.click();
        await until(
          () => document.querySelector(".evening-page") !== null,
          "the lineup",
        );
        expect(document.activeElement).toBe(
          document.getElementById("view-title"),
        );
        expect(document.activeElement?.getAttribute("class")).toBe("lockup");

        // And back: the evening's own button, on the list as drawn again.
        document.querySelector(".back")?.click();
        await until(
          () => all(view.window, ".evening").length === summaries.length,
          "the list again",
        );
        expect(document.activeElement).toBe(
          all(view.window, ".evening")[0]?.querySelectorAll("button")[0] ??
            null,
        );
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "narrows to a neighborhood with its chips, and tells the agent",
    async () => {
      const view = await mount("list_events", undefined, {
        offers: { context: true },
      });
      try {
        await view.bridge.sendToolInput({ arguments: { when: "past" } });
        await view.bridge.sendToolResult(result({ events: summaries }));
        const { document } = view.window;
        await until(() => all(view.window, ".chip").length > 0, "the chips");
        await until(() => view.contexts.length > 0, "the agent told");
        expect(view.contexts.at(-1)).toBe(
          `The reader is looking at recently in the allthings view: ${summaries.length} evenings.`,
        );
        const eastCut = all(view.window, ".chip").find((chip) =>
          text(chip).startsWith("East Cut"),
        );
        if (eastCut === undefined) throw new Error("No East Cut chip");
        eastCut.click();
        const shown = all(view.window, ".evening").filter((row) => !row.hidden);
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.length).toBeLessThan(summaries.length);
        expect(eastCut.getAttribute("aria-pressed")).toBe("true");
        expect(text(document.querySelector(".view-count"))).toBe(
          `${shown.length} of ${summaries.length} evenings in East Cut`,
        );
        await until(
          () => view.contexts.at(-1)?.endsWith("in East Cut.") === true,
          "the agent told of the neighborhood",
        );
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "tells the agent which lineup the reader opened, and asks about it in the chat",
    async () => {
      const view = await mount(
        "list_events",
        (name) => (name === "get_event" ? result(effectNight) : result({})),
        { offers: { context: true, message: true } },
      );
      try {
        await view.bridge.sendToolInput({ arguments: { when: "past" } });
        await view.bridge.sendToolResult(result({ events: summaries }));
        const { document } = view.window;
        await until(() => all(view.window, ".evening").length > 0, "the list");
        all(view.window, ".evening")[0]?.querySelectorAll("button")[0]?.click();
        await until(
          () => document.querySelector(".evening-page") !== null,
          "the lineup",
        );
        await until(
          () => view.contexts.at(-1)?.includes("allthings/effect") === true,
          "the agent told of the lineup",
        );
        expect(view.contexts.at(-1)).toStartWith(
          "The reader has allthings/effect (Wed Sep 30, 2026) open in the allthings view",
        );
        const ask = all(view.window, ".evening-page button").find(
          (button) => text(button) === "Ask about it",
        );
        if (ask === undefined) throw new Error("No ask button");
        ask.click();
        await until(() => view.messages.length > 0, "the message");
        expect(view.messages).toEqual([
          "Tell me about allthings/effect: who was on stage, what they talked about, and what they left behind.",
        ]);
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "keeps the list and its tabs when another selection answers with an error",
    async () => {
      const view = await mount("list_events", () => ({
        isError: true,
        content: [
          {
            type: "text",
            text: "allthings events are temporarily unavailable. Please retry in a minute.",
          },
        ],
      }));
      try {
        await view.bridge.sendToolInput({ arguments: { when: "past" } });
        await view.bridge.sendToolResult(result({ events: summaries }));
        const { document } = view.window;
        await until(() => all(view.window, ".evening").length > 0, "the list");
        document.getElementById("tab-all")?.click();
        await until(
          () => document.querySelector("#evenings-list [role=alert]") !== null,
          "the alert",
        );
        expect(
          text(document.querySelector("#evenings-list [role=alert]")),
        ).toBe(
          "allthings events are temporarily unavailable. Please retry in a minute.",
        );
        // The list and the tabs stay, to try again or choose another.
        expect(all(view.window, ".evening")).toHaveLength(summaries.length);
        expect(
          document.getElementById("tab-past")?.getAttribute("aria-selected"),
        ).toBe("true");
        expect(
          document.getElementById("evenings-list")?.getAttribute("aria-busy"),
        ).toBeNull();
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "keeps a lineup opened while another selection was on its way",
    async () => {
      const view = await mount("list_events", async (name) => {
        if (name === "get_event") return result(effectNight);
        // The selection answers well after the lineup.
        await Bun.sleep(400);
        return result({ events: summaries });
      });
      try {
        await view.bridge.sendToolInput({ arguments: { when: "past" } });
        await view.bridge.sendToolResult(result({ events: summaries }));
        const { document } = view.window;
        await until(() => all(view.window, ".evening").length > 0, "the list");
        document.getElementById("tab-all")?.click();
        all(view.window, ".evening")[0]?.querySelectorAll("button")[0]?.click();
        await until(
          () => document.querySelector(".evening-page") !== null,
          "the lineup",
        );
        await Bun.sleep(700);
        expect(document.querySelector(".evening-page")).not.toBeNull();
        // The list it left is no longer busy when the reader comes back.
        document.querySelector(".back")?.click();
        await until(
          () => document.getElementById("evenings-list") !== null,
          "the list again",
        );
        expect(
          document.getElementById("evenings-list")?.getAttribute("aria-busy"),
        ).toBeNull();
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "says the neighborhood again on coming back from a lineup",
    async () => {
      const view = await mount(
        "list_events",
        (name) => (name === "get_event" ? result(effectNight) : result({})),
        { offers: { context: true } },
      );
      try {
        await view.bridge.sendToolInput({ arguments: { when: "past" } });
        await view.bridge.sendToolResult(result({ events: summaries }));
        const { document } = view.window;
        await until(() => all(view.window, ".chip").length > 0, "the chips");
        all(view.window, ".chip")
          .find((chip) => text(chip).startsWith("East Cut"))
          ?.click();
        const shown = all(view.window, ".evening").filter((row) => !row.hidden);
        shown[0]?.querySelectorAll("button")[0]?.click();
        await until(
          () => document.querySelector(".evening-page") !== null,
          "the lineup",
        );
        document.querySelector(".back")?.click();
        await until(
          () => view.contexts.at(-1)?.endsWith("in East Cut.") === true,
          "the agent told of the neighborhood again",
        );
        expect(view.contexts.at(-1)).toBe(
          `The reader is looking at recently in the allthings view: ${shown.length} evenings in East Cut.`,
        );
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "says so when the host answers the question as failed",
    async () => {
      const view = await mount("get_event", undefined, {
        offers: { message: "failing" },
      });
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
        const ask = all(view.window, ".evening-page button").find(
          (button) => text(button) === "Ask about it",
        );
        ask?.click();
        await until(() => text(ask) === "The host couldn’t", "the failure");
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "offers no question to a host whose messages take no text",
    async () => {
      const view = await mount("get_event", undefined, {
        offers: { message: "images" },
      });
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
        expect(
          all(view.window, ".evening-page button").map(text),
        ).not.toContain("Ask about it");
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "saves an evening ahead to the calendar through the host",
    async () => {
      const ahead = { ...effectNight, status: "upcoming" as const };
      const view = await mount("get_event", undefined, {
        offers: { download: true },
      });
      try {
        await view.bridge.sendToolInput({ arguments: { slug: ahead.slug } });
        await view.bridge.sendToolResult(result(ahead));
        const { document } = view.window;
        await until(
          () => document.querySelector(".evening-page") !== null,
          "the evening",
        );
        const save = all(view.window, ".evening-page button").find(
          (button) => text(button) === "Add to calendar",
        );
        if (save === undefined) throw new Error("No calendar button");
        save.click();
        await until(() => view.downloads.length > 0, "the file saved");
        expect(view.downloads).toEqual([`${ahead.url}/calendar.ics`]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "opens full screen where the host offers it",
    async () => {
      const view = await mount("list_events", undefined, {
        offers: { fullscreen: true },
      });
      try {
        await view.bridge.sendToolInput({ arguments: { when: "past" } });
        await view.bridge.sendToolResult(result({ events: summaries }));
        const { document } = view.window;
        await until(() => document.querySelector(".expand") !== null, "toggle");
        const toggle = document.querySelector(".expand");
        expect(text(toggle)).toBe("Full screen");
        toggle?.click();
        await until(() => text(toggle) === "Back inline", "full screen");
        expect(view.modes).toEqual(["fullscreen"]);
        expect(document.documentElement.dataset["mode"]).toBe("fullscreen");
        expect(toggle?.getAttribute("aria-pressed")).toBe("true");
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "draws no control for what the host doesn't offer",
    async () => {
      const ahead = { ...effectNight, status: "upcoming" as const };
      const view = await mount("get_event");
      try {
        await view.bridge.sendToolInput({ arguments: { slug: ahead.slug } });
        await view.bridge.sendToolResult(result(ahead));
        const { document } = view.window;
        await until(
          () => document.querySelector(".evening-page") !== null,
          "the evening",
        );
        expect(document.querySelector(".expand")).toBeNull();
        const labels = all(view.window, ".evening-page button").map(text);
        expect(labels).not.toContain("Ask about it");
        expect(labels).not.toContain("Add to calendar");
        // Without the host saving files, the calendar file is a plain link.
        const calendar = all(view.window, ".evening-page a").find(
          (anchor) => text(anchor) === "Add to calendar",
        );
        expect(calendar?.getAttribute("href")).toBe(
          `${ahead.url}/calendar.ics`,
        );
        expect(view.contexts).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );
});

describe("get_year's view", () => {
  test(
    "draws the year: its statement, figures, photos, months, map and evenings",
    async () => {
      const view = await mount("get_year");
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult(result(yearOf(2026)));
        const { document } = view.window;
        await until(
          () => document.querySelector(".year-page") !== null,
          "the year",
        );
        expect(text(document.querySelector("h1"))).toBe(
          "450 people said “I’m in.” 2 evenings in 2026, in the neighborhoods of San Francisco.",
        );
        expect(all(view.window, ".figure dd").map(text)).toEqual([
          "2",
          "450",
          "3",
          "2",
        ]);
        const photo = document.querySelector(".photo-image");
        expect(photo?.getAttribute("src")).toBe(
          "https://media.allthings.dev/events/effect.jpg",
        );
        expect(photo?.getAttribute("alt")).toBe("Michael Arnaldi on stage");
        expect(photo?.getAttribute("loading")).toBe("lazy");
        // Twelve months, two with an evening.
        expect(all(view.window, ".month")).toHaveLength(12);
        expect(all(view.window, ".month:not(.month-quiet)")).toHaveLength(2);
        // The map says in words what its dots show.
        expect(text(document.querySelector(".map title"))).toBe(
          "Where we met in 2026: East Cut, 2 evenings.",
        );
        expect(all(view.window, ".year-page .evening")).toHaveLength(2);
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "shows another year through get_year, from its tabs",
    async () => {
      const view = await mount("get_year", (name, args) =>
        name === "get_year" && args["year"] === 2025
          ? result(yearOf(2025))
          : result({}),
      );
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult(result(yearOf(2026)));
        const { document } = view.window;
        await until(
          () => document.getElementById("year-2025") !== null,
          "tabs",
        );
        document.getElementById("year-2025")?.click();
        await until(
          () =>
            text(document.querySelector(".year-head .at-type-meta")) ===
            "2025 in evenings",
          "2025",
        );
        expect(view.calls).toEqual([
          { name: "get_year", arguments: { year: 2025 } },
        ]);
        expect(
          document.getElementById("year-2025")?.getAttribute("aria-selected"),
        ).toBe("true");
        expect(await view.axe()).toEqual([]);
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "opens an evening's lineup, and comes back to the year",
    async () => {
      const view = await mount(
        "get_year",
        (name) => (name === "get_event" ? result(effectNight) : result({})),
        { offers: { context: true } },
      );
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult(result(yearOf(2026)));
        const { document } = view.window;
        await until(
          () => document.querySelector(".year-page") !== null,
          "the year",
        );
        await until(() => view.contexts.length > 0, "the agent told");
        expect(view.contexts.at(-1)).toStartWith(
          "The reader is looking back on 2026 in the allthings view",
        );
        all(view.window, ".year-page .evening button")[0]?.click();
        await until(
          () => document.querySelector(".evening-page") !== null,
          "the lineup",
        );
        expect(view.calls).toEqual([
          { name: "get_event", arguments: { slug: effectNight.slug } },
        ]);
        const back = document.querySelector(".back");
        expect(text(back)).toBe("2026 in evenings");
        back?.click();
        await until(
          () => document.querySelector(".year-page") !== null,
          "the year again",
        );
      } finally {
        view.window.close();
      }
    },
    slow,
  );
});

describe("get_guide's view", () => {
  test(
    "draws what's next, soonest first, and every happening by its stars",
    async () => {
      const view = await mount("get_guide", undefined, {
        offers: { context: true },
      });
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult(result(guide));
        const { document } = view.window;
        await until(
          () => document.querySelector(".guide-page") !== null,
          "the guide",
        );
        expect(text(document.querySelector("h1"))).toBe("The allthings guide");
        // Next up: the dated ones, soonest first, each with its days.
        expect(all(view.window, ".timeline-name").map(text)).toEqual([
          "AI Engineer Miami",
          "React Miami",
        ]);
        expect(text(all(view.window, ".timeline-entry")[0])).toContain(
          "2099.04.26–27 · in ",
        );
        // The stars are said in words, not only drawn.
        expect(text(document.querySelector(".guide-entry .stars"))).toBe(
          "★★★3 stars, worth a special journey",
        );
        expect(
          text(
            all(view.window, ".guide-entry")[2]?.querySelectorAll(
              ".guide-when",
            )[0],
          ),
        ).toBe("Next dates not announced yet");
        expect(await view.axe()).toEqual([]);

        // Narrowed to two stars, and the agent told.
        all(view.window, ".chip")
          .find((chip) => chip.getAttribute("data-stars") === "2")
          ?.click();
        expect(
          all(view.window, ".guide-entry").filter((entry) => !entry.hidden),
        ).toHaveLength(1);
        expect(text(document.querySelector(".view-count"))).toBe(
          "1 of 3 happenings",
        );
        await until(
          () => view.contexts.at(-1)?.includes("with 2 stars") === true,
          "the agent told",
        );
        expect(view.contexts.at(-1)).toBe(
          "The reader is reading the allthings guide in the allthings view: 1 happening with 2 stars: Chain React.",
        );
      } finally {
        view.window.close();
      }
    },
    slow,
  );

  test(
    "asks the agent to help plan a trip, as the reader's message",
    async () => {
      const view = await mount("get_guide", undefined, {
        offers: { message: true },
      });
      try {
        await view.bridge.sendToolInput({ arguments: {} });
        await view.bridge.sendToolResult(result(guide));
        const { document } = view.window;
        await until(
          () => document.querySelector(".guide-page") !== null,
          "the guide",
        );
        all(view.window, ".guide-entry button")
          .find((button) => text(button) === "Plan a trip")
          ?.click();
        await until(() => view.messages.length > 0, "the message");
        expect(view.messages).toEqual([
          "Help me plan a trip to React Miami in Miami, Florida, 2099.04.29–30, from San Francisco.",
        ]);
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
