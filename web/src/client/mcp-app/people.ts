import type { Speaker } from "allthings-core/src/contract.ts";
import { displayName, topicOf } from "allthings-core/src/lockup.ts";
import { h, link } from "./dom.ts";
import { personLinks } from "./evening.ts";
import { count, simpleDate } from "./format.ts";

/**
 * list_speakers: the people who have been on our stages, each with their
 * talks, newest first, and a search that asks list_speakers again through
 * the host where it can.
 */

/** "at/effect", or the evening's name as written when it has no topic. */
const eveningOf = (name: string): ReadonlyArray<string | HTMLElement> => {
  const topic = topicOf(name);
  return topic === undefined
    ? [displayName(name)]
    : ["at", h("span", { class: "slash" }, "/"), topic];
};

export interface PeopleOptions {
  /** What list_speakers was asked to search for, if anything. */
  readonly query: string | undefined;
  /** Searches again, through list_speakers; absent when the host can't call tools. */
  readonly search?: (query: string) => void;
}

export function peopleView(
  speakers: ReadonlyArray<Speaker>,
  { query, search }: PeopleOptions,
): HTMLElement {
  const form =
    search === undefined
      ? null
      : h(
          "form",
          { class: "search", role: "search" },
          h("label", { for: "people-query" }, "Search people and talks"),
          h("input", {
            id: "people-query",
            name: "query",
            type: "search",
            autocomplete: "off",
            enterkeyhint: "search",
            spellcheck: "false",
            value: query ?? "",
          }),
          h("button", { type: "submit", class: "button" }, "Search"),
        );
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const field = form.elements.namedItem("query");
    if (field instanceof HTMLInputElement) search?.(field.value.trim());
  });
  const people = speakers.map((speaker, index) =>
    h(
      "li",
      { class: "person-row" },
      h(
        "h2",
        { class: "person-name at-type-list-name", id: `person-${index}` },
        speaker.name,
      ),
      speaker.title === null
        ? null
        : h("p", { class: "person-title" }, speaker.title),
      personLinks(speaker.name, speaker.links),
      speaker.talks.length === 0
        ? null
        : h(
            "ol",
            { class: "person-talks", "aria-label": `Talks by ${speaker.name}` },
            [...speaker.talks]
              .toSorted((a, b) => b.date.localeCompare(a.date))
              .map((talk) =>
                h(
                  "li",
                  null,
                  link(talk.eventUrl, { class: "talk-link" }, talk.title),
                  h(
                    "span",
                    { class: "at-type-meta" },
                    ...eveningOf(talk.eventName),
                    " · ",
                    h("time", { datetime: talk.date }, simpleDate(talk.date)),
                  ),
                ),
              ),
          ),
    ),
  );
  const found = count(speakers.length, "person", "people");
  return h(
    "section",
    { class: "view", "aria-labelledby": "view-title" },
    h(
      "header",
      { class: "view-head" },
      h("h1", { class: "view-title", id: "view-title" }, "On our stages"),
      h(
        "p",
        { class: "view-count at-type-meta", role: "status" },
        query === undefined || query === "" ? found : `${found} for “${query}”`,
      ),
    ),
    form,
    speakers.length === 0
      ? h("p", { class: "notice" }, "No one on our stages matches that yet.")
      : h("ul", { class: "people-list" }, people),
  );
}
