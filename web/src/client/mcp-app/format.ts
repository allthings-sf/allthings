/**
 * Times as the site prints them (web/src/pages/time.ts), on the wall
 * clocks of San Francisco whatever the reader's zone: the same strings,
 * from the browser's Intl rather than Effect's DateTime, which the view
 * doesn't bundle. Only numbers are read from Intl's parts, so the text
 * never depends on the reader's locale.
 */

/** Where every evening happens; the contract's `timeZone` says the same. */
const timeZone = "America/Los_Angeles";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const parts = new Intl.DateTimeFormat("en-US", {
  timeZone,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

interface Local {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekDay: number;
}

/** The instant's date and time in San Francisco. */
function local(instant: string): Local {
  const read = Object.fromEntries(
    parts
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const at = (name: string) => read[name] ?? 0;
  const [year, month, date] = [at("year"), at("month"), at("day")];
  return {
    year,
    month,
    day: date,
    hour: at("hour"),
    minute: at("minute"),
    // The weekday of the local date, by the calendar alone.
    weekDay: new Date(Date.UTC(year, month - 1, date)).getUTCDay(),
  };
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** "2026.09.30": how lists of evenings date one. */
export function simpleDate(instant: string): string {
  const { year, month, day: date } = local(instant);
  return `${String(year).padStart(4, "0")}.${twoDigits(month)}.${twoDigits(date)}`;
}

/** "Wed Sep 30": the day of an evening. */
export function day(instant: string): string {
  const { weekDay, month, day: date } = local(instant);
  return `${weekdays[weekDay] ?? ""} ${months[month - 1] ?? ""} ${date}`;
}

/** "Wed Sep 30, 2026": the day of an evening, on its own page. */
export function fullDate(instant: string): string {
  return `${day(instant)}, ${local(instant).year}`;
}

/** "5:30 PM": the time of an evening. */
export function clockTime(instant: string): string {
  const { hour, minute } = local(instant);
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}:${twoDigits(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * "5:30–8:30 PM", "10:30 AM–8:30 PM", or, past midnight, "8:00 PM – Wed
 * Nov 5, 1:00 AM": when an evening starts and ends, each said once.
 */
export function timeRange(start: string, end: string): string {
  const [from, to] = [clockTime(start), clockTime(end)];
  if (day(start) !== day(end) || local(start).year !== local(end).year) {
    return `${from} – ${day(end)}, ${to}`;
  }
  const [fromClock = "", fromHalf] = from.split(" ");
  const [toClock = "", toHalf] = to.split(" ");
  return fromHalf === toHalf
    ? `${fromClock}–${toClock} ${toHalf ?? ""}`
    : `${from}–${to}`;
}

/** "1 evening", "3 evenings". */
export const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;
