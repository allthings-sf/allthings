/**
 * The view's only way to make markup: elements and text nodes, never HTML
 * strings, so nothing a tool returns is ever parsed as markup. Attributes
 * are set by name, and no handler, style or URL attribute can be set but
 * a link's checked `href` (see {@link link}).
 */

export type Child = Node | string | false | null | undefined;
type Children = ReadonlyArray<Child | ReadonlyArray<Child>>;

/** Attribute names an element may be given: not handlers, styles or URLs. */
const settable =
  /^(?:class|id|lang|role|datetime|type|for|name|value|tabindex|hidden|aria-[a-z]+|data-[a-z-]+|autocomplete|enterkeyhint|inputmode|placeholder|spellcheck)$/;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string | undefined>> | null,
  ...children: Children
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined) continue;
    if (!settable.test(name)) throw new Error(`Refusing attribute ${name}`);
    element.setAttribute(name, value);
  }
  for (const child of children.flat()) {
    if (child === false || child === null || child === undefined) continue;
    element.append(child);
  }
  return element;
}

/** Whether `url` is an absolute http(s) URL: the only kind a link may hold. */
export function isWebUrl(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * A link out of the view, which the host opens (main.ts asks it to with
 * `ui/open-link`). A URL that isn't http(s) is shown as text, never linked.
 */
export function link(
  url: string,
  attributes: Readonly<Record<string, string | undefined>> | null,
  ...children: Children
): HTMLElement {
  if (!isWebUrl(url)) return h("span", attributes, ...children);
  const anchor = h("a", attributes, ...children);
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

/** The cursor means "not yet happened": upcoming and live evenings carry it. */
export const cursor = (): HTMLElement =>
  h("span", { class: "at-cursor", "aria-hidden": "true" }, "_");

/** Text only a screen reader hears, as the site's `.visually-hidden`. */
export const spoken = (text: string): HTMLElement =>
  h("span", { class: "visually-hidden" }, text);

const svgNamespace = "http://www.w3.org/2000/svg";

/** Attribute names an SVG element may be given: geometry and naming, no handlers or links. */
const svgSettable =
  /^(?:class|id|role|viewBox|preserveAspectRatio|focusable|x|y|x1|y1|x2|y2|cx|cy|r|width|height|d|points|text-anchor|dominant-baseline|aria-[a-z]+)$/;

/** An SVG element, made as `h` makes HTML ones: attributes by name, text as text. */
export function svg(
  tag: "svg" | "g" | "circle" | "text" | "title" | "desc" | "line" | "path",
  attributes: Readonly<Record<string, string | number | undefined>> | null,
  ...children: Children
): SVGElement {
  const element = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined) continue;
    if (!svgSettable.test(name)) throw new Error(`Refusing attribute ${name}`);
    element.setAttribute(name, String(value));
  }
  for (const child of children.flat()) {
    if (child === false || child === null || child === undefined) continue;
    element.append(child);
  }
  return element;
}
