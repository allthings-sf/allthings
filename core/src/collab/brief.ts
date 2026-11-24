import { Schema } from "effect";
import { Lexer } from "marked";
import { type BriefSection, Role } from "./model.ts";

/**
 * A brief, written as Markdown, cut into the sections `planning.brief_sections`
 * stores (`bun run collab brief set <slug> --from brief.md`). Each section is
 * a `## ` heading, then a line saying who it is for, then its body:
 *
 *     # allthings/trivia            (a title, optional, not stored)
 *
 *     ## The pitch
 *     <!-- for: viewer, commenter, round_host, venue -->
 *     A trivia night for …
 *
 *     ## Venues
 *     <!-- for: organizer -->
 *     …
 *
 * Who a section is for is never assumed: a section without its line is
 * refused, so nothing reaches a collaborator by default. Organizers see
 * every section whatever it says. `###` and deeper stay in the body, as
 * does anything inside a code fence. A `---` rule at a section's end is
 * dropped: in the file it separates sections, and the page draws its own.
 *
 * Code fences are the ones Marked, which shows each section
 * (web/src/preview/brief.ts), reads in the brief as a whole: a shorter run
 * of backticks, or one with an info string, inside a fence stays in it, and
 * a run inside raw HTML, such as a comment, opens none. So a section never
 * holds a heading the page would show as another's. A fence that never
 * closes over a "## " line is refused: it would carry every section after
 * it into its own.
 */

export const maxSections = 50;
const maxHeading = 120;
const maxBody = 20000;

const isRole = Schema.is(Role);

/** Whether `line` closes the code fence `run` opened, as Marked reads one. */
const closesFence = (line: string, run: string): boolean => {
  const indented = /^ {0,3}/.exec(line)?.[0].length ?? 0;
  return (
    line.startsWith(run, indented) &&
    /^[`~]* *$/.test(line.slice(indented + run.length))
  );
};

/**
 * The lines (from 0) inside a fenced code block, as Marked reads `markdown`
 * as a whole, and the first such block that never closes over a "## "
 * line: its line (from 1) and the run that would close it.
 */
function fencedLines(markdown: string): {
  readonly inside: ReadonlySet<number>;
  readonly unclosed: { readonly line: number; readonly run: string } | null;
} {
  const inside = new Set<number>();
  let unclosed: { line: number; run: string } | null = null;
  let offset = 0;
  let line = 0;
  for (const token of new Lexer({ gfm: true }).lex(markdown)) {
    // Every block's raw text is the brief's, in order, but for a link
    // definition Marked rewrites, which holds no fence.
    const at = markdown.indexOf(token.raw, offset);
    if (at === -1 || token.raw === "") continue;
    for (let i = offset; i < at; i++) if (markdown[i] === "\n") line += 1;
    const first = line;
    const rows = token.raw.replace(/\n$/, "").split("\n");
    for (let i = at; i < at + token.raw.length; i++) {
      if (markdown[i] === "\n") line += 1;
    }
    offset = at + token.raw.length;
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1];
    if (token.type !== "code" || run === undefined) continue;
    for (let row = 0; row < rows.length; row++) inside.add(first + row);
    // One left open matters only where it holds a "## " line: a heading
    // meant as a section's, which would become the one before's.
    const closed = rows.length > 1 && closesFence(rows.at(-1) ?? "", run);
    const holdsHeading = rows.some((row) => row.startsWith("## "));
    if (!closed && holdsHeading && unclosed === null) {
      unclosed = { line: first + 1, run };
    }
  }
  return { inside, unclosed };
}

/** The sections `markdown` holds, or why it can't be stored. */
export function parseBrief(
  markdown: string,
): ReadonlyArray<BriefSection> | string {
  // Line ends as Marked reads them.
  const source = markdown.replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const fences = fencedLines(source);
  const sections: Array<{
    heading: string;
    lines: Array<string>;
    line: number;
  }> = [];
  for (const [index, line] of lines.entries()) {
    const heading = fences.inside.has(index) ? null : /^## (.*)$/.exec(line);
    if (heading !== null) {
      sections.push({
        heading: (heading[1] ?? "").trim(),
        lines: [],
        line: index + 1,
      });
      continue;
    }
    const current = sections.at(-1);
    if (current !== undefined) {
      current.lines.push(line);
    } else if (
      line.trim() !== "" &&
      !line.startsWith("# ") &&
      line.trim() !== "---"
    ) {
      return `Line ${index + 1} comes before the first "## " section. Put it in a section, so it says who it is for.`;
    }
  }
  if (fences.unclosed !== null) {
    return `Line ${fences.unclosed.line} opens a code fence that never closes. Close it with ${fences.unclosed.run}, so the sections after it stay their own.`;
  }
  if (sections.length === 0) return 'The brief has no "## " sections.';
  if (sections.length > maxSections) {
    return `The brief has ${sections.length} sections; at most ${maxSections}.`;
  }

  const parsed: Array<BriefSection> = [];
  for (const [index, section] of sections.entries()) {
    const where = `Section "${section.heading}" (line ${section.line})`;
    if (section.heading === "") return `${where} has no heading.`;
    if (section.heading.length > maxHeading) {
      return `${where}: its heading is over ${maxHeading} characters.`;
    }
    const first = section.lines.findIndex((line) => line.trim() !== "");
    const audience =
      first === -1
        ? null
        : /^\s*<!--\s*for:\s*([^>]*?)\s*-->\s*$/.exec(
            section.lines[first] ?? "",
          );
    if (audience === null) {
      return `${where} doesn't say who it is for. Its first line must be <!-- for: … --> with roles from ${Role.literals.join(", ")}.`;
    }
    const named = (audience[1] ?? "")
      .split(",")
      .map((role) => role.trim())
      .filter((role) => role !== "");
    const unknown = named.filter((role) => !isRole(role));
    if (named.length === 0 || unknown.length > 0) {
      return `${where} is for ${unknown.length > 0 ? `"${unknown.join(", ")}", which isn't a role` : "no one"}. Roles: ${Role.literals.join(", ")}.`;
    }
    const audiences = Role.literals.filter((role) => named.includes(role));
    const body = section.lines.slice(first + 1);
    while (
      body.length > 0 &&
      ["", "---"].includes((body.at(-1) ?? "").trim())
    ) {
      body.pop();
    }
    while (body.length > 0 && (body[0] ?? "").trim() === "") body.shift();
    const text = body.join("\n");
    if (text.trim() === "") return `${where} has nothing in it.`;
    if (text.length > maxBody) {
      return `${where} is ${text.length} characters; at most ${maxBody}.`;
    }
    parsed.push({
      position: index + 1,
      heading: section.heading,
      body: text,
      audiences,
    });
  }
  const headings = parsed.map((section) => section.heading.toLowerCase());
  const repeated = headings.find(
    (heading, index) => headings.indexOf(heading) !== index,
  );
  if (repeated !== undefined) {
    return `Two sections are headed "${repeated}": give each its own heading, so a comment names one.`;
  }
  return parsed;
}
