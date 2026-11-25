import type { Event, PersonLinks } from "allthings-core/src/contract.ts";
import { isPlaceholderTagline } from "allthings-core/src/tagline.ts";
import { h, link, spoken } from "./dom.ts";
import { eveningName, liveMark, neighborhood } from "./evenings.ts";
import { fullDate, timeRange } from "./format.ts";

/**
 * get_event: one evening as its page gives it, in brief: when and where,
 * the lockup, what to do about it, who's on stage and what they left
 * behind, and who hosts it.
 */

type Talk = Event["talks"][number];

const artifactLabels = {
  recording: "Recording",
  slides: "Slides",
  repo: "Code",
  site: "Site",
  other: "Link",
} as const;

/** A person's links, each named for a screen reader with whose it is. */
export function personLinks(
  name: string,
  links: PersonLinks,
): HTMLElement | null {
  const items = (
    [
      ["X", links.x],
      ["Bluesky", links.bluesky],
      ["LinkedIn", links.linkedin],
    ] as const
  ).flatMap(([label, url]) =>
    url === null
      ? []
      : [h("li", null, link(url, null, label, spoken(` (${name})`)))],
  );
  return items.length === 0 ? null : h("ul", { class: "links" }, items);
}

function talkView(talk: Talk, index: number): HTMLElement {
  const titleId = `talk-${index}`;
  const artifacts = [
    ...(talk.recording === null
      ? []
      : [{ url: talk.recording.url, label: "Recording" }]),
    ...talk.artifacts.map((artifact) => ({
      url: artifact.url,
      label:
        artifact.label ??
        (artifact.elsewhere === null
          ? artifactLabels[artifact.kind]
          : `${artifactLabels[artifact.kind]} at ${artifact.elsewhere}`),
    })),
  ];
  return h(
    "li",
    { class: "talk" },
    h("h3", { class: "talk-title", id: titleId }, talk.title),
    talk.speakers.length === 0
      ? null
      : h(
          "ul",
          { class: "people" },
          talk.speakers.map((speaker) =>
            h(
              "li",
              { class: "person" },
              h("span", { class: "person-name" }, speaker.name),
              speaker.title === null
                ? null
                : h("span", { class: "person-title" }, speaker.title),
              personLinks(speaker.name, speaker.links),
            ),
          ),
        ),
    talk.description === ""
      ? null
      : h(
          "details",
          { class: "about" },
          h("summary", null, "About the talk", spoken(`: ${talk.title}`)),
          h("p", { class: "prose" }, talk.description),
        ),
    artifacts.length === 0
      ? null
      : h(
          "ul",
          {
            class: "links artifacts",
            "aria-label": `What ${talk.title} left behind`,
          },
          artifacts.map(({ url, label }) =>
            h("li", null, link(url, null, label)),
          ),
        ),
  );
}

export interface EveningOptions {
  /** Takes the reader back to the list they came from, when they came from one. */
  readonly back?: () => void;
}

/** One evening. Its title takes focus when it replaces a list (main.ts). */
export function eveningView(
  event: Event,
  { back }: EveningOptions,
): HTMLElement {
  const place = neighborhood(event);
  const where = [
    event.venue?.name ?? null,
    event.venue?.address ?? null,
  ].filter((part): part is string => part !== null && part !== "");
  // The address often begins with the venue's name: say it once.
  const venue =
    where.length === 2 && where[1]?.startsWith(where[0] ?? "")
      ? [where[1]]
      : where;
  const actions: Array<HTMLElement> = [];
  if (event.status !== "past" && event.rsvpUrl !== null) {
    actions.push(link(event.rsvpUrl, { class: "button" }, "I’m in"));
  }
  if (event.recordingUrl !== null) {
    actions.push(link(event.recordingUrl, { class: "quiet" }, "Recording"));
  }
  actions.push(link(event.url, { class: "quiet" }, "On allthings.dev"));
  const backButton =
    back === undefined
      ? null
      : h("button", { type: "button", class: "quiet back" }, "All evenings");
  backButton?.addEventListener("click", () => back?.());
  return h(
    "article",
    { class: "view evening-page", "aria-labelledby": "view-title" },
    backButton === null
      ? null
      : h("nav", { "aria-label": "Evenings" }, backButton),
    h(
      "header",
      { class: "evening-head" },
      h(
        "p",
        { class: "evening-when at-type-meta" },
        h("time", { datetime: event.startsAt }, fullDate(event.startsAt)),
        h(
          "span",
          { class: "evening-time" },
          timeRange(event.startsAt, event.endsAt),
        ),
        event.status === "live" ? liveMark() : null,
      ),
      h(
        "h1",
        { class: "lockup", id: "view-title", tabindex: "-1" },
        ...eveningName(event, "allthings"),
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
        : h("p", { class: "lead" }, event.tagline),
      place === null && venue.length === 0
        ? null
        : h(
            "p",
            { class: "evening-where" },
            place === null
              ? null
              : h(
                  "span",
                  { class: "evening-place at-type-list-place" },
                  spoken("Neighborhood: "),
                  place,
                ),
            venue.length === 0 ? null : h("span", null, venue.join(", ")),
          ),
      h("div", { class: "actions" }, actions),
    ),
    event.talks.length === 0
      ? null
      : h(
          "section",
          { class: "part", "aria-labelledby": "stage-title" },
          h("h2", { class: "part-title", id: "stage-title" }, "On stage"),
          h("ol", { class: "talks" }, event.talks.map(talkView)),
        ),
    event.hosts.length === 0
      ? null
      : h(
          "section",
          { class: "part", "aria-labelledby": "hosts-title" },
          h("h2", { class: "part-title", id: "hosts-title" }, "Hosted at"),
          h(
            "ul",
            { class: "hosts" },
            event.hosts.map((host) =>
              h(
                "li",
                { class: "host" },
                h("h3", { class: "host-name" }, host.name),
                host.about === ""
                  ? null
                  : h("p", { class: "prose" }, host.about),
              ),
            ),
          ),
        ),
  );
}
