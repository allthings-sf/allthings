import type { Year, YearEvening } from "allthings-core/src/contract.ts";
import { displayName } from "allthings-core/src/lockup.ts";
import { type Child, h, isWebUrl, link, spoken } from "./dom.ts";
import { count, grouped, monthNames, monthOf, simpleDate } from "./format.ts";
import { neighborhoodMap, type Tally } from "./map.ts";

/**
 * get_year: a year of our evenings, looked back on, as its page on the site
 * tells it (web/src/pages/year.tsx): how many said "I'm in" over how many
 * evenings, the year's figures and photos, then the year month by month,
 * where we met, and every evening with who hosted and who was on stage.
 * Where the host lets the view call tools, the other years are a tab away
 * and each evening's lineup opens in place.
 */

export interface YearOptions {
  /** Shows another year, through get_year; absent when the host can't call tools. */
  readonly switchYear?: (year: number) => void;
  /** Opens an evening's lineup in place, through get_event. */
  readonly open?: (slug: string, from: HTMLButtonElement) => void;
}

/** "at/expo", or the name as written when it has no topic. */
const nameOf = (evening: YearEvening): ReadonlyArray<Child> =>
  evening.topic === null
    ? [displayName(evening.name)]
    : [
        "at",
        h("span", { class: "slash" }, "/"),
        // In a month's narrow column, a long topic breaks after the slash.
        h("wbr", null),
        evening.topic,
      ];

/** "Evan Bacon, Abhi Aiyer and Lydia Hallie", each a link to their page. */
function people(onStage: YearEvening["onStage"]): ReadonlyArray<Child> {
  return onStage.flatMap((person, index) => [
    index === 0 ? "" : index === onStage.length - 1 ? " and " : ", ",
    link(person.url, null, person.name),
  ]);
}

/** The statement the year's page opens with, from its tally. */
function statement(year: Year): { lead: string; after: string } {
  const evenings = count(year.tally.evenings, "evening", "evenings");
  const place = "the neighborhoods of San Francisco";
  return year.tally.guests > 0
    ? {
        lead: `${grouped(year.tally.guests)} people said “I’m in.”`,
        after: `${evenings} in ${year.year}, in ${place}.`,
      }
    : {
        lead: `${evenings} for people who build software.`,
        after: `In ${place}, in ${year.year}.`,
      };
}

/** The other years, as tabs that ask get_year for theirs. */
function yearTabs(year: Year, switchYear: (year: number) => void): HTMLElement {
  const tabs = year.years.map((other) => {
    const selected = other === year.year;
    const tab = h(
      "button",
      {
        type: "button",
        role: "tab",
        class: "tab",
        id: `year-${other}`,
        "aria-selected": String(selected),
        "aria-controls": "year-panel",
        tabindex: selected ? "0" : "-1",
      },
      String(other),
    );
    tab.addEventListener("click", () => {
      if (!selected) switchYear(other);
    });
    return tab;
  });
  const list = h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "Which year" },
    tabs,
  );
  list.addEventListener("keydown", (event) => {
    const at = tabs.findIndex((tab) => tab === document.activeElement);
    if (at === -1) return;
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (at + step + tabs.length) % tabs.length;
    for (const [index, tab] of tabs.entries()) {
      tab.setAttribute("tabindex", index === next ? "0" : "-1");
    }
    tabs[next]?.focus();
  });
  return list;
}

/** The year's figures, as the site's tally band gives them. */
function figures(year: Year): HTMLElement {
  const facts = (
    [
      ["evenings", year.tally.evenings],
      ["said “I’m in”", year.tally.guests],
      ["people on stage", year.tally.speakers],
      ["hosting companies", year.tally.hostingCompanies],
    ] as const
  ).filter(([, n]) => n > 0);
  return h(
    "section",
    { class: "figures", "aria-label": `In ${year.year}` },
    h(
      "dl",
      null,
      facts.map(([label, n]) =>
        h(
          "div",
          { class: "figure" },
          h("dt", { class: "at-type-meta" }, label),
          h("dd", null, grouped(n)),
        ),
      ),
    ),
  );
}

/** The year's photos, each leading to its evening. */
function photos(year: Year): HTMLElement | null {
  const shown = year.evenings.flatMap((evening) =>
    evening.photo === null || !isWebUrl(evening.photo.url)
      ? []
      : [{ evening, photo: evening.photo }],
  );
  if (shown.length === 0) return null;
  return h(
    "ul",
    { class: "photos", "aria-label": `Photos of ${year.year}` },
    shown.slice(0, 6).map(({ evening, photo }) => {
      const image = h("img", { class: "photo-image" });
      image.src = photo.url;
      image.alt = photo.alt;
      image.width = photo.width;
      image.height = photo.height;
      image.setAttribute("loading", "lazy");
      image.setAttribute("decoding", "async");
      return h(
        "li",
        { class: "photo" },
        link(
          evening.url,
          { class: "plain photo-link" },
          image,
          h(
            "span",
            { class: "photo-caption at-type-meta" },
            ...nameOf(evening),
            " · ",
            simpleDate(evening.startsAt),
          ),
        ),
      );
    }),
  );
}

/** The year month by month: each month and the evenings in it. */
function months(year: Year): HTMLElement {
  const byMonth = monthNames.map(() => [] as Array<YearEvening>);
  for (const evening of year.evenings) {
    byMonth[monthOf(evening.startsAt)]?.push(evening);
  }
  return h(
    "section",
    { class: "part", "aria-labelledby": "months-title" },
    h("h2", { class: "part-title", id: "months-title" }, "Month by month"),
    h(
      "ol",
      { class: "months" },
      monthNames.map((month, index) => {
        const held = byMonth[index] ?? [];
        return h(
          "li",
          { class: held.length === 0 ? "month month-quiet" : "month" },
          h("span", { class: "month-name at-type-meta" }, month),
          held.length === 0
            ? spoken(": no evening")
            : h(
                "ul",
                { class: "month-evenings" },
                held.map((evening) =>
                  h(
                    "li",
                    null,
                    link(
                      evening.url,
                      { class: "plain month-evening" },
                      ...nameOf(evening),
                    ),
                  ),
                ),
              ),
        );
      }),
    ),
  );
}

/** Where we met: the year's neighborhoods, by how many evenings each held. */
function where(year: Year): HTMLElement | null {
  const tally = new Map<string, number>();
  for (const evening of year.evenings) {
    if (evening.neighborhood !== null) {
      tally.set(
        evening.neighborhood,
        (tally.get(evening.neighborhood) ?? 0) + 1,
      );
    }
  }
  if (tally.size === 0) return null;
  const sorted: Tally = [...tally.entries()].toSorted(
    ([a, m], [b, n]) => n - m || a.localeCompare(b),
  );
  return h(
    "section",
    { class: "part", "aria-labelledby": "where-title" },
    h("h2", { class: "part-title", id: "where-title" }, "Where we met"),
    neighborhoodMap(sorted, `Where we met in ${year.year}`),
  );
}

/** Every evening of the year, as its page lists them. */
function everyEvening(year: Year, open: YearOptions["open"]): HTMLElement {
  return h(
    "section",
    { class: "part", "aria-labelledby": "every-title" },
    h(
      "h2",
      { class: "part-title", id: "every-title" },
      `Every evening of ${year.year}`,
    ),
    h(
      "ol",
      { class: "evenings" },
      year.evenings.map((evening, index) => {
        const nameId = `year-evening-${index}`;
        const lineup =
          open === undefined
            ? null
            : h(
                "button",
                {
                  type: "button",
                  class: "quiet",
                  "aria-describedby": nameId,
                },
                "Who’s on stage",
              );
        lineup?.addEventListener("click", () => {
          if (lineup !== null) open?.(evening.slug, lineup);
        });
        return h(
          "li",
          { class: "evening" },
          h(
            "p",
            { class: "evening-when at-type-meta" },
            h(
              "time",
              { datetime: evening.startsAt },
              simpleDate(evening.startsAt),
            ),
          ),
          h(
            "div",
            { class: "evening-body" },
            h(
              "h3",
              { class: "evening-name at-type-list-name", id: nameId },
              link(evening.url, { class: "plain" }, ...nameOf(evening)),
            ),
            evening.neighborhood === null
              ? null
              : h(
                  "p",
                  { class: "evening-place at-type-list-place" },
                  spoken("Neighborhood: "),
                  evening.neighborhood,
                ),
            evening.hosts.length === 0
              ? null
              : h(
                  "p",
                  { class: "evening-hosts" },
                  `Hosted by ${evening.hosts.join(" and ")}`,
                ),
            evening.onStage.length === 0
              ? null
              : h(
                  "p",
                  { class: "evening-stage" },
                  spoken("On stage: "),
                  ...people(evening.onStage),
                ),
            evening.guests === null
              ? null
              : h(
                  "p",
                  { class: "at-type-meta" },
                  `${grouped(evening.guests)} said “I’m in”`,
                ),
            lineup === null ? null : h("div", { class: "actions" }, lineup),
          ),
        );
      }),
    ),
  );
}

export function yearView(
  year: Year,
  { switchYear, open }: YearOptions,
): HTMLElement {
  const { lead, after } = statement(year);
  return h(
    "article",
    { class: "view year-page", "aria-labelledby": "view-title" },
    h(
      "header",
      { class: "year-head" },
      h("p", { class: "at-type-meta" }, `${year.year} in evenings`),
      h(
        "h1",
        { class: "statement", id: "view-title", tabindex: "-1" },
        h("span", { class: "statement-lead" }, lead),
        " ",
        h("span", { class: "statement-after" }, after),
      ),
    ),
    switchYear === undefined || year.years.length < 2
      ? null
      : yearTabs(year, switchYear),
    h(
      "div",
      {
        id: "year-panel",
        class: "year-panel",
        ...(switchYear === undefined || year.years.length < 2
          ? {}
          : { role: "tabpanel", "aria-labelledby": `year-${year.year}` }),
      },
      figures(year),
      photos(year),
      months(year),
      where(year),
      everyEvening(year, open),
      h(
        "p",
        { class: "actions" },
        link(year.url, { class: "quiet" }, `${year.year} on allthings.dev`),
      ),
    ),
  );
}
