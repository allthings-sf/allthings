/**
 * A page as the search indexes it (ingest.ts): Markdown made from the HTML
 * the site serves, with its title, address and description, then the text
 * of its `<main>`, its headings, list items and blocks each on lines of
 * their own. Only what a reader reads goes in: no scripts, styles,
 * drawings or hidden marks, no navigation or footer (they're outside
 * `<main>`), and no addresses but the page's own, since every byte is
 * ingested (ledger.ts). The whole site comes to about 315,000 bytes.
 *
 * It reads the HTML with HTMLRewriter, which workerd and Bun both have.
 */

/** The most of one page's Markdown indexed, in bytes: past the longest page (/people, about 20,000) threefold. */
export const documentLimit = 65_536;

/** Elements whose text isn't read. */
const unread = [
  "script",
  "style",
  "svg",
  "template",
  "noscript",
  "[hidden]",
  '[aria-hidden="true"]',
];

/** Elements that start a line of their own. */
const blocks = [
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "dl",
  "dt",
  "dd",
  "tr",
  "blockquote",
  "figcaption",
  "br",
  "time",
];

/** Elements whose text runs on beside what's around it, set apart by a space. */
const inline = [
  "span",
  "a",
  "strong",
  "em",
  "b",
  "i",
  "small",
  "cite",
  "abbr",
  "code",
  "q",
  "data",
];

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** `text` with its character references read, as the HTML means them. */
export const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return entities[name.toLowerCase()] ?? whole;
  });

/** `text` cut to at most `limit` UTF-8 bytes, at a character's end. */
export function cut(text: string, limit = documentLimit): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= limit) return text;
  return new TextDecoder().decode(bytes.slice(0, limit)).replace(/�$/, "");
}

/** `html`'s page at `url` as Markdown, or undefined for a page with no `<main>`. */
export async function pageDocument(
  html: string,
  url: string,
): Promise<string | undefined> {
  let title = "";
  let description = "";
  let inTitle = false;
  let main = 0;
  let skipped = 0;
  let found = false;
  const out: Array<string> = [];
  const depth = (on: () => void, off: () => void) => ({
    element(element: { onEndTag(handler: () => void): void }) {
      on();
      element.onEndTag(off);
    },
  });
  const rewriter = new HTMLRewriter()
    .on("title", {
      element(element) {
        inTitle = true;
        element.onEndTag(() => {
          inTitle = false;
        });
      },
      text(chunk) {
        if (inTitle) title += chunk.text;
      },
    })
    .on('meta[name="description"]', {
      element(element) {
        description = element.getAttribute("content") ?? "";
      },
    })
    .on("main", {
      ...depth(
        () => {
          main++;
          found = true;
        },
        () => main--,
      ),
    })
    .on(
      unread.map((selector) => `main ${selector}`).join(", "),
      depth(
        () => skipped++,
        () => skipped--,
      ),
    )
    .on("main h1, main h2, main h3, main h4, main h5, main h6", {
      element(element) {
        if (skipped > 0) return;
        const level = Number(element.tagName.slice(1));
        out.push(`\n\n${"#".repeat(Math.min(level + 1, 6))} `);
        element.onEndTag(() => {
          out.push("\n\n");
        });
      },
    })
    .on("main li", {
      element() {
        if (skipped === 0) out.push("\n- ");
      },
    })
    // Inline elements set apart what they hold, as a page shows a name
    // beside a role: "Michael Arnaldi" "Founder & CEO", not one word.
    .on(inline.map((tag) => `main ${tag}`).join(", "), {
      element(element) {
        if (skipped > 0) return;
        out.push(" ");
        element.onEndTag(() => {
          out.push(" ");
        });
      },
    })
    .on(blocks.map((tag) => `main ${tag}`).join(", "), {
      element() {
        if (skipped === 0) out.push("\n");
      },
    })
    .on("main, main *", {
      text(chunk) {
        if (main > 0 && skipped === 0) out.push(chunk.text);
      },
    });
  await rewriter.transform(new Response(html)).text();
  if (!found) return undefined;
  const body = out
    .join("")
    .split("\n")
    // Inline elements are set apart by spaces, which punctuation after one
    // doesn't take: "at CodeRabbit." not "at CodeRabbit .".
    .map((line) =>
      decode(line)
        .replace(/\s+/g, " ")
        .replace(/ ([.,;:!?)])/g, "$1")
        .trim(),
    )
    .reduce<Array<string>>((lines, line) => {
      // One blank line at most, and none to start with.
      if (line === "" && (lines.length === 0 || lines.at(-1) === ""))
        return lines;
      // A list item whose text starts a block of its own keeps it on its line.
      if (lines.at(-1) === "-" && line !== "")
        return [...lines.slice(0, -1), `- ${line}`];
      return [...lines, line];
    }, [])
    .join("\n")
    .trim();
  const head = [
    `# ${decode(title).replace(/\s+/g, " ").trim()}`,
    url,
    decode(description).replace(/\s+/g, " ").trim(),
  ].filter((line) => line !== "" && line !== "# ");
  return cut(`${head.join("\n\n")}\n\n${body}\n`);
}
