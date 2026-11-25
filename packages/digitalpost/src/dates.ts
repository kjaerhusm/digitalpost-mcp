/**
 * Heuristic Danish dates from letter text. Not a confirmed calendar entry.
 * `replyBy` from the gateway is copied through with heuristic: false.
 */

export type DateKind = 'deadline' | 'appointment' | 'date';
export type DateSource = 'subject' | 'pdf' | 'replyBy';

export interface DetectedDate {
  kind: DateKind;
  /** Calendar date as YYYY-MM-DD. Clock times are as written, not converted. */
  date: string;
  time: string | null;
  place: string | null;
  source: DateSource;
  snippet: string;
  heuristic: boolean;
}

const MONTHS: Record<string, number> = {
  januar: 1,
  jan: 1,
  februar: 2,
  feb: 2,
  marts: 3,
  mar: 3,
  april: 4,
  apr: 4,
  maj: 5,
  juni: 6,
  jun: 6,
  juli: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  oktober: 10,
  okt: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const DATE_NUMERIC = /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?!\d)/g;
const DATE_MONTH =
  /(?<!\d)(\d{1,2})\.?\s+(januar|jan|februar|feb|marts|mar|april|apr|maj|juni|jun|juli|jul|august|aug|september|sept|sep|oktober|okt|november|nov|december|dec)\.?(?:\s+(\d{4}))?/gi;
const TIME = /kl(?:okken)?\.?\s*(\d{1,2})[:.](\d{2})/i;
const DEADLINE = /senest|frist|inden|svar|betal/i;
const APPOINTMENT =
  /møde|undersøgelse|indkaldelse|konsultation|aftale|fremmøde|sygehus|hospital|ambulatorium|tid hos/i;
const PLACE_STED = /\bsted:?\s+([^\n,]{3,80})/i;
const PLACE_ADRESSE = /\badresse:?\s+([^\n]{3,120})/i;
const PLACE_PAA = /\bpå\s+([A-ZÆØÅ0-9][^,.\n]{2,80})/;

export const DATES_NOTE =
  'Dates, times, and places are heuristics from letter text unless source is replyBy. Confirm them before adding a calendar event.';

export function detectDatesInText(
  text: string,
  source: 'subject' | 'pdf',
  receivedAt: string | null,
): DetectedDate[] {
  const found: DetectedDate[] = [];
  for (const match of text.matchAll(DATE_NUMERIC)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = expandYear(Number(match[3]));
    pushDate(found, text, match.index ?? 0, match[0].length, year, month, day, source);
  }
  for (const match of text.matchAll(DATE_MONTH)) {
    const day = Number(match[1]);
    const month = MONTHS[(match[2] ?? '').toLowerCase()];
    if (!month) continue;
    const year = match[3] ? Number(match[3]) : inferYear(month, day, receivedAt);
    pushDate(found, text, match.index ?? 0, match[0].length, year, month, day, source);
  }
  return dedupe(found);
}

export function datesFromLetter(input: {
  subject: string | null;
  receivedAt: string | null;
  replyBy: string | null;
  pdfText?: string | null;
}): DetectedDate[] {
  const dates = detectDatesInText(input.subject ?? '', 'subject', input.receivedAt);
  if (input.pdfText) dates.push(...detectDatesInText(input.pdfText, 'pdf', input.receivedAt));
  const official = replyByDate(input.replyBy);
  if (official) dates.push(official);
  return dedupe(dates);
}

function pushDate(
  found: DetectedDate[],
  text: string,
  index: number,
  length: number,
  year: number,
  month: number,
  day: number,
  source: 'subject' | 'pdf',
): void {
  if (!validDate(year, month, day)) return;
  const windowStart = Math.max(0, index - 80);
  const window = text.slice(windowStart, index + length + 80);
  const after = text.slice(index, index + length + 120);
  const around = text.slice(Math.max(0, index - 40), index + length + 50);
  const time = clockTime(around);
  const appointment = APPOINTMENT.test(window);
  const deadline = DEADLINE.test(window);
  const kind: DateKind = appointment ? 'appointment' : deadline ? 'deadline' : 'date';
  found.push({
    kind,
    date: isoDate(year, month, day),
    time,
    place: placeFrom(after),
    source,
    snippet: text
      .slice(Math.max(0, index - 30), index + length + 50)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160),
    heuristic: true,
  });
}

/** Calendar day in Denmark. UTC midnight on the previous date is still this day in summer time. */
function copenhagenParts(ms: number): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
} {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    formatted.find((item) => item.type === type)?.value ?? '';
  const hour = part('hour') === '24' ? '00' : part('hour');
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour,
    minute: part('minute'),
  };
}

function replyByDate(value: string | null): DetectedDate | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const parts = copenhagenParts(parsed);
  const clock =
    parts.hour === '00' && parts.minute === '00' ? null : `${parts.hour}:${parts.minute}`;
  return {
    kind: 'deadline',
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: clock,
    place: null,
    source: 'replyBy',
    snippet: 'replyBy from the gateway',
    heuristic: false,
  };
}

function clockTime(window: string): string | null {
  const match = TIME.exec(window);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function placeFrom(window: string): string | null {
  const match = PLACE_STED.exec(window) ?? PLACE_ADRESSE.exec(window) ?? PLACE_PAA.exec(window);
  if (!match?.[1]) return null;
  const place = match[1]
    .replace(/\s+/g, ' ')
    .replace(/[.;:]+$/, '')
    .trim();
  return place.slice(0, 80) || null;
}

function inferYear(month: number, day: number, receivedAt: string | null): number {
  const received = receivedAt ? new Date(receivedAt) : new Date();
  const base = Number.isNaN(received.getTime()) ? new Date() : received;
  const year = base.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  const receivedDay = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  if (candidate + 24 * 60 * 60 * 1000 < receivedDay) return year + 1;
  return year;
}

function expandYear(year: number): number {
  if (year >= 100) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dedupe(dates: DetectedDate[]): DetectedDate[] {
  const seen = new Set<string>();
  const out: DetectedDate[] = [];
  for (const date of dates) {
    const key = `${date.source}|${date.kind}|${date.date}|${date.time ?? ''}|${date.place ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(date);
  }
  return out;
}
