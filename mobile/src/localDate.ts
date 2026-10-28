// Names given to the user (a route, a backup, an export) use the day the user remembers: the
// device's by default, or the zone a caller passes. The fields are picked by type, so the order
// is fixed here and not by the locale.
export function localDateTime(ms: number, timeZone?: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${at("year")}-${at("month")}-${at("day")}`,
    time: `${at("hour")}:${at("minute")}`,
  };
}

export function localDate(ms: number): string {
  return localDateTime(ms).date;
}
