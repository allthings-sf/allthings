import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { mcpHandler } from "../src/mcp/server.ts";

/**
 * `/mcp` on this machine, for trying its views (src/mcp/apps.ts) in an
 * agent host: the server as the Worker builds it, with the faces and grain
 * the views load served from web/dist/public, and every tool answered by
 * allthings.dev's own `/mcp`, so a host shows the evenings as they are.
 * propose_talk is refused here: it would send a real proposal.
 *
 *   bun run build && bun scripts/mcp-app-dev.ts      # http://localhost:3001/mcp
 *   PORT=4000 bun scripts/mcp-app-dev.ts
 *   PUBLIC_ORIGIN=https://<tunnel> bun scripts/mcp-app-dev.ts
 *
 * PUBLIC_ORIGIN is where a host reaches this server, when that isn't the
 * address it was asked at (a tunnel that answers on https): the views name
 * it for their faces. SOURCE names another site to answer the tools.
 */

const port = Number(process.env["PORT"] ?? 3001);
const source = process.env["SOURCE"] ?? "https://allthings.dev";
const publicOrigin = process.env["PUBLIC_ORIGIN"];
const assets = join(import.meta.dir, "../dist/public");

/** The JSON-RPC message in an answer, whether sent as JSON or as an event stream. */
function messageOf(body: string): {
  result?: CallToolResult;
  error?: { message?: string };
} {
  const json = body.trimStart().startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length))
        .join("");
  return JSON.parse(json) as ReturnType<typeof messageOf>;
}

/** Asks `source`'s `/mcp` for the tool's answer. */
async function remote(
  name: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const response = await fetch(`${source}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: input },
    }),
  });
  const message = messageOf(await response.text());
  return (
    message.result ?? {
      isError: true,
      content: [
        {
          type: "text",
          text: message.error?.message ?? `${source} didn't answer ${name}`,
        },
      ],
    }
  );
}

const refused = async (): Promise<CallToolResult> => ({
  isError: true,
  content: [
    {
      type: "text",
      text: "propose_talk isn't answered here: propose on allthings.dev.",
    },
  ],
});

/**
 * Hosts that run in a browser page, as the MCP Apps reference host does,
 * call `/mcp` from their own origin: any may, here.
 */
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      const answer = await mcpHandler(
        remote,
        refused,
        publicOrigin ?? url.origin,
      )(request);
      const headers = new Headers(answer.headers);
      for (const [name, value] of Object.entries(cors))
        headers.set(name, value);
      return new Response(answer.body, { status: answer.status, headers });
    }
    if (url.pathname.startsWith("/assets/") && !url.pathname.includes("..")) {
      const file = Bun.file(join(assets, url.pathname));
      if (await file.exists()) {
        return new Response(file, {
          headers: { "access-control-allow-origin": "*" },
        });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `MCP with its views on ${new URL("/mcp", server.url).href}, its tools answered by ${source}`,
);
