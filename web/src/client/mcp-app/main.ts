import type {
  Event,
  EventSummary,
  Speaker,
} from "allthings-core/src/contract.ts";
import {
  type Bridge,
  connect,
  type HostCapabilities,
  type HostContext,
  type Initialized,
  protocolVersion,
} from "./bridge.ts";
import { cursor, h, isWebUrl, link } from "./dom.ts";
import { eveningView, spokenName } from "./evening.ts";
import {
  eveningsView,
  isSelection,
  listTitles,
  type Selection,
} from "./evenings.ts";
import { fullDate } from "./format.ts";
import { type CallTool, type Host, hostOf, type ToolResult } from "./host.ts";
import { swap } from "./motion.ts";
import { peopleView } from "./people.ts";

/**
 * The allthings view, as an MCP App (web/src/mcp/views.ts serves it). The
 * document names its view on <html data-view>: one per tool it renders.
 * It waits for the host's handshake, then for the tool's input and
 * result, and draws what the result's structured content holds. What it
 * offers beyond that follows what the host offers (host.ts): it calls the
 * server's own tools for what the reader asks next (another selection of
 * evenings, an evening's lineup, another search), tells the agent what the
 * reader has open, asks the agent in the chat, saves calendar files, opens
 * full screen, and asks the host to open every link.
 */

const root = document.documentElement;
const view = root.dataset["view"];
const app = document.getElementById("app");

/** What the host offers, once it has said (start). */
let host: Host = {};

/** The masthead every view keeps: the wordmark, and full screen where offered. */
let masthead: HTMLElement | null = null;

/** The view's content under the masthead. */
const stage = h("div", { class: "stage" });

/**
 * Replaces what the view shows, moving `direction` where motion is
 * welcome, and resolves once the content is in place, for focus to move
 * into it.
 */
async function show(
  content: HTMLElement,
  direction: "forward" | "back" | "none" = "none",
): Promise<void> {
  if (app !== null && !app.contains(stage)) {
    app.replaceChildren(...(masthead === null ? [] : [masthead]), stage);
  }
  if (direction === "none") stage.replaceChildren(content);
  else await swap(stage, content, direction);
}

/**
 * Which change of view is the reader's latest: opening a lineup, going
 * back, another selection of evenings. Each takes the next number, and an
 * answer that comes back for any but the latest is dropped, so a slow
 * answer never replaces what the reader opened after asking for it.
 */
let latestChange = 0;
const nextChange = (): number => ++latestChange;
const isLatest = (change: number): boolean => change === latestChange;

/** A line saying what's happening: while waiting, or why there's nothing. */
function notice(
  text: string,
  role: "status" | "alert" = "status",
): HTMLElement {
  return h(
    "p",
    { class: role === "alert" ? "notice" : "waiting at-type-meta", role },
    text,
    role === "status" ? cursor() : null,
  );
}

/** The result's data: its structured content, or the JSON its text holds. */
function dataOf(result: ToolResult): Record<string, unknown> | undefined {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((part) => part.type === "text")?.text;
  try {
    const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What the tool said went wrong, as its text says it. */
const errorOf = (result: ToolResult): string =>
  result.content?.find((part) => part.type === "text")?.text ??
  "allthings couldn't answer that just now.";

/** Follows the host's theme (Paper for light, Night for dark) and frame. */
function applyContext(context: HostContext | undefined): void {
  if (context?.theme === "light" || context?.theme === "dark") {
    root.dataset["theme"] = context.theme;
  }
  // A frame of fixed height scrolls inside; otherwise the view sizes the frame.
  if (context?.containerDimensions !== undefined) {
    root.classList.toggle(
      "fixed-height",
      typeof context.containerDimensions.height === "number",
    );
  }
  if (typeof context?.displayMode === "string") {
    root.dataset["mode"] = context.displayMode;
    const toggle = masthead?.querySelector<HTMLButtonElement>(".expand");
    if (toggle !== undefined && toggle !== null) labelExpand(toggle);
  }
}

/** The full-screen toggle says what it will do next. */
function labelExpand(toggle: HTMLButtonElement): void {
  const full = root.dataset["mode"] === "fullscreen";
  toggle.setAttribute("aria-pressed", String(full));
  toggle.textContent = full ? "Back inline" : "Full screen";
}

/** The wordmark, linking home, and the full-screen toggle where the host offers it. */
function mastheadOf(): HTMLElement {
  const toggle =
    host.requestDisplayMode === undefined
      ? null
      : h("button", { type: "button", class: "quiet expand" });
  if (toggle !== null) {
    labelExpand(toggle);
    const flip = async () => {
      const next =
        root.dataset["mode"] === "fullscreen" ? "inline" : "fullscreen";
      try {
        const mode = await host.requestDisplayMode?.(next);
        if (mode !== undefined) root.dataset["mode"] = mode;
        labelExpand(toggle);
      } catch {
        // The host kept the frame as it was.
      }
    };
    toggle.addEventListener("click", () => {
      void flip();
    });
  }
  return h(
    "div",
    { class: "masthead" },
    link(
      "https://allthings.dev",
      { class: "mark" },
      "allthings",
      h("span", { class: "slash" }, "/"),
      cursor(),
    ),
    toggle,
  );
}

/**
 * Tells the host the view's size whenever it changes, as the MCP Apps SDK
 * does: measured at its content's own height, so a frame the host has
 * already grown doesn't hold it there. The content is watched as well as
 * the document: in a frame of fixed height the document never changes
 * size, and a host that gave it one may still grow it to fit (MCP
 * Inspector does).
 */
function reportSize(bridge: Bridge): void {
  let queued = false;
  let last = { width: 0, height: 0 };
  const measure = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      root.classList.add("measuring");
      const height = Math.ceil(root.getBoundingClientRect().height);
      root.classList.remove("measuring");
      const width = Math.ceil(window.innerWidth);
      if (width === last.width && height === last.height) return;
      last = { width, height };
      bridge.notify("ui/notifications/size-changed", { width, height });
    });
  };
  measure();
  // Every host's browser has it; without it, the view is measured once.
  if (typeof ResizeObserver !== "function") return;
  const observer = new ResizeObserver(measure);
  observer.observe(root);
  observer.observe(document.body);
  if (app !== null) observer.observe(app);
}

/**
 * Every link the view draws opens through the host, which may ask the
 * reader first. A host that refuses one has decided, so the view never
 * opens it another way. A host that doesn't open links leaves them to the
 * frame, as plain links that open in a new tab.
 */
function openLinksThroughHost(
  bridge: Bridge,
  capabilities: HostCapabilities,
): void {
  if (capabilities.openLinks === undefined) return;
  document.addEventListener("click", (event) => {
    const anchor =
      event.target instanceof Element ? event.target.closest("a") : null;
    if (anchor === null || !isWebUrl(anchor.href)) return;
    event.preventDefault();
    bridge.request("ui/open-link", { url: anchor.href }).catch(() => {
      // Refused: the host said no, or couldn't, and the link stays shut.
    });
  });
}

/**
 * Why the lineup isn't shown, with the way back to the list it replaced,
 * so a failed request never strands the reader.
 */
function lineupFailed(text: string, back: () => void): HTMLElement {
  const backButton = h(
    "button",
    { type: "button", class: "quiet back" },
    "All evenings",
  );
  backButton.addEventListener("click", back);
  return h(
    "section",
    { class: "view" },
    h("nav", { "aria-label": "Evenings" }, backButton),
    notice(text, "alert"),
  );
}

/** Tells the agent which evening the reader has open, and what's in it. */
function tellEvening(event: Event): void {
  const name = spokenName(event);
  host.tellModel?.(
    `The reader has ${name} (${fullDate(event.startsAt)}) open in the allthings view, with ${event.talks.length === 1 ? "1 talk" : `${event.talks.length} talks`}${event.talks.length === 0 ? "" : `: ${event.talks.map((talk) => `“${talk.title}”`).join(", ")}`}.`,
    { view: "evening", slug: event.slug, url: event.url },
  );
}

/** Tells the agent which evenings the reader has in front of them. */
function tellEvenings(when: Selection, shown: number, place: string | null) {
  host.tellModel?.(
    `The reader is looking at ${listTitles[when].toLowerCase()} in the allthings view: ${shown === 1 ? "1 evening" : `${shown} evenings`}${place === null ? "" : ` in ${place}`}.`,
    { view: "evenings", when, place, shown },
  );
}

/** The lineup view's options, as the host allows them. */
const lineupOptions = (back?: () => void) => ({
  ...(back === undefined ? {} : { back }),
  ...(host.download === undefined
    ? {}
    : {
        saveToCalendar: (url: string, name: string) =>
          host.download?.({ url, name, mimeType: "text/calendar" }) ??
          Promise.resolve(),
      }),
  ...(host.askInChat === undefined
    ? {}
    : {
        ask: (question: string) =>
          host.askInChat?.(question) ?? Promise.resolve(),
      }),
});

/** Shows an evening's lineup in place of the list, which `back` brings back. */
async function openEvening(
  callTool: CallTool,
  slug: string,
  back: () => void,
): Promise<void> {
  const change = nextChange();
  await show(notice("Asking allthings for the lineup"));
  let evening: ToolResult;
  try {
    evening = await callTool("get_event", { slug });
  } catch {
    if (isLatest(change)) {
      await show(
        lineupFailed("The host couldn't ask allthings for that evening.", back),
      );
    }
    return;
  }
  if (!isLatest(change)) return;
  const detail = dataOf(evening);
  if (evening.isError === true || detail === undefined) {
    await show(lineupFailed(errorOf(evening), back));
    return;
  }
  const event = detail as unknown as Event;
  await show(eveningView(event, lineupOptions(back)), "forward");
  tellEvening(event);
  document.getElementById("view-title")?.focus();
}

/** Says, over the list it leaves in place, why another selection didn't come. */
function browseFailed(panel: HTMLElement | null, text: string): void {
  panel?.querySelector(":scope > [role=alert]")?.remove();
  panel?.prepend(notice(text, "alert"));
}

/**
 * Marks `panel` busy for `change`, until that change's answer comes,
 * whether it is drawn or dropped. A panel left behind (the reader opened a
 * lineup meanwhile) is never left busy, and an older answer never clears
 * the mark of a newer change on the same panel.
 */
function markBusy(panel: HTMLElement | null, change: number): void {
  if (panel === null) return;
  panel.setAttribute("aria-busy", "true");
  panel.dataset["busyFor"] = String(change);
}

function clearBusy(panel: HTMLElement | null, change: number): void {
  if (panel === null || panel.dataset["busyFor"] !== String(change)) return;
  panel.removeAttribute("aria-busy");
  delete panel.dataset["busyFor"];
}

/** Lists another selection of evenings in place, keeping the list until it's in. */
async function browseEvenings(
  callTool: CallTool,
  when: Selection,
  limit: unknown,
): Promise<void> {
  const args = { when, ...(typeof limit === "number" ? { limit } : {}) };
  const change = nextChange();
  const panel = document.getElementById("evenings-list");
  markBusy(panel, change);
  let found: ToolResult;
  try {
    found = await callTool("list_events", args);
  } catch {
    clearBusy(panel, change);
    if (isLatest(change)) {
      browseFailed(
        panel,
        "The host couldn't ask allthings for those evenings.",
      );
    }
    return;
  }
  clearBusy(panel, change);
  if (!isLatest(change)) return;
  // A selection that couldn't be read leaves the list and its tabs as
  // they were, to try again or choose another.
  if (found.isError === true || !Array.isArray(dataOf(found)?.["events"])) {
    browseFailed(panel, errorOf(found));
    return;
  }
  await render(found, args, "forward");
  document.getElementById(`tab-${when}`)?.focus();
}

/** The latest search asked for: only its answer is drawn. */
let latestSearch = 0;

/** Searches the people again, everyone for an empty search. */
async function searchPeople(callTool: CallTool, query: string): Promise<void> {
  const args = query === "" ? {} : { query };
  // A search asked again before the last one answered supersedes it: an
  // answer that comes back late, or a late failure, is dropped.
  const search = ++latestSearch;
  let found: ToolResult;
  try {
    found = await callTool("list_speakers", args);
  } catch {
    if (search === latestSearch) {
      searchFailed("The host couldn't ask allthings for that search.");
    }
    return;
  }
  if (search !== latestSearch) return;
  if (found.isError === true) {
    searchFailed(errorOf(found));
    return;
  }
  await render(found, args);
  document.getElementById("people-query")?.focus();
}

/**
 * Says why a search found nothing under its form, and keeps the people
 * already shown and the search itself, so the reader can try again.
 */
function searchFailed(text: string): void {
  document.querySelector(".search + [role=alert]")?.remove();
  document.querySelector(".search")?.after(notice(text, "alert"));
}

/** Draws `result` as `view` does, with what the host lets the view do next. */
async function render(
  result: ToolResult,
  input: Record<string, unknown>,
  direction: "forward" | "back" | "none" = "none",
): Promise<void> {
  if (result.isError === true) {
    await show(notice(errorOf(result), "alert"));
    return;
  }
  const { callTool } = host;
  const data = dataOf(result);
  if (view === "events" && Array.isArray(data?.["events"])) {
    const events = data["events"] as ReadonlyArray<EventSummary>;
    const when = isSelection(input["when"]) ? input["when"] : "upcoming";
    // What the list shows now, narrowed or not, to say again on coming back.
    let narrowedTo: { place: string | null; shown: number } = {
      place: null,
      shown: events.length,
    };
    const list = eveningsView(events, {
      when,
      narrowed: (place, shown) => {
        narrowedTo = { place, shown };
        tellEvenings(when, shown, place);
      },
      ...(callTool === undefined
        ? {}
        : {
            open: (slug, from) => {
              void openEvening(callTool, slug, () => {
                nextChange();
                void show(list, "back").then(() => {
                  tellEvenings(when, narrowedTo.shown, narrowedTo.place);
                  from.focus();
                  return undefined;
                });
              });
            },
            browse: (next) => {
              void browseEvenings(callTool, next, input["limit"]);
            },
          }),
    });
    await show(list, direction);
    tellEvenings(when, events.length, null);
    return;
  }
  if (
    view === "event" &&
    data !== undefined &&
    typeof data["slug"] === "string"
  ) {
    const event = data as unknown as Event;
    await show(eveningView(event, lineupOptions()), direction);
    tellEvening(event);
    return;
  }
  if (view === "speakers" && Array.isArray(data?.["speakers"])) {
    const query =
      typeof input["query"] === "string" ? input["query"] : undefined;
    const speakers = data["speakers"] as ReadonlyArray<Speaker>;
    await show(
      peopleView(speakers, {
        query,
        ...(callTool === undefined
          ? {}
          : {
              search: (next) => {
                void searchPeople(callTool, next);
              },
            }),
      }),
    );
    return;
  }
  await show(notice(errorOf(result), "alert"));
}

const unhosted = "This view is drawn by an agent host that speaks MCP Apps.";

async function start(): Promise<void> {
  // Opened on its own, there's no host to ask.
  if (window.parent === window) {
    await show(notice(unhosted, "alert"));
    return;
  }
  const bridge = connect();
  let input: Record<string, unknown> = {};
  await show(notice("Asking allthings"));
  // Handlers first: the host sends the tool's input as soon as it has answered.
  bridge.on("ui/notifications/tool-input", (params) => {
    const args = params["arguments"];
    if (args !== null && typeof args === "object") {
      input = args as Record<string, unknown>;
    }
  });
  bridge.on("ui/notifications/tool-result", (params) => {
    void render(params, input);
  });
  bridge.on("ui/notifications/tool-cancelled", () => {
    void show(
      notice("The call was cancelled before allthings answered.", "alert"),
    );
  });
  bridge.on("ui/notifications/host-context-changed", (params) =>
    applyContext(params),
  );
  const initialized = (await bridge.request("ui/initialize", {
    appInfo: { name: "allthings", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion,
  })) as Initialized;
  const capabilities = initialized.hostCapabilities ?? {};
  host = hostOf(bridge, capabilities, initialized.hostContext);
  masthead = mastheadOf();
  app?.replaceChildren(masthead, stage);
  applyContext(initialized.hostContext);
  openLinksThroughHost(bridge, capabilities);
  bridge.notify("ui/notifications/initialized", {});
  reportSize(bridge);
}

start().catch(() => {
  void show(notice(unhosted, "alert"));
});
