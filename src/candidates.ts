/**
 * Every answer the document offers for a field — not just the one the model
 * chose.
 *
 * This is the part that catches the failure nobody catches by reading the
 * output. A contract says the notice period is thirty days in clause 11, and
 * sixty days in Schedule 2, because somebody amended one and not the other.
 * The model reads clause 11, records thirty, quotes it accurately, and is
 * confident. The citation checks out. The answer is still wrong, and the span
 * does not reveal it, because the problem is not in the span.
 *
 * So the code reads the document independently of the model and asks: did
 * anywhere else answer this field differently? That question has a definite
 * answer, which is why it belongs in a guard and not in a prompt.
 *
 * What it will NOT do is decide which one wins. Contracts set their own order
 * of precedence between the body and a schedule, and applying a hierarchy the
 * document did not state is interpretation — the thing this agent is built not
 * to do. A conflict is escalated, never resolved.
 */

import { parseDates } from './dates.js';
import { numberPositions } from './numbers.js';
import { sentences, type ExtractionDocument } from './document.js';
import type { FieldSpec } from './schema.js';

export type Candidate = {
  /** A number for number fields, an ISO date or the raw text for dates. */
  value: number | string;
  /** The unit word the document used, for number fields. */
  unit?: string;
  sentence: string;
  section: string;
};

/** How far back from a unit word a figure can sit and still belong to it. */
const REACH = 45;

/**
 * Figures that sit beside this field's unit.
 *
 * The nearest number BEFORE each unit word, and only that one. Taking every
 * number in the sentence turns "not less than thirty (30) days nor more than
 * ninety (90) days" into a conflict, when it is one provision with a range in
 * it. Taking the nearest to each unit gives thirty and ninety, each attached
 * to the word it qualifies.
 */
function numbersBesideUnit(sentence: string, unit: RegExp): Candidate[] {
  const out: Candidate[] = [];
  const positions = numberPositions(sentence);
  const re = new RegExp(unit.source, unit.flags.includes('g') ? unit.flags : unit.flags + 'g');

  for (const m of sentence.matchAll(re)) {
    const at = m.index;
    const near = positions
      .filter((p) => p.index < at && p.index >= at - REACH)
      .sort((a, b) => b.index - a.index)[0];
    if (near) out.push({ value: near.value, unit: m[0].toLowerCase(), sentence, section: '' });
  }
  return out;
}

/**
 * Every candidate value the document offers for a field.
 *
 * Returns nothing for text, list and boolean fields, and that is deliberate
 * rather than unfinished. Two sections describing a liability cap in different
 * words may be saying the same thing; two sections stating different numbers
 * of days are not. A conflict check that cannot tell those apart would fire on
 * every contract, and a guard that always fires gets switched off.
 */
export function candidates(doc: ExtractionDocument, spec: FieldSpec): Candidate[] {
  if (spec.kind !== 'number' && spec.kind !== 'date') return [];

  const out: Candidate[] = [];
  for (const s of sentences(doc)) {
    if (!spec.triggers.test(s.text)) continue;

    if (spec.kind === 'number') {
      if (!spec.unit) continue;
      for (const c of numbersBesideUnit(s.text, spec.unit)) {
        out.push({ ...c, section: s.section });
      }
    } else {
      for (const d of parseDates(s.text)) {
        out.push({ value: d.iso ?? d.raw, sentence: s.text, section: s.section });
      }
    }
  }
  return out;
}

/** The distinct values a field takes, grouped by the section that states them. */
export function bySection(list: Candidate[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const c of list) {
    const key = c.unit ? `${c.value} ${normaliseUnit(c.unit)}` : String(c.value);
    const set = map.get(c.section) ?? new Set<string>();
    set.add(key);
    map.set(c.section, set);
  }
  return map;
}

/** "days" and "day" are the same unit; "months" and "month" likewise. */
export const normaliseUnit = (unit: string): string =>
  unit.toLowerCase().replace(/s$/, '');

/** The unit part of a recorded key like "30 day", or null for a bare value. */
const unitOf = (key: string): string | null => {
  const m = /^(-?[\d.]+) (.+)$/.exec(key);
  return m ? m[2]! : null;
};

export type Disagreement = {
  section: string;
  says: string[];
  /**
   * `conflict` — the same unit, a different figure. Thirty days against sixty
   * days is a contradiction and nothing but a person can settle it.
   *
   * `other_unit` — the same field answered in a different unit. Thirty days
   * against one month might be a contradiction or might not, and finding out
   * means deciding how many days a month has. This agent refuses to convert
   * months to days when extracting a value, so it would be incoherent to do
   * that conversion here in order to accuse the model of an error. It is
   * reported rather than resolved, and it does not block.
   */
  kind: 'conflict' | 'other_unit';
};

/**
 * Sections that answer this field with something the recorded value is not
 * among.
 *
 * An empty set is skipped: a section mentioning notice without a figure is not
 * disagreeing, it is just prose.
 */
export function disagreeingSections(
  list: Candidate[],
  recorded: string,
): Disagreement[] {
  const recordedUnit = unitOf(recorded);
  const out: Disagreement[] = [];

  for (const [section, says] of bySection(list)) {
    if (!says.size || says.has(recorded)) continue;

    const sameUnit = [...says].filter((k) => unitOf(k) === recordedUnit);
    out.push(
      sameUnit.length
        ? { section, says: sameUnit, kind: 'conflict' }
        : { section, says: [...says], kind: 'other_unit' },
    );
  }
  return out;
}
