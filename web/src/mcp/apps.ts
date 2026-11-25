import type { ToolName } from "./tools.ts";

/**
 * The tools' views, as MCP Apps (SEP-1865, the `io.modelcontextprotocol/ui`
 * extension, revision 2026-01-26): a host that renders them shows
 * list_events, get_event and list_speakers as allthings draws them, in
 * the chat, and one that doesn't gets the same text it always did. Claude,
 * ChatGPT, VS Code, Cursor and Goose render them; terminal agents (Claude
 * Code, Codex, Gemini CLI) read the text.
 *
 * Each view is a `ui://` resource, one HTML document with its style and
 * script inline (views.ts), and a tool names its view in
 * `_meta.ui.resourceUri`. Views are always declared: a stateless server
 * can't tell which client is asking, and a host that doesn't render them
 * ignores the field, as the extension intends.
 *
 * This module holds only their names, which tools.ts reads with every
 * call; the documents are views.ts's, loaded with the server alone. The
 * names and the MIME type are @modelcontextprotocol/ext-apps's own, which
 * web/tests/mcp-apps.test.ts holds them to; the SDK itself isn't bundled,
 * as its server helpers do no more than this.
 */

/** The extension's identifier, as clients advertise it. */
export const uiExtension = "io.modelcontextprotocol/ui";

/** An MCP App's HTML, as the extension names its type. */
export const appMimeType = "text/html;profile=mcp-app";

/**
 * The tool's view under the key hosts read before `_meta.ui.resourceUri`:
 * deprecated, and set beside the new one as the SDK's `registerAppTool`
 * does, for hosts that haven't moved yet.
 */
const legacyResourceUri = "ui/resourceUri";

interface ViewInfo {
  readonly uri: `ui://${string}`;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** What the document draws (src/client/mcp-app/main.ts reads it). */
  readonly view: "events" | "event" | "speakers";
}

/** The views, by the tool each draws. */
export const views = {
  list_events: {
    uri: "ui://allthings/evenings.html",
    name: "evenings",
    title: "allthings evenings",
    description:
      "allthings evenings as the site lists them: when, the name with its slash, the neighborhood, and where to say you're in.",
    view: "events",
  },
  get_event: {
    uri: "ui://allthings/evening.html",
    name: "evening",
    title: "An allthings evening",
    description:
      "One allthings evening: when and where, who's on stage with their talks and links, and who hosts it.",
    view: "event",
  },
  list_speakers: {
    uri: "ui://allthings/people.html",
    name: "people",
    title: "People on allthings stages",
    description:
      "People who have spoken at allthings evenings, with their talks, and a search over them.",
    view: "speakers",
  },
} as const satisfies Partial<Record<ToolName, ViewInfo>>;

export type ViewedTool = keyof typeof views;

/** A tool's `_meta`, naming its view. */
export function toolView(tool: ViewedTool): Record<string, unknown> {
  const { uri } = views[tool];
  return { ui: { resourceUri: uri }, [legacyResourceUri]: uri };
}

/**
 * What a view's resource says to the host: it loads the faces and the
 * grain from `assetOrigin` and connects nowhere (it asks the host to call
 * tools for it), and it draws its own ground, so it wants no border.
 */
export const viewMeta = (assetOrigin: string) => ({
  ui: {
    csp: { connectDomains: [], resourceDomains: [assetOrigin] },
    prefersBorder: false,
  },
});
