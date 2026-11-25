import assert from "node:assert/strict";
import { test } from "node:test";
import { currentDateInfo, isoWeek } from "../dates.js";

test("week boundaries for a Wednesday", () => {
  const info = currentDateInfo(new Date("2026-11-25T15:00:00Z"), "America/Toronto");
  assert.equal(info.today, "2026-11-25");
  assert.equal(info.dayOfWeek, "Wednesday");
  assert.equal(info.thisWeekStart, "2026-11-23");
  assert.equal(info.lastWeekStart, "2026-11-16");
  assert.equal(info.lastWeekEndExclusive, "2026-11-23");
  assert.equal(info.isoWeek, 48);
});

test("time zone decides the calendar date, not UTC", () => {
  // 03:00 UTC on the 26th is still the evening of the 25th in Toronto.
  const info = currentDateInfo(new Date("2026-11-26T03:00:00Z"), "America/Toronto");
  assert.equal(info.today, "2026-11-25");
});

test("Monday is its own week start; Sunday belongs to the week that began the previous Monday", () => {
  assert.equal(currentDateInfo(new Date("2026-11-23T15:00:00Z")).thisWeekStart, "2026-11-23");
  assert.equal(currentDateInfo(new Date("2026-11-29T15:00:00Z")).thisWeekStart, "2026-11-23");
});

test("month boundaries, including across a year", () => {
  const jan = currentDateInfo(new Date("2027-01-10T15:00:00Z"));
  assert.equal(jan.thisMonthStart, "2027-01-01");
  assert.equal(jan.lastMonthStart, "2026-12-01");
  assert.equal(jan.lastMonthEndExclusive, "2027-01-01");
});

test("ISO week handles year boundaries", () => {
  // 2026-01-01 is a Thursday, so it is in week 1 of 2026.
  assert.deepEqual(isoWeek(Date.UTC(2026, 0, 1)), { year: 2026, week: 1 });
  // 2027-01-01 is a Friday, belonging to the last ISO week of 2026 (week 53).
  assert.deepEqual(isoWeek(Date.UTC(2027, 0, 1)), { year: 2026, week: 53 });
  // 2024-12-30 is a Monday that already belongs to week 1 of 2025.
  assert.deepEqual(isoWeek(Date.UTC(2024, 11, 30)), { year: 2025, week: 1 });
});
