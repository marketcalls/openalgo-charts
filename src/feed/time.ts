/**
 * Time conversions (ARCHITECTURE.md §4.0). Internal time is always UTC seconds.
 * Feed adapters convert broker formats here, at the edge:
 *   - REST history → IST date/time strings
 *   - WS feed      → epoch milliseconds
 * India observes no DST, so IST is a fixed UTC+5:30 offset.
 */

/** IST offset in seconds (UTC+5:30). */
export const IST_OFFSET_SECONDS = 5 * 3600 + 30 * 60;

/** Epoch milliseconds → UTC seconds. */
export function epochMsToUtcSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/**
 * Parse an IST wall-clock date/time string to UTC seconds. Accepts
 * `YYYY-MM-DD`, `YYYY-MM-DD HH:MM[:SS]`, and the `T`-separated ISO variant.
 * Parsing is explicit (never relies on the host machine's locale/timezone).
 */
export function istStringToUtcSeconds(input: string): number {
  const s = input.trim();
  const dt = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (dt === null) {
    throw new Error(`openalgo-charts: unparseable IST time string "${input}"`);
  }
  const year = Number(dt[1]);
  const month = Number(dt[2]);
  const day = Number(dt[3]);
  const hour = dt[4] !== undefined ? Number(dt[4]) : 0;
  const min = dt[5] !== undefined ? Number(dt[5]) : 0;
  const sec = dt[6] !== undefined ? Number(dt[6]) : 0;
  // Treat the components as IST wall-clock, then subtract the offset to get UTC.
  const asUtcMs = Date.UTC(year, month - 1, day, hour, min, sec);
  return Math.floor(asUtcMs / 1000) - IST_OFFSET_SECONDS;
}

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday .. 6 = Saturday, in IST. */
  weekday: number;
}

/** UTC seconds → IST calendar parts (for axis labels / tick decisions). */
export function utcSecondsToIstParts(utcSeconds: number): IstParts {
  const d = new Date((utcSeconds + IST_OFFSET_SECONDS) * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** Format UTC seconds as an IST `HH:MM` clock label. */
export function formatIstTime(utcSeconds: number): string {
  const p = utcSecondsToIstParts(utcSeconds);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format UTC seconds as an IST `DD Mon` date label. */
export function formatIstDate(utcSeconds: number): string {
  const p = utcSecondsToIstParts(utcSeconds);
  return `${pad2(p.day)} ${MONTHS[p.month - 1]}`;
}

/** True if the two UTC-second instants fall on different IST calendar days. */
export function isNewIstDay(prevUtcSeconds: number, utcSeconds: number): boolean {
  const a = utcSecondsToIstParts(prevUtcSeconds);
  const b = utcSecondsToIstParts(utcSeconds);
  return a.year !== b.year || a.month !== b.month || a.day !== b.day;
}
