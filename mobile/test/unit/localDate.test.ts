import { describe, expect, it } from "vitest";
import { localDate, localDateTime } from "../../src/localDate.js";

// 2026-03-01T23:30Z is the next day in Tokyo and the same day in London.
const LATE_UTC = Date.parse("2026-03-01T23:30:00Z");

describe("localDate", () => {
  it.each([
    ["Asia/Tokyo", "2026-03-02"],
    ["Europe/London", "2026-03-01"],
  ])("gives the day in %s", (timeZone, day) => {
    expect(localDateTime(LATE_UTC, timeZone).date).toBe(day);
  });

  it("gives the device's day when no zone is passed", () => {
    const d = new Date(LATE_UTC);
    const p = (n: number) => String(n).padStart(2, "0");
    expect(localDate(LATE_UTC)).toBe(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  });

  it("gives the time of day beside the date", () =>
    expect(localDateTime(LATE_UTC, "Asia/Tokyo")).toEqual({
      date: "2026-03-02",
      time: "08:30",
    }));
});
