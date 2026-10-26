/**
 * Numbers as contracts actually write them.
 *
 * "The Customer shall give not less than thirty (30) days' notice." Both forms
 * appear, usually together, and sometimes they disagree — a drafting error
 * where the digits say 30 and the words say sixty is a real and expensive
 * thing, so both have to be read rather than one being treated as decoration.
 *
 * This exists because the check that a recorded value really appears in its
 * own quoted span is worthless if it can only see digits. A model that records
 * `notice_period_days: 30` against a span reading "sixty (60) days" has
 * attached a correct-looking citation to a wrong value, and that is exactly
 * the mistake nobody catches by reading the output.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

const SCALE: Record<string, number> = { hundred: 100, thousand: 1000 };

export type Positioned = { value: number; index: number };

/**
 * Written-out numbers, with where each one starts.
 *
 * The position is not a nicety. A value only counts for a field if it sits
 * beside that field's unit — "thirty (30) days" is a notice period, "clause
 * 11.2" is a cross-reference — and without offsets there is no way to ask
 * which number was nearest the word "days".
 */
export function spelledPositions(text: string): Positioned[] {
  const out: Positioned[] = [];
  const tokens = [...text.toLowerCase().matchAll(/[a-z]+/g)].map((m) => ({
    word: m[0],
    index: m.index,
  }));

  let total = 0;       // completed scale groups, e.g. the 1000 of "one thousand two hundred"
  let current = 0;     // the group being built
  let startedAt = -1;  // where the open number began

  const close = () => {
    if (startedAt >= 0) out.push({ value: total + current, index: startedAt });
    total = 0;
    current = 0;
    startedAt = -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const { word, index } = tokens[i]!;
    const open = startedAt >= 0;

    if (word in UNITS) { if (!open) startedAt = index; current += UNITS[word]!; continue; }
    if (word in TENS) { if (!open) startedAt = index; current += TENS[word]!; continue; }

    if (word in SCALE) {
      if (!open) startedAt = index;
      // "hundred" with nothing before it still means one hundred.
      const factor = SCALE[word]!;
      if (factor === 100) current = (current || 1) * 100;
      else { total += (current || 1) * factor; current = 0; }
      continue;
    }

    // "and" continues a number only when one is open AND a number word
    // follows. "thirty days and the fee" must not become 30-and-something.
    if ((word === 'and' || word === 'a') && open) {
      const next = tokens[i + 1]?.word;
      if (next && (next in UNITS || next in TENS || next in SCALE)) continue;
    }

    close();
  }
  close();
  return out;
}

/** Written-out numbers in a piece of text, in the order they appear. */
export const spelledNumbers = (text: string): number[] =>
  spelledPositions(text).map((p) => p.value);

/** Digits, with where each one starts, reading European and Anglo grouping. */
export function digitPositions(text: string): Positioned[] {
  const out: Positioned[] = [];
  // A number, optionally with grouped thousands and a decimal part.
  for (const m of text.matchAll(/\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?/g)) {
    const raw = m[0];
    let n: number;

    if (/[.,]\d{1,2}$/.test(raw) && /[.,]\d{3}/.test(raw)) {
      // Both a group separator and a decimal: the LAST separator is the decimal.
      const cut = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
      n = Number(raw.slice(0, cut).replace(/[.,]/g, '') + '.' + raw.slice(cut + 1));
    } else if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) {
      // Pure grouping: 1.234 and 1,234 are both one thousand two hundred.
      n = Number(raw.replace(/[.,]/g, ''));
    } else if (/[.,]\d{1,2}$/.test(raw)) {
      n = Number(raw.replace(',', '.'));
    } else {
      n = Number(raw.replace(/[.,]/g, ''));
    }

    if (Number.isFinite(n)) out.push({ value: n, index: m.index });
  }
  return out;
}

/** Digits in a piece of text, reading European and Anglo thousands separators. */
export const digitNumbers = (text: string): number[] =>
  digitPositions(text).map((p) => p.value);

/** Every number in a piece of text, however it was written, with positions. */
export const numberPositions = (text: string): Positioned[] =>
  [...digitPositions(text), ...spelledPositions(text)].sort((a, b) => a.index - b.index);

/** Every number in a piece of text, however it was written. */
export function allNumbers(text: string): Set<number> {
  return new Set(numberPositions(text).map((p) => p.value));
}
