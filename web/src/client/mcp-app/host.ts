import type { Bridge, HostCapabilities, HostContext } from "./bridge.ts";

/**
 * What the host lets the view do, read once from its answer to
 * `ui/initialize`: each is there only when the host said it offers it, so
 * a view draws the control for it only then, and a host that offers none
 * still gets a view that reads well on its own.
 */

/** A tool's result, as MCP's CallToolResult has it. */
export interface ToolResult {
  readonly isError?: boolean;
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
  readonly structuredContent?: Record<string, unknown>;
}

export type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/**
 * A file the site serves, for the host to save where the reader says: the
 * view links the site's own, never a copy of its own making.
 */
export interface Download {
  readonly name: string;
  readonly mimeType: string;
  readonly url: string;
}

export interface Host {
  /** Calls one of the server's tools (`tools/call`). */
  readonly callTool?: CallTool;
  /**
   * Tells the agent what the reader is looking at (`ui/update-model-context`),
   * for its next turn. Each call replaces the last.
   */
  readonly tellModel?: (text: string, data: Record<string, unknown>) => void;
  /** Puts a message in the chat as the reader's own (`ui/message`). */
  readonly askInChat?: (text: string) => Promise<void>;
  /** Saves a file through the host (`ui/download-file`). */
  readonly download?: (file: Download) => Promise<void>;
  /**
   * Asks to be drawn full screen or inline again
   * (`ui/request-display-mode`), and resolves with the mode the host set,
   * which may be another than the one asked for.
   */
  readonly requestDisplayMode?: (
    mode: "inline" | "fullscreen",
  ) => Promise<string>;
}

/**
 * Throws when a host answered a request but said it failed (`isError`),
 * as `ui/message` and `ui/download-file` may: the view then says it
 * couldn't, as for a refused request.
 */
function refused(result: unknown): void {
  if (
    result !== null &&
    typeof result === "object" &&
    "isError" in result &&
    result.isError === true
  ) {
    throw new Error("The host couldn't do that");
  }
}

/** Whether the host offers full screen, by the modes its context names. */
export const offersFullscreen = (context: HostContext | undefined): boolean =>
  context?.availableDisplayModes?.includes("fullscreen") === true;

export function hostOf(
  bridge: Bridge,
  capabilities: HostCapabilities,
  context: HostContext | undefined,
): Host {
  const host: {
    -readonly [K in keyof Host]: Host[K];
  } = {};
  if (capabilities.serverTools !== undefined) {
    host.callTool = async (name, args) =>
      (await bridge.request("tools/call", {
        name,
        arguments: args,
      })) as ToolResult;
  }
  // The view sends these two text, so it offers them only to a host that
  // takes text in them.
  if (capabilities.updateModelContext?.text !== undefined) {
    host.tellModel = (text, data) => {
      bridge
        .request("ui/update-model-context", {
          content: [{ type: "text", text }],
          structuredContent: data,
        })
        .catch(() => {
          // Context is a courtesy to the agent: the view goes on without it.
        });
    };
  }
  if (capabilities.message?.text !== undefined) {
    host.askInChat = async (text) => {
      refused(
        await bridge.request("ui/message", {
          role: "user",
          content: [{ type: "text", text }],
        }),
      );
    };
  }
  if (capabilities.downloadFile !== undefined) {
    host.download = async ({ name, mimeType, url }) => {
      refused(
        await bridge.request("ui/download-file", {
          contents: [{ type: "resource_link", uri: url, name, mimeType }],
        }),
      );
    };
  }
  if (offersFullscreen(context)) {
    host.requestDisplayMode = async (mode) => {
      const result = (await bridge.request("ui/request-display-mode", {
        mode,
      })) as { mode?: unknown };
      return typeof result.mode === "string" ? result.mode : "inline";
    };
  }
  return host;
}
