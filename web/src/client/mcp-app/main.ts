import type { Event, EventSummary } from "allthings-core/src/contract.ts";
import {
  type Bridge,
  connect,
  type HostCapabilities,
  type HostContext,
  type Initialized,
  protocolVersion,
} from "./bridge.ts";
import { cursor, h, isWebUrl } from "./dom.ts";
import { eveningView } from "./evening.ts";
import { eveningsView, isSelection } from "./evenings.ts";

/**
 * The allthings view, as an MCP App (web/src/mcp/views.ts serves it). The
 * document names its view on <html data-view>: one per tool it renders.
 * It waits for the host's handshake, then for the tool's input and
 * result, and draws what the result's structured content holds. Where the
 * host lets it, it calls the server's own tools for what the reader asks
 * next (an evening's lineup), and asks the host to open
 * every link.
 */

/** A tool's result, as MCP's CallToolResult has it. */
interface ToolResult {
  readonly isError?: boolean;
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
  readonly structuredContent?: Record<string, unknown>;
}

const root = document.documentElement;
const view = root.dataset["view"];
const app = document.getElementById("app");

/** Replaces what the view shows. */
function show(content: HTMLElement): void {
  app?.replaceChildren(content);
}

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

/** Follows the host's theme: Paper for light, Night for dark. */
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

type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/** Shows an evening's lineup in place of the list, which `back` brings back. */
async function openEvening(
  callTool: CallTool,
  slug: string,
  back: () => void,
): Promise<void> {
  show(notice("Asking allthings for the lineup"));
  let evening: ToolResult;
  try {
    evening = await callTool("get_event", { slug });
  } catch {
    show(
      lineupFailed("The host couldn't ask allthings for that evening.", back),
    );
    return;
  }
  const detail = dataOf(evening);
  if (evening.isError === true || detail === undefined) {
    show(lineupFailed(errorOf(evening), back));
    return;
  }
  show(eveningView(detail as unknown as Event, { back }));
  document.getElementById("view-title")?.focus();
}

/** Draws `result` as `view` does, with what the host lets the view do next. */
function render(
  result: ToolResult,
  input: Record<string, unknown>,
  callTool: CallTool | undefined,
): void {
  if (result.isError === true) {
    show(notice(errorOf(result), "alert"));
    return;
  }
  const data = dataOf(result);
  if (view === "events" && Array.isArray(data?.["events"])) {
    const events = data["events"] as ReadonlyArray<EventSummary>;
    const when = isSelection(input["when"]) ? input["when"] : "upcoming";
    const list = eveningsView(events, {
      when,
      ...(callTool === undefined
        ? {}
        : {
            open: (slug, from) => {
              void openEvening(callTool, slug, () => {
                show(list);
                from.focus();
              });
            },
          }),
    });
    show(list);
    return;
  }
  if (
    view === "event" &&
    data !== undefined &&
    typeof data["slug"] === "string"
  ) {
    show(eveningView(data as unknown as Event, {}));
    return;
  }
  show(notice(errorOf(result), "alert"));
}

const unhosted = "This view is drawn by an agent host that speaks MCP Apps.";

async function start(): Promise<void> {
  // Opened on its own, there's no host to ask.
  if (window.parent === window) {
    show(notice(unhosted, "alert"));
    return;
  }
  const bridge = connect();
  let input: Record<string, unknown> = {};
  let callTool: CallTool | undefined;
  show(notice("Asking allthings"));
  // Handlers first: the host sends the tool's input as soon as it has answered.
  bridge.on("ui/notifications/tool-input", (params) => {
    const args = params["arguments"];
    if (args !== null && typeof args === "object") {
      input = args as Record<string, unknown>;
    }
  });
  bridge.on("ui/notifications/tool-result", (params) =>
    render(params, input, callTool),
  );
  bridge.on("ui/notifications/tool-cancelled", () =>
    show(notice("The call was cancelled before allthings answered.", "alert")),
  );
  bridge.on("ui/notifications/host-context-changed", (params) =>
    applyContext(params),
  );
  const initialized = (await bridge.request("ui/initialize", {
    appInfo: { name: "allthings", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion,
  })) as Initialized;
  const capabilities = initialized.hostCapabilities ?? {};
  applyContext(initialized.hostContext);
  if (capabilities.serverTools !== undefined) {
    callTool = async (name, args) =>
      (await bridge.request("tools/call", {
        name,
        arguments: args,
      })) as ToolResult;
  }
  openLinksThroughHost(bridge, capabilities);
  bridge.notify("ui/notifications/initialized", {});
  reportSize(bridge);
}

start().catch(() => show(notice(unhosted, "alert")));
