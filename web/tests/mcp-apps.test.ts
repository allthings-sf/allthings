import { describe, expect, test } from "bun:test";
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
} from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { mediaOrigin } from "../src/links.ts";
import { appMimeType, toolView, uiExtension, views } from "../src/mcp/apps.ts";
import { viewDocument } from "../src/mcp/views.ts";
import { mcpHandler } from "../src/mcp/server.ts";
import { htmlProblems, stylesheetUrls } from "./support/pages.ts";

/**
 * `/mcp`'s views, as MCP Apps hosts discover and read them (src/mcp/apps.ts):
 * three tools name a `ui://` resource, the resources are listed and read
 * with the extension's MIME type, and each is one valid document that
 * loads nothing but its faces and grain, from the Worker that served it.
 * The view's own behavior in a host is web/tests/mcp-app-view.test.ts's.
 */

const origin = "https://allthings.dev";

const answered = async (): Promise<CallToolResult> => ({
  content: [{ type: "text", text: "{}" }],
  structuredContent: {},
});

const handler = mcpHandler(answered, answered, origin);

/** The result of one JSON-RPC call to `/mcp`, as a 2025-era client makes it. */
async function rpc(
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await handler(
    new Request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const body = await response.text();
  const json = body.trimStart().startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length))
        .join("");
  const message = JSON.parse(json) as { result: Record<string, unknown> };
  return message.result;
}

interface ListedTool {
  readonly name: string;
  readonly _meta?: Record<string, unknown>;
}

interface ListedResource {
  readonly uri: string;
  readonly mimeType: string;
  readonly _meta?: { readonly ui?: unknown };
}

interface ReadContent extends ListedResource {
  readonly text: string;
}

const viewed = Object.keys(views) as Array<keyof typeof views>;

describe("the MCP Apps extension", () => {
  test("is named as @modelcontextprotocol/ext-apps names it", () => {
    expect(uiExtension).toBe(EXTENSION_ID);
    expect(appMimeType).toBe(RESOURCE_MIME_TYPE);
    for (const tool of viewed) {
      const meta = toolView(tool);
      // The deprecated key, beside the new one, as registerAppTool sets it.
      expect(meta).toEqual({
        ui: { resourceUri: views[tool].uri },
        [RESOURCE_URI_META_KEY]: views[tool].uri,
      });
    }
  });
});

describe("tools/list", () => {
  test("names a view for list_events, get_event, list_speakers and get_year, and for no other tool", async () => {
    const { tools } = (await rpc("tools/list")) as {
      tools: Array<ListedTool>;
    };
    const named = tools
      .filter((tool) => tool._meta?.["ui"] !== undefined)
      .map((tool) => tool.name);
    expect(named).toEqual([
      "list_events",
      "get_event",
      "list_speakers",
      "get_year",
    ]);
    for (const tool of tools) {
      if (named.includes(tool.name)) {
        expect(tool._meta).toEqual(toolView(tool.name as keyof typeof views));
      }
    }
  });
});

describe("resources/list", () => {
  test("lists each view as an MCP App that loads only from the site", async () => {
    const { resources } = (await rpc("resources/list")) as {
      resources: Array<ListedResource>;
    };
    expect(resources.map((resource) => resource.uri)).toEqual(
      viewed.map((tool) => views[tool].uri),
    );
    for (const resource of resources) {
      expect(resource.uri).toStartWith("ui://");
      expect(resource.mimeType).toBe(RESOURCE_MIME_TYPE);
      expect(resource._meta?.ui).toEqual({
        csp: { connectDomains: [], resourceDomains: [origin, mediaOrigin] },
        prefersBorder: false,
      });
    }
  });
});

describe("resources/read", () => {
  for (const tool of viewed) {
    describe(views[tool].uri, () => {
      const read = async () => {
        const { contents } = (await rpc("resources/read", {
          uri: views[tool].uri,
        })) as { contents: Array<ReadContent> };
        expect(contents).toHaveLength(1);
        const [content] = contents;
        if (content === undefined) throw new Error("No contents");
        return content;
      };

      test("is the view's document, with its CSP on it too", async () => {
        const content = await read();
        expect(content.uri).toBe(views[tool].uri);
        expect(content.mimeType).toBe(RESOURCE_MIME_TYPE);
        expect(content._meta?.ui).toEqual({
          csp: { connectDomains: [], resourceDomains: [origin, mediaOrigin] },
          prefersBorder: false,
        });
        expect(content.text).toBe(viewDocument(tool, origin));
      });

      test("is a valid HTML document", async () => {
        const { text } = await read();
        expect(text).toStartWith("<!doctype html>\n");
        expect(await htmlProblems(text)).toEqual([]);
      });

      test("loads its faces and grain from the site, and nothing else", async () => {
        const { text } = await read();
        const style = /<style>([\s\S]*)<\/style>/.exec(text)?.[1] ?? "";
        const urls = stylesheetUrls(style);
        expect(urls.some((url) => url.endsWith(".woff2"))).toBe(true);
        for (const url of urls) {
          expect(url.replace(/^["']/, "")).toStartWith(`${origin}/assets/`);
        }
        // No script or stylesheet of its own to fetch: both are inline.
        expect(text).not.toMatch(/<script [^>]*src=|<link /);
      });

      test("closes its style and script only where they end", async () => {
        const { text } = await read();
        expect(text.match(/<\/style/gi)).toHaveLength(1);
        expect(text.match(/<\/script/gi)).toHaveLength(1);
      });
    });
  }
});
