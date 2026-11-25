import type { EventSummary } from "allthings-core/src/contract.ts";
import { displayName, topicOf } from "allthings-core/src/lockup.ts";
import { neighborhoodOf } from "allthings-core/src/places.ts";
import { isPlaceholderTagline } from "allthings-core/src/tagline.ts";
import { type Child, cursor, h, link, spoken } from "./dom.ts";
import { count, day, simpleDate, timeRange } from "./format.ts";

/**
 * What every view says of an evening, as the site's lists say it
 * (web/src/pages/evening-row.tsx): at/<topic> with its slash, or the name
 * as written when it has no topic or is someone else's, with the cursor
 * until it has happened; its neighborhood, derived from the venue as the
 * site derives it (core/src/places.ts).
 */

type Evening = Pick<EventSummary, "name" | "status" | "curation">;

/** "at/effect_" in lists, "allthings/effect_" where it is the title. */
export function eveningName(
  evening: Evening,
  prefix: "at" | "allthings",
): ReadonlyArray<Child> {
  const topic = evening.curation === "ours" ? topicOf(evening.name) : undefined;
  const ahead = evening.status === "past" ? null : cursor();
  if (topic === undefined) return [displayName(evening.name), ahead];
  return [
    prefix,
    h("span", { class: "slash" }, "/"),
    // A long topic breaks after the slash, never inside a word.
    h("wbr", null),
    topic,
    ahead,
  ];
}

/** The evening's neighborhood, when its venue is a known one. */
export const neighborhood = (event: Pick<EventSummary, "venue">) =>
  neighborhoodOf([event.venue?.address ?? null, event.venue?.name ?? null]);

/** "Live now", for an evening under way: said once, beside its date. */
export const liveMark = (): HTMLElement =>
  h("span", { class: "live at-type-meta" }, "Live now");

/**
 * The evening's date as lists give it: the simple date once it's over,
 * and the weekday and time while people decide whether they can make it.
 */
export function eveningWhen(event: EventSummary): HTMLElement {
  if (event.status === "past") {
    return h(
      "p",
      { class: "evening-when at-type-meta" },
      h("time", { datetime: event.startsAt }, simpleDate(event.startsAt)),
    );
  }
  return h(
    "p",
    { class: "evening-when at-type-meta" },
    h("time", { datetime: event.startsAt }, day(event.startsAt)),
    h(
      "span",
      { class: "evening-time" },
      timeRange(event.startsAt, event.endsAt),
    ),
    event.status === "live" ? liveMark() : null,
  );
}

/** The heading each list of evenings has, by which evenings it holds. */
export const listTitles = {
  upcoming: "Coming up",
  past: "Recently",
  all: "Every evening",
} as const;

export type Selection = keyof typeof listTitles;

export const isSelection = (value: unknown): value is Selection =>
  typeof value === "string" && Object.hasOwn(listTitles, value);

export interface EveningsOptions {
  /** Which evenings list_events was asked for. */
  readonly when: Selection;
  /**
   * Opens an evening's lineup in the view, through get_event; absent when
   * the host can't call tools for the view.
   */
  readonly open?: (slug: string, from: HTMLButtonElement) => void;
  /**
   * Lists another selection of evenings, through list_events; absent when
   * the host can't call tools for the view.
   */
  readonly browse?: (when: Selection) => void;
  /** Hears which neighborhood the reader narrowed the list to, if any. */
  readonly narrowed?: (place: string | null, shown: number) => void;
}

const selections = Object.keys(listTitles) as ReadonlyArray<Selection>;

/**
 * The selections as tabs: arrows move between them, Home and End go to the
 * ends, and Enter, Space or a click lists that selection.
 */
function selectionTabs(
  when: Selection,
  browse: (when: Selection) => void,
): HTMLElement {
  const tabs = selections.map((selection) => {
    const selected = selection === when;
    const tab = h(
      "button",
      {
        type: "button",
        role: "tab",
        class: "tab",
        id: `tab-${selection}`,
        "aria-selected": String(selected),
        "aria-controls": "evenings-list",
        tabindex: selected ? "0" : "-1",
      },
      listTitles[selection],
    );
    tab.addEventListener("click", () => {
      if (!selected) browse(selection);
    });
    return tab;
  });
  const list = h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "Which evenings" },
    tabs,
  );
  list.addEventListener("keydown", (event) => {
    const at = tabs.findIndex((tab) => tab === document.activeElement);
    if (at === -1) return;
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    for (const [index, tab] of tabs.entries()) {
      tab.setAttribute("tabindex", index === next ? "0" : "-1");
    }
    tabs[next]?.focus();
  });
  return list;
}

/** list_events: the evenings, each a ruled row with what to do about it. */
export function eveningsView(
  events: ReadonlyArray<EventSummary>,
  { when, open, browse, narrowed }: EveningsOptions,
): HTMLElement {
  const rows = events.map((event, index) => {
    const nameId = `evening-${index}`;
    const place = neighborhood(event);
    const actions: Array<HTMLElement> = [];
    if (event.status !== "past" && event.rsvpUrl !== null) {
      actions.push(
        link(
          event.rsvpUrl,
          { class: "button", "aria-describedby": nameId },
          "I’m in",
        ),
      );
    }
    if (open !== undefined) {
      const button = h(
        "button",
        { type: "button", class: "quiet", "aria-describedby": nameId },
        event.isHackathon ? "Details" : "Who’s on stage",
      );
      button.addEventListener("click", () => open(event.slug, button));
      actions.push(button);
    }
    if (event.status === "past" && event.recordingUrl !== null) {
      actions.push(
        link(
          event.recordingUrl,
          { class: "quiet", "aria-describedby": nameId },
          "Recording",
        ),
      );
    }
    const row = h(
      "li",
      { class: "evening", "data-place": place ?? "" },
      eveningWhen(event),
      h(
        "div",
        { class: "evening-body" },
        h(
          "h2",
          { class: "evening-name at-type-list-name", id: nameId },
          link(event.url, { class: "plain" }, ...eveningName(event, "at")),
        ),
        event.organizer === null
          ? null
          : h(
              "p",
              { class: "at-type-meta" },
              `shared · by ${event.organizer.name}`,
            ),
        isPlaceholderTagline(event.tagline)
          ? null
          : h("p", { class: "evening-tagline" }, event.tagline),
        place === null
          ? null
          : h(
              "p",
              { class: "evening-place at-type-list-place" },
              spoken("Neighborhood: "),
              place,
            ),
        actions.length === 0 ? null : h("div", { class: "actions" }, actions),
      ),
    );
    return row;
  });
  const counted = h(
    "p",
    { class: "view-count at-type-meta", role: "status" },
    count(events.length, "evening", "evenings"),
  );
  // The neighborhoods these evenings were in, most evenings first.
  const tally = new Map<string, number>();
  for (const event of events) {
    const place = neighborhood(event);
    if (place !== null) tally.set(place, (tally.get(place) ?? 0) + 1);
  }
  const places = [...tally.entries()].toSorted(
    ([a, m], [b, n]) => n - m || a.localeCompare(b),
  );
  const chips: Array<HTMLButtonElement> = [];
  const narrow = (place: string | null) => {
    for (const chip of chips) {
      chip.setAttribute(
        "aria-pressed",
        String((chip.dataset["place"] ?? "") === (place ?? "")),
      );
    }
    let shown = 0;
    for (const row of rows) {
      const match = place === null || row.dataset["place"] === place;
      row.hidden = !match;
      if (match) shown++;
    }
    counted.textContent =
      place === null
        ? count(events.length, "evening", "evenings")
        : `${shown} of ${count(events.length, "evening", "evenings")} in ${place}`;
    narrowed?.(place, shown);
  };
  const everywhere = h(
    "button",
    { type: "button", class: "chip", "aria-pressed": "true", "data-place": "" },
    "Everywhere",
  );
  everywhere.addEventListener("click", () => narrow(null));
  chips.push(everywhere);
  for (const [place, evenings] of places) {
    const chip = h(
      "button",
      {
        type: "button",
        class: "chip",
        "aria-pressed": "false",
        "data-place": place,
      },
      place,
      h("span", { class: "chip-count" }, spoken(", "), String(evenings)),
    );
    chip.addEventListener("click", () => narrow(place));
    chips.push(chip);
  }
  return h(
    "section",
    { class: "view", "aria-labelledby": "view-title" },
    h(
      "header",
      { class: "view-head" },
      h("h1", { class: "view-title", id: "view-title" }, listTitles[when]),
      counted,
    ),
    browse === undefined ? null : selectionTabs(when, browse),
    places.length < 2
      ? null
      : h(
          "div",
          { class: "chips", role: "group", "aria-label": "Neighborhood" },
          chips,
        ),
    h(
      "div",
      {
        id: "evenings-list",
        ...(browse === undefined
          ? {}
          : { role: "tabpanel", "aria-labelledby": `tab-${when}` }),
      },
      events.length === 0
        ? h(
            "p",
            { class: "notice" },
            when === "upcoming"
              ? "No evenings are on the calendar yet. They go up on Luma first: "
              : "No evenings to show. ",
            link("https://luma.com/allthings", null, "luma.com/allthings"),
            ".",
          )
        : h("ol", { class: "evenings" }, rows),
    ),
  );
}
