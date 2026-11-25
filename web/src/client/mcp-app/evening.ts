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
  /** What the way back says: "All evenings" unless given. */
  readonly backLabel?: string;
  /**
   * Saves the evening's calendar file (the site's own) through the host;
   * absent when the host doesn't save files, where it's a plain link.
   */
  readonly saveToCalendar?: (url: string, name: string) => Promise<void>;
  /**
   * Asks the agent about the evening, as a message in the chat from the
   * reader; absent when the host takes no messages from the view.
   */
  readonly ask?: (question: string) => Promise<void>;
}

/** The evening as a reader names it in a question: allthings/effect, or its name. */
export function spokenName(event: Event): string {
  return eveningName(event, "allthings")
    .map((part) =>
      typeof part === "string"
        ? part
        : part instanceof HTMLElement &&
            part.getAttribute("aria-hidden") !== "true"
          ? (part.textContent ?? "")
          : "",
    )
    .join("");
}

/**
 * A button that does `act`, saying so while it does and, if the host
 * couldn't, saying that in its place for a moment.
 */
export function actButton(
  label: string,
  doing: string,
  act: () => Promise<void>,
): HTMLButtonElement {
  const button = h("button", { type: "button", class: "quiet" }, label);
  const run = async () => {
    button.disabled = true;
    button.textContent = doing;
    try {
      await act();
      button.textContent = label;
    } catch {
      button.textContent = "The host couldn’t";
      setTimeout(() => {
        button.textContent = label;
      }, 2400);
    } finally {
      button.disabled = false;
    }
  };
  button.addEventListener("click", () => {
    void run();
  });
  return button;
}

/** One evening. Its title takes focus when it replaces a list (main.ts). */
export function eveningView(
  event: Event,
  { back, backLabel = "All evenings", saveToCalendar, ask }: EveningOptions,
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
  if (event.status !== "past") {
    // The site's own file, as the evening's page offers it.
    const calendar = `${event.url}/calendar.ics`;
    const file = `${event.slug}.ics`;
    actions.push(
      saveToCalendar === undefined
        ? link(calendar, { class: "quiet" }, "Add to calendar")
        : actButton("Add to calendar", "Saving", () =>
            saveToCalendar(calendar, file),
          ),
    );
  }
  if (event.recordingUrl !== null) {
    actions.push(link(event.recordingUrl, { class: "quiet" }, "Recording"));
  }
  actions.push(link(event.url, { class: "quiet" }, "On allthings.dev"));
  if (ask !== undefined) {
    const name = spokenName(event);
    actions.push(
      actButton("Ask about it", "Asking", () =>
        ask(
          event.status === "past"
            ? `Tell me about ${name}: who was on stage, what they talked about, and what they left behind.`
            : `Tell me about ${name}: who's on stage, when and where it is, and how to get in.`,
        ),
      ),
    );
  }
  const backButton =
    back === undefined
      ? null
      : h("button", { type: "button", class: "quiet back" }, backLabel);
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
