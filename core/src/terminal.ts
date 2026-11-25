/**
 * Text from outside (a proposal, a post found by a search) as the review
 * commands print it to a terminal: shown, never acted on. Control
 * characters, which a terminal reads as instructions (C0 but the tab, DEL
 * and C1), are written as `\u` escapes, as JSON writes them; every other
 * character is left as it is. A line break is a control character too, so
 * a field never runs onto another line.
 */

/** Whether the UTF-16 code unit `code` is a C0 control, DEL or a C1 control. */
const isControl = (code: number): boolean =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** Whether `text` holds a control character, the tab included. */
export function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isControl(text.charCodeAt(index))) return true;
  }
  return false;
}

/** `text` with each control character but the tab as its `\u` escape. */
export function terminalText(text: string): string {
  if (!hasControl(text)) return text;
  let shown = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    shown +=
      isControl(code) && code !== 0x09
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : text[index];
  }
  return shown;
}
