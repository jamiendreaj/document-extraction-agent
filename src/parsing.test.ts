/**
 * Tests for the reading, which is where this agent is most easily wrong in a
 * way nobody notices.
 *
 * None of this involves a model. It is the normalisation that decides whether
 * an honest quotation verifies, the number parsing that decides whether a
 * figure counts as evidence, and the date handling that decides whether a
 * contract's commencement date is knowable at all. Every one of them fails
 * silently when it fails: a wrong answer, never an error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseDocument, contains, normalise, sectionOf, sectionBody, search } from './document.js';
import { allNumbers, spelledNumbers, digitNumbers, numberPositions } from './numbers.js';
import { parseDates } from './dates.js';
import { candidates, disagreeingSections } from './candidates.js';
import { fieldSpec } from './schema.js';

const raw = readFileSync(new URL('../contracts/example-supply-agreement.txt', import.meta.url), 'utf8');
const doc = parseDocument('Verano / Northbrook MSA', raw);

/* ── normalisation ────────────────────────────────────────────────────── */

test('a quotation that collapses the document line breaks still verifies', () => {
  // The clause runs over three lines in the file. Nobody retypes it that way,
  // and a raw substring check would reject every honest citation on a PDF.
  assert.equal(
    contains(doc, 'shall give the other party not less than thirty (30) days written notice'),
    true,
  );
});

test('curly quotes, en dashes and non-breaking spaces do not break a citation', () => {
  const d = parseDocument('x', 'The "Term" means twenty-four (24) months from the Effective Date.');
  assert.equal(contains(d, 'The “Term” means twenty–24 (24) months'), false, 'the WORDS still have to match');
  assert.equal(contains(d, 'The “Term” means twenty-four (24) months'), true);
  assert.equal(contains(d, 'The "Term" means twenty-four (24) months'), true);
});

test('case is not evidence, and that is a deliberate concession', () => {
  // All-caps clauses are everywhere in contracts and never quoted faithfully.
  const d = parseDocument('x', 'THE SUPPLIER SHALL NOT BE LIABLE FOR INDIRECT LOSS OF ANY KIND.');
  assert.equal(contains(d, 'The Supplier shall not be liable for indirect loss'), true);
});

test('a span too short to be a citation is never evidence', () => {
  // "days" appears in the document. It is not evidence of a notice period.
  assert.equal(contains(doc, 'days'), false);
  assert.equal(contains(doc, '(30) days'), false, 'still too short to locate a provision');
  assert.equal(sectionOf(doc, 'days'), null);
});

/* ── structure ────────────────────────────────────────────────────────── */

test('a numbered clause ending in a full stop is not a heading', () => {
  // This cost the conflict check its section boundaries once: every short
  // numbered clause became its own section, so no two values ever shared one.
  const headings = doc.sections.map((s) => s.heading);
  assert.ok(headings.includes('1. DEFINITIONS'));
  assert.equal(headings.some((h) => h.startsWith('1.1 ')), false);
  assert.equal(headings.some((h) => h.includes('means 1 February')), false);
});

test('schedules are sections, because that is where the second answer lives', () => {
  const headings = doc.sections.map((s) => s.heading);
  assert.ok(headings.includes('SCHEDULE 2 - OPERATIONAL PROVISIONS'));
  assert.match(sectionBody(doc, 'SCHEDULE 2')!, /sixty \(60\) days/);
});

test('a span is attributed to the section it is actually in', () => {
  assert.equal(
    sectionOf(doc, 'not less than sixty (60) days written notice'),
    'SCHEDULE 2 - OPERATIONAL PROVISIONS',
  );
  assert.equal(
    sectionOf(doc, 'not less than thirty (30) days written notice'),
    '11. NOTICES AND NON-RENEWAL',
  );
});

test('search finds both places the document speaks to notice', () => {
  const hits = search(doc, 'written notice');
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0]!.section, hits[1]!.section);
});

/* ── numbers ──────────────────────────────────────────────────────────── */

test('contracts write figures twice and both forms are read', () => {
  assert.deepEqual([...allNumbers('thirty (30) days')], [30]);
  assert.deepEqual(spelledNumbers('not less than sixty (60) days'), [60]);
  assert.deepEqual(spelledNumbers('one hundred and twenty (120) days'), [120]);
  assert.deepEqual(spelledNumbers('thirty-five'), [35]);
  assert.deepEqual(spelledNumbers('two thousand five hundred euro'), [2500]);
});

test('"and" only continues a number when a number follows it', () => {
  // "thirty days and the fee shall be paid" must be thirty, not thirty-and-something.
  assert.deepEqual(spelledNumbers('thirty days and the fee shall be paid'), [30]);
  assert.deepEqual(spelledNumbers('one hundred and twenty days'), [120]);
});

test('European and Anglo thousands separators both read correctly', () => {
  // Silent when wrong: EUR 1.234,56 read as 1.23 authorises a figure the
  // document never contained.
  assert.deepEqual(digitNumbers('EUR 1.234,56'), [1234.56]);
  assert.deepEqual(digitNumbers('USD 1,234.56'), [1234.56]);
  assert.deepEqual(digitNumbers('EUR 250.000,00'), [250000]);
  assert.deepEqual(digitNumbers('EUR 4.500,00 per month'), [4500]);
});

test('positions are kept, because a figure only counts beside its unit', () => {
  const p = numberPositions('not less than thirty (30) days nor more than ninety (90) days');
  assert.deepEqual(p.map((x) => x.value), [30, 30, 90, 90]);
  assert.ok(p[0]!.index < p[2]!.index);
});

/* ── candidates ───────────────────────────────────────────────────────── */

test('a clause cross-reference is not a candidate value', () => {
  // "in accordance with clause 11" contains the number 11. Without the
  // unit-adjacency rule, every cross-reference in a contract becomes a
  // possible notice period and the conflict check fires on everything.
  const d = parseDocument('x', [
    '11. NOTICES',
    '',
    '11.1 Notice of non-renewal shall be given in accordance with clause 2.2 and clause 14 not',
    'less than thirty (30) days before the end of the then current term.',
  ].join('\n'));

  // The sentence contains 2.2, 14 and 30. Only 30 sits beside "days".
  const found = candidates(d, fieldSpec('notice_period')!);
  assert.deepEqual(found.map((c) => `${c.value} ${c.unit}`), ['30 days']);
  assert.deepEqual(disagreeingSections(found, '30 day'), []);
});

test('a range inside one provision is not a disagreement', () => {
  const d = parseDocument('x', [
    '11. NOTICES',
    '',
    '11.1 A party shall give not less than thirty (30) days nor more than ninety (90) days notice.',
  ].join('\n'));
  const found = candidates(d, fieldSpec('notice_period')!);
  assert.deepEqual(disagreeingSections(found, '30 day'), [], 'one section, one provision');
});

test('two sections giving different figures in the same unit is a conflict', () => {
  const found = candidates(doc, fieldSpec('notice_period')!);
  const against30 = disagreeingSections(found, '30 day');
  const conflict = against30.find((d) => d.kind === 'conflict');
  assert.ok(conflict, 'the schedule disagrees with the clause');
  assert.equal(conflict!.section, 'SCHEDULE 2 - OPERATIONAL PROVISIONS');
  assert.deepEqual(conflict!.says, ['60 day']);
});

test('a figure in a different unit is reported separately, not as a conflict', () => {
  const found = candidates(doc, fieldSpec('notice_period')!);
  const other = disagreeingSections(found, '30 day').filter((d) => d.kind === 'other_unit');
  assert.equal(other.length, 1);
  assert.deepEqual(other[0]!.says, ['12 month']);
});

test('a text, list or boolean field yields no candidates, deliberately', () => {
  // Two clauses describing a liability cap in different words may be saying
  // the same thing. A conflict check that cannot tell gets switched off.
  for (const name of ['liability_cap', 'parties', 'auto_renews'] as const) {
    assert.deepEqual(candidates(doc, fieldSpec(name)!), [], name);
  }
});

/* ── dates ────────────────────────────────────────────────────────────── */

test('a month in letters is never ambiguous', () => {
  assert.deepEqual(parseDates('dated 1 January 2027'), [{ raw: '1 January 2027', iso: '2027-01-01', ambiguous: false }]);
  assert.deepEqual(parseDates('on January 15, 2027'), [{ raw: 'January 15, 2027', iso: '2027-01-15', ambiguous: false }]);
  assert.deepEqual(parseDates('effective 2027-03-09'), [{ raw: '2027-03-09', iso: '2027-03-09', ambiguous: false }]);
});

test('03/04/2027 cannot be read, and says so instead of guessing', () => {
  const [d] = parseDates('commencing 03/04/2027');
  assert.equal(d!.ambiguous, true);
  assert.equal(d!.iso, null);
});

test('a numeric date is readable when one part cannot be a month', () => {
  assert.equal(parseDates('25/12/2027')[0]!.iso, '2027-12-25');
  assert.equal(parseDates('12/25/2027')[0]!.iso, '2027-12-25');
  assert.equal(parseDates('07/07/2027')[0]!.iso, '2027-07-07', 'order does not matter when both are equal');
});

test('an impossible date does not roll forward into the next month', () => {
  // new Date(2027, 1, 31) is 3 March. Accepting that would invent a date the
  // document does not contain.
  assert.equal(parseDates('the 31st February 2027')[0]!.iso, null);
  assert.equal(parseDates('2027-02-30')[0]!.iso, null);
});

test('normalise is the same function everywhere it matters', () => {
  assert.equal(normalise('  The  "Term" — twelve (12)  months '), 'the "term" - twelve (12) months');
});
