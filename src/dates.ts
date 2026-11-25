/**
 * Date helpers for the get_current_date tool. The DataWarehouse-API deliberately
 * does not understand relative dates ("last week") - the caller must turn them into
 * concrete yyyy-MM-dd values - and an LLM can't reliably know today's date, so this
 * hands it the date plus ready-made week boundaries.
 */

const DAY_MS = 86_400_000;

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today's calendar date in the given IANA time zone, as UTC-midnight milliseconds. */
function todayInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"));
}

/** ISO-8601 week number (weeks start Monday; week 1 contains the year's first Thursday). */
export function isoWeek(dateMs: number): { year: number; week: number } {
  const d = new Date(dateMs);
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dayNum + 3);
  const year = new Date(thursday).getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4);
  const firstThursdayDay = (new Date(firstThursday).getUTCDay() + 6) % 7;
  const week1Thursday = firstThursday - firstThursdayDay * DAY_MS + 3 * DAY_MS;
  return { year, week: 1 + Math.round((thursday - week1Thursday) / (7 * DAY_MS)) };
}

export interface CurrentDateInfo {
  timeZone: string;
  today: string;
  dayOfWeek: string;
  isoWeek: number;
  isoWeekYear: number;
  /** Monday of the current week. */
  thisWeekStart: string;
  /** Monday of last week - use as startDate for "last week". */
  lastWeekStart: string;
  /** Monday of the current week - use as the EXCLUSIVE endDate for "last week". */
  lastWeekEndExclusive: string;
  /** First day of the current month. */
  thisMonthStart: string;
  /** First day of last month. */
  lastMonthStart: string;
  /** First day of the current month - use as the EXCLUSIVE endDate for "last month". */
  lastMonthEndExclusive: string;
  note: string;
}

export function currentDateInfo(now: Date = new Date(), timeZone = "America/Toronto"): CurrentDateInfo {
  const todayMs = todayInZone(now, timeZone);
  const today = new Date(todayMs);
  const mondayOffset = (today.getUTCDay() + 6) % 7;
  const thisWeekStartMs = todayMs - mondayOffset * DAY_MS;
  const { year, week } = isoWeek(todayMs);

  const thisMonthStartMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
  const lastMonthStartMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1);

  return {
    timeZone,
    today: toIso(todayMs),
    dayOfWeek: today.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
    isoWeek: week,
    isoWeekYear: year,
    thisWeekStart: toIso(thisWeekStartMs),
    lastWeekStart: toIso(thisWeekStartMs - 7 * DAY_MS),
    lastWeekEndExclusive: toIso(thisWeekStartMs),
    thisMonthStart: toIso(thisMonthStartMs),
    lastMonthStart: toIso(lastMonthStartMs),
    lastMonthEndExclusive: toIso(thisMonthStartMs),
    note:
      "Weeks run Monday-Sunday. The hours endpoints treat endDate as EXCLUSIVE, so 'last week' is " +
      "startDate=lastWeekStart, endDate=lastWeekEndExclusive. isoWeek is the ISO-8601 week number, " +
      "which may or may not match how the business numbers its priority weeks.",
  };
}
