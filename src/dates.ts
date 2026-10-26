/**
 * Dates, and the one that cannot be read at all.
 *
 * "03/04/2027" is the third of April in London and the fourth of March in
 * Chicago. Nothing in the document settles it, and an extraction agent that
 * picks one has invented a fact with a month of error in it — on a notice
 * window, that is the difference between serving in time and missing it.
 *
 * So a numeric date whose first two parts are both twelve or under is returned
 * as ambiguous, and the guardrails refuse to let it through as a found value.
 * A month written in letters is never ambiguous, which is why contracts that
 * care write them that way.
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

export type DateCandidate = {
  /** The text as the document wrote it. */
  raw: string;
  /** ISO form, or null when the date cannot be resolved without guessing. */
  iso: string | null;
  /** True when day and month order is genuinely undecidable from the document. */
  ambiguous: boolean;
};

const iso = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const made = new Date(Date.UTC(y, m - 1, d));
  // Rejects 31 February rather than rolling it into March.
  if (made.getUTCMonth() !== m - 1 || made.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

export function parseDates(text: string): DateCandidate[] {
  const out: DateCandidate[] = [];
  const monthNames = Object.keys(MONTHS).join('|');

  // 1 January 2027 · 1st January, 2027
  for (const m of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\.?,?\\s+(\\d{4})\\b`, 'gi'),
  )) {
    out.push({ raw: m[0], iso: iso(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!), ambiguous: false });
  }

  // January 1, 2027 · Jan 1 2027
  for (const m of text.matchAll(
    new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'),
  )) {
    out.push({ raw: m[0], iso: iso(+m[3]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!), ambiguous: false });
  }

  // 2027-01-15 — unambiguous by construction.
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    out.push({ raw: m[0], iso: iso(+m[1]!, +m[2]!, +m[3]!), ambiguous: false });
  }

  // 03/04/2027 — the dangerous one.
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) {
    const [a, b, y] = [+m[1]!, +m[2]!, +m[3]!];
    if (a <= 12 && b <= 12 && a !== b) {
      // Could be either order, and the document does not say which.
      out.push({ raw: m[0], iso: null, ambiguous: true });
    } else if (a > 12) {
      out.push({ raw: m[0], iso: iso(y, b, a), ambiguous: false }); // day first
    } else if (b > 12) {
      out.push({ raw: m[0], iso: iso(y, a, b), ambiguous: false }); // month first
    } else {
      // a === b, so the order does not matter.
      out.push({ raw: m[0], iso: iso(y, a, b), ambiguous: false });
    }
  }

  return out;
}
