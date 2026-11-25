import type { McpServer } from "@modelcontextprotocol/server";
import type { McpApp } from "../../scripts/build.ts";
import parts from "../../dist/mcp-app.json" with { type: "json" };
import { appMimeType, type ViewedTool, viewMeta, views } from "./apps.ts";

/**
 * The views' documents (apps.ts names them), as `resources/read` answers
 * them: each the one view's style and script (scripts/build.ts,
 * `buildMcpApp`) set inline in a document that draws `tool`'s result.
 * Only the server loads this (server.ts), never a tool's answer.
 */

const app: McpApp = parts;

/**
 * The document for `tool`'s view, with its faces and grain at
 * `assetOrigin`: the Worker that served it, which has them under the
 * hashed names its style names.
 */
export function viewDocument(tool: ViewedTool, assetOrigin: string): string {
  const style = app.style.replace(
    /url\((["']?)\/assets\//g,
    (_, quote: string) => `url(${quote}${assetOrigin}/assets/`,
  );
  return [
    "<!doctype html>",
    `<html lang="en" data-view="${views[tool].view}">`,
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${views[tool].title}</title>`,
    `<style>${style}</style>`,
    "</head>",
    "<body>",
    '<main id="app"></main>',
    `<script>${app.script}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Registers each view as a resource, its faces and grain from `assetOrigin`. */
export function registerViews(server: McpServer, assetOrigin: string): void {
  for (const tool of Object.keys(views) as Array<ViewedTool>) {
    const { uri, name, title, description } = views[tool];
    const _meta = viewMeta(assetOrigin);
    server.registerResource(
      name,
      uri,
      { title, description, mimeType: appMimeType, _meta },
      () => ({
        contents: [
          {
            uri,
            mimeType: appMimeType,
            text: viewDocument(tool, assetOrigin),
            _meta,
          },
        ],
      }),
    );
  }
}
