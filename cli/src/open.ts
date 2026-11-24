import { win32 } from "node:path";

/** Windows' own folder: SystemRoot when it is a full path, else the usual one. */
const windowsRoot = (env: Record<string, string | undefined>): string => {
  const root = env["SystemRoot"];
  return root !== undefined && win32.isAbsolute(root) ? root : "C:\\Windows";
};

/**
 * The command that opens `url` in the system's browser on `platform`, as the
 * arguments to start it with: no shell or command processor reads them, so
 * the link reaches the opener whole, as one argument, whatever characters
 * its query holds. Undefined for anything but an http or https link.
 *
 * Windows opens it with url.dll's FileProtocolHandler, by the full path
 * under `SystemRoot`, as the `start` command would without its command
 * processor; macOS with `open`, and others with `xdg-open`.
 */
export function openCommand(
  platform: NodeJS.Platform,
  url: string,
  env: Record<string, string | undefined>,
): ReadonlyArray<string> | undefined {
  const link = URL.parse(url);
  if (
    link === null ||
    (link.protocol !== "https:" && link.protocol !== "http:")
  )
    return undefined;
  if (platform === "darwin") return ["open", link.href];
  if (platform === "win32") {
    return [
      win32.join(windowsRoot(env), "System32", "rundll32.exe"),
      "url.dll,FileProtocolHandler",
      link.href,
    ];
  }
  return ["xdg-open", link.href];
}
