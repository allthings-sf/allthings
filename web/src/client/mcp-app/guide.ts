import type { Guide, GuideEntry } from "allthings-core/src/contract.ts";
import { h, link, spoken } from "./dom.ts";
import { actButton } from "./evening.ts";
import { count, simpleDays, todayInSanFrancisco } from "./format.ts";

/**
 * get_guide: happenings worth the trip, starred as the Michelin guide stars
 * a restaurant, as /guide gives them: what's next, on a line from today to
 * the furthest announced edition, then every entry by its stars, with why
 * it's worth going, who runs it and when it is. Where the host takes
 * messages from the view, each entry can ask the agent to help plan the
 * trip.
 */

export interface GuideOptions {
  /** Asks the agent to help plan a trip, as the reader's own message. */
  readonly ask?: (question: string) => Promise<void>;
  /** Hears which stars the reader narrowed the guide to, if any. */
  readonly narrowed?: (stars: number | null, shown: number) => void;
}

/** The stars, drawn, and said as words. */
const starsOf = (entry: Pick<GuideEntry, "stars" | "meaning">) =>
  h(
    "span",
    { class: "stars" },
    h(
      "span",
      { class: "stars-drawn", "aria-hidden": "true" },
      "★".repeat(entry.stars),
    ),
    spoken(
      `${entry.stars} ${entry.stars === 1 ? "star" : "stars"}, ${entry.meaning}`,
    ),
  );

/** Days from `from` (YYYY-MM-DD) to `to`, on the calendar alone. */
const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );

/** "in 152 days", "tomorrow", "on now". */
function countdown(entry: GuideEntry, today: string): string | null {
  if (entry.next === null) return null;
  const until = daysBetween(today, entry.next.from);
  if (until > 1) return `in ${until} days`;
  if (until === 1) return "tomorrow";
  return daysBetween(today, entry.next.to) >= 0 ? "on now" : null;
}

/**
 * What's next: every announced edition on one line from today, placed by
 * how far away it is, each saying when it is and how long until then.
 */
function nextUp(
  entries: ReadonlyArray<GuideEntry>,
  today: string,
): HTMLElement | null {
  const dated = entries
    .flatMap((entry) =>
      entry.next === null ? [] : [{ entry, next: entry.next }],
    )
    .toSorted((a, b) => a.next.from.localeCompare(b.next.from));
  if (dated.length === 0) return null;
  const furthest = Math.max(
    1,
    ...dated.map(({ next }) => daysBetween(today, next.from)),
  );
  const last = dated.at(-1)?.next;
  return h(
    "section",
    { class: "part", "aria-labelledby": "next-title" },
    h("h2", { class: "part-title", id: "next-title" }, "Next up"),
    h(
      "p",
      { class: "timeline-axis at-type-meta", "aria-hidden": "true" },
      h("span", null, "Today"),
      last === undefined
        ? null
        : h("span", null, simpleDays(last.from, last.to)),
    ),
    h(
      "ol",
      { class: "timeline" },
      dated.map(({ entry, next }) => {
        const until = Math.max(0, daysBetween(today, next.from));
        // How far along the line from today it is, to the tenth.
        const step = Math.min(10, Math.round((until / furthest) * 10));
        return h(
          "li",
          { class: "timeline-entry", "data-step": String(step) },
          h("span", { class: "timeline-mark", "aria-hidden": "true" }),
          h(
            "span",
            { class: "timeline-text" },
            link(entry.url, { class: "plain timeline-name" }, entry.name),
            h(
              "span",
              { class: "at-type-meta" },
              h(
                "time",
                { datetime: next.from },
                simpleDays(next.from, next.to),
              ),
              ` · ${countdown(entry, today) ?? ""}`,
            ),
          ),
        );
      }),
    ),
  );
}

export function guideView(
  guide: Guide,
  { ask, narrowed }: GuideOptions,
  today: string = todayInSanFrancisco(),
): HTMLElement {
  const cards = guide.entries.map((entry, index) => {
    const nameId = `guide-entry-${index}`;
    const when = countdown(entry, today);
    const actions: Array<HTMLElement> = [
      link(
        entry.guideUrl,
        { class: "quiet", "aria-describedby": nameId },
        "In the guide",
      ),
    ];
    if (ask !== undefined) {
      const question =
        entry.next === null
          ? `Help me plan a trip to ${entry.name} in ${entry.city}: when is the next one, and is it worth going from San Francisco?`
          : `Help me plan a trip to ${entry.name} in ${entry.city}, ${simpleDays(entry.next.from, entry.next.to)}, from San Francisco.`;
      const plan = actButton("Plan a trip", "Asking", () => ask(question));
      plan.setAttribute("aria-describedby", nameId);
      actions.push(plan);
    }
    return h(
      "li",
      { class: "guide-entry", "data-stars": String(entry.stars) },
      h(
        "div",
        { class: "guide-entry-head" },
        starsOf(entry),
        h(
          "h3",
          { class: "guide-name at-type-list-name", id: nameId },
          link(entry.url, { class: "plain" }, entry.name),
        ),
        h("p", { class: "at-type-meta" }, `${entry.city} · ${entry.organizer}`),
      ),
      h("p", { class: "prose" }, entry.why),
      h(
        "p",
        { class: "guide-when" },
        entry.next === null
          ? h("span", { class: "at-type-meta" }, "Next dates not announced yet")
          : h(
              "span",
              { class: "at-type-meta" },
              h(
                "time",
                { datetime: entry.next.from },
                simpleDays(entry.next.from, entry.next.to),
              ),
              when === null ? "" : ` · ${when}`,
            ),
      ),
      h("div", { class: "actions" }, actions),
    );
  });
  const levels = [
    ...new Set(guide.entries.map((entry) => entry.stars)),
  ].toSorted((a, b) => b - a);
  const counted = h(
    "p",
    { class: "view-count at-type-meta", role: "status" },
    count(guide.entries.length, "happening", "happenings"),
  );
  const chips: Array<HTMLButtonElement> = [];
  const narrow = (stars: number | null) => {
    let shown = 0;
    for (const card of cards) {
      const match = stars === null || card.dataset["stars"] === String(stars);
      card.hidden = !match;
      if (match) shown++;
    }
    for (const chip of chips) {
      chip.setAttribute(
        "aria-pressed",
        String((chip.dataset["stars"] ?? "") === String(stars ?? "")),
      );
    }
    counted.textContent =
      stars === null
        ? count(guide.entries.length, "happening", "happenings")
        : `${shown} of ${count(guide.entries.length, "happening", "happenings")}`;
    narrowed?.(stars, shown);
  };
  const every = h(
    "button",
    { type: "button", class: "chip", "aria-pressed": "true", "data-stars": "" },
    "Every star",
  );
  every.addEventListener("click", () => narrow(null));
  chips.push(every);
  for (const stars of levels) {
    const meaning =
      guide.entries.find((entry) => entry.stars === stars)?.meaning ?? "";
    const chip = h(
      "button",
      {
        type: "button",
        class: "chip",
        "aria-pressed": "false",
        "data-stars": String(stars),
      },
      h("span", { "aria-hidden": "true" }, "★".repeat(stars)),
      spoken(`${stars} ${stars === 1 ? "star" : "stars"}: `),
      meaning,
    );
    chip.addEventListener("click", () => narrow(stars));
    chips.push(chip);
  }
  return h(
    "section",
    { class: "view guide-page", "aria-labelledby": "view-title" },
    h(
      "header",
      { class: "view-head" },
      h("h1", { class: "view-title", id: "view-title" }, "The allthings guide"),
      counted,
    ),
    h("p", { class: "lead guide-about" }, guide.about),
    nextUp(guide.entries, today),
    h(
      "section",
      { class: "part", "aria-labelledby": "entries-title" },
      h("h2", { class: "part-title", id: "entries-title" }, "Worth the trip"),
      levels.length < 2
        ? null
        : h(
            "div",
            { class: "chips", role: "group", "aria-label": "Stars" },
            chips,
          ),
      h("ol", { class: "guide-entries" }, cards),
    ),
    h(
      "p",
      { class: "actions" },
      link(guide.url, { class: "quiet" }, "The guide on allthings.dev"),
    ),
  );
}
