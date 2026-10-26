/**
 * Tests for the report.
 *
 * The three states are the product of this agent, and printing is where they
 * get flattened. A report that renders `absent` and "nobody looked" the same
 * way has thrown away the distinction the whole design exists to keep.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sampleRun } from './sample.js';
import { report } from './report.js';

const run = await sampleRun();
const text = report(run);
/** Whitespace-collapsed, because quotations wrap across lines. */
const flat = text.replace(/\s+/g, ' ');

test('a careful extraction of a contradictory contract is usable', () => {
  assert.equal(run.sendable, true);
  assert.equal(run.removed.length, 0);
  assert.match(text, /^USABLE/m);
});

test('absent and "not examined" are printed differently', () => {
  // The document being silent, and nobody having looked, are opposite facts.
  assert.match(text, /termination_for_convenience\s+absent — No such right/);
  assert.equal(/termination_for_convenience\s+not examined/.test(text), false);
});

test('an ambiguous field prints every candidate with its own section and words', () => {
  assert.match(text, /notice_period\s+AMBIGUOUS/);
  assert.match(text, /• 30 days\s+\[11\. NOTICES AND NON-RENEWAL\]/);
  assert.match(text, /• 60 days\s+\[SCHEDULE 2 - OPERATIONAL PROVISIONS\]/);
  assert.match(flat, /thirty \(30\) days written notice/);
  assert.match(flat, /sixty \(60\) days written notice/);
});

test('no quotation is ever truncated', () => {
  // The span is the contract's words, not the agent's. Shortening it to make
  // a table line up turns the evidence back into a summary.
  for (const f of Object.values(run.extraction)) {
    if (!f) continue;
    const spans = f.state === 'found' ? [f.span] : f.state === 'ambiguous' ? f.candidates.map((c) => c.span) : [];
    for (const span of spans) {
      assert.ok(flat.includes(span.replace(/\s+/g, ' ').trim()), `truncated: ${span.slice(0, 40)}…`);
    }
  }
});

test('every found field prints the words it came from', () => {
  for (const line of ['England and Wales', '45 days', '24 months', 'Verano Foods S.p.A.']) {
    assert.ok(text.includes(line), `${line} is missing from the report`);
  }
  assert.match(text, /"shall be governed by and construed in accordance with the laws of England and Wales\."/);
});

test('a cap expressed as a formula is reported as the formula', () => {
  assert.match(text, /liability_cap\s+the aggregate Fees paid/);
  assert.equal(/liability_cap\s+\d/.test(text), false, 'no figure was invented for it');
});

test('a removed field says so rather than disappearing', async () => {
  const r = await sampleRun();
  // Deleted the way extract() deletes it, rather than set to undefined —
  // which exactOptionalPropertyTypes rightly refuses, because an absent key
  // and a key holding undefined are not the same thing.
  delete r.extraction.payment_terms;
  r.removed.push('payment_terms');
  assert.match(report(r), /payment_terms\s+REMOVED — evidence did not check out/);
});
