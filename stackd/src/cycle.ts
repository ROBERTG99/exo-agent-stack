// Credit cycles (BUILD.md §4.8): a cycle starts on EXOS_CREDIT_CYCLE_DAY at 00:00 in
// EXOS_CREDIT_TZ and is labelled with the year and month it started in ("2026-10").
export interface CycleConfig {
  /** 1 to 28, so every month has the day. */
  cycleDay: number;
  /** An IANA time zone name such as "UTC" or "America/Argentina/Buenos_Aires". */
  tz: string;
}

export function validateCycleConfig(c: CycleConfig): CycleConfig {
  if (!Number.isInteger(c.cycleDay) || c.cycleDay < 1 || c.cycleDay > 28) {
    throw new Error("EXOS_CREDIT_CYCLE_DAY must be a whole number from 1 to 28");
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: c.tz });
  } catch {
    throw new Error(`EXOS_CREDIT_TZ "${c.tz}" is not a known time zone`);
  }
  return c;
}

/** The calendar date of `at` in the configured zone. */
function localDate(at: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function cycleOf(at: Date, config: CycleConfig): string {
  const { year, month, day } = localDate(at, config.tz);
  let y = year;
  let m = month;
  if (day < config.cycleDay) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}
