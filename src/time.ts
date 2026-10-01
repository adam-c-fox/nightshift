export const TIME_ZONE = "America/Vancouver";

function parts(d: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
}

export function localDate(d = new Date(), timeZone = TIME_ZONE): string {
  const p = parts(d, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function runStamp(d = new Date(), timeZone = TIME_ZONE): string {
  const p = parts(d, timeZone);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}
