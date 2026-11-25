/**
 * The view's side of MCP Apps (SEP-1865, the `io.modelcontextprotocol/ui`
 * extension): JSON-RPC 2.0 over `postMessage` with the host that framed
 * it. The spec says a view needs no SDK to speak it, and this one doesn't:
 * the SDK's View class with its schemas is about 540 KB, and the whole
 * view is served in every `resources/read`. web/tests/mcp-app-view.test.ts
 * holds this to the SDK's own host bridge (`AppBridge`), so the two agree
 * on the wire.
 */

/** The MCP Apps revision this view speaks. */
export const protocolVersion = "2026-01-26";

/** A JSON-RPC error, as a host answers a request it refuses. */
export class HostError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** What a host may say about itself and the frame (McpUiHostContext). */
export interface HostContext {
  readonly theme?: "light" | "dark";
  readonly displayMode?: string;
  readonly availableDisplayModes?: ReadonlyArray<string>;
  readonly containerDimensions?: {
    readonly height?: number;
    readonly maxHeight?: number;
  };
  readonly platform?: "web" | "desktop" | "mobile";
}

/** What a host can do for the view (McpUiHostCapabilities), as far as it's read. */
export interface HostCapabilities {
  readonly openLinks?: object;
  readonly serverTools?: object;
  readonly updateModelContext?: object;
  readonly message?: object;
  readonly downloadFile?: object;
}

/** The host's answer to `ui/initialize`. */
export interface Initialized {
  readonly hostCapabilities?: HostCapabilities;
  readonly hostContext?: HostContext;
}

type Params = Record<string, unknown>;

interface Message {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

export interface Bridge {
  /** Sends a request and resolves with its result, or rejects with a HostError. */
  readonly request: (method: string, params: Params) => Promise<unknown>;
  readonly notify: (method: string, params: Params) => void;
  /** Handles the host's notification `method`; the last handler set wins. */
  readonly on: (method: string, handler: (params: Params) => void) => void;
}

/**
 * Connects to `host`, the window that framed the view. Only its messages
 * are read: anything else posted to the view is ignored.
 */
export function connect(host: Window = window.parent): Bridge {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  const handlers = new Map<string, (params: Params) => void>();
  const post = (message: Params) => host.postMessage(message, "*");

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== host) return;
    const message = event.data as Message | null;
    if (message === null || typeof message !== "object") return;
    if (message.jsonrpc !== "2.0") return;
    const params =
      message.params !== null && typeof message.params === "object"
        ? (message.params as Params)
        : {};
    const { id, method } = message;
    if (typeof method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        // A request from the host: teardown and ping are answered at once,
        // as the view keeps nothing a teardown could lose.
        if (method === "ui/resource-teardown" || method === "ping") {
          post({ jsonrpc: "2.0", id, result: {} });
        } else {
          post({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `${method} is not supported` },
          });
        }
        return;
      }
      handlers.get(method)?.(params);
      return;
    }
    if (typeof id !== "number") return;
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    if (message.error !== undefined) {
      waiting.reject(
        new HostError(
          typeof message.error.code === "number" ? message.error.code : -32000,
          typeof message.error.message === "string"
            ? message.error.message
            : "The host refused the request",
        ),
      );
    } else {
      waiting.resolve(message.result);
    }
  });

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        post({ jsonrpc: "2.0", id, method, params });
      }),
    notify: (method, params) => post({ jsonrpc: "2.0", method, params }),
    on: (method, handler) => {
      handlers.set(method, handler);
    },
  };
}
