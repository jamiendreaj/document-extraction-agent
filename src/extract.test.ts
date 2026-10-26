/**
 * Tests for the extraction agent.
 *
 * The suite is organised around one claim: for extraction, the guardrails are
 * arithmetic rather than judgement. So most of these do not check that a
 * plausible answer came back — they construct a specific, realistic way of
 * being wrong and assert that it cannot get through.
 *
 * The one to read first is "the document answers twice and the agent picks
 * one". That is the failure this repository exists for, and it is the only one
 * here that no prompt and no amount of care about quotations can prevent.
 *
 * Everything runs offline against a scripted client.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fakeClient, emptyTurn } from 'grounded-agents/testing';
import type { ContentBlock } from 'grounded-agents';

import { extract } from './extract.js';
import { parseDocument, contains } from './document.js';
import { TOOLS, DELIBERATELY_ABSENT, runTool } from './tools.js';
import { ALL, GRAVE, unevidencedField } from './guards.js';
import * as guardModule from './guards.js';

const raw = readFileSync(new URL('../contracts/example-supply-agreement.txt', import.meta.url), 'utf8');
const doc = parseDocument('Verano / Northbrook MSA', raw);

/* ── spans, written as a reviewer would read them ─────────────────────── */

const SPAN = {
  // Written on one line although the document wraps them over three. If the
  // normalisation is wrong, every one of these stops verifying.
  notice30:
    'shall give the other party not less than thirty (30) days written notice before the end of the then current term.',
  notice60:
    'a party wishing to prevent renewal shall give not less than sixty (60) days written notice before the end of the then current term.',
  payment:
    'The Customer shall pay the Fees within forty-five (45) days of the date of each valid invoice.',
  law:
    'shall be governed by and construed in accordance with the laws of England and Wales.',
  effective: '"Effective Date" means 1 February 2027.',
  term: 'shall continue for an initial term of twenty-four (24) months',
  cap:
    'shall not exceed the aggregate Fees paid by the Customer in the twelve (12) months preceding the event giving rise to the claim.',
} as const;

const SECTION = {
  notice: '11. NOTICES AND NON-RENEWAL',
  schedule2: 'SCHEDULE 2 - OPERATIONAL PROVISIONS',
  payment: '3. FEES AND PAYMENT',
  law: '14. GOVERNING LAW',
  definitions: '1. DEFINITIONS',
  term: '2. TERM',
  liability: '9. LIMITATION OF LIABILITY',
} as const;

/* ── scripting ────────────────────────────────────────────────────────── */

type Call = { name: string; input: unknown };

/** One turn that calls several tools, the way the real model batches them. */
const calls = (...list: Call[]): { content: ContentBlock[] } => ({
  content: list.map((c, i) => ({
    type: 'tool_use' as const,
    id: `t${i}`,
    name: c.name,
    input: c.input,
  })),
});

const record = (field: string, extra: Record<string, unknown>): Call => ({
  name: 'record_field',
  input: { field, ...extra },
});

/** Run the agent against a script, with a closing note. */
const go = (...turns: ({ content: ContentBlock[] } | { text: string })[]) =>
  extract({ document: doc, client: fakeClient([...turns, { text: 'Recorded. See notes.' }]) });

/** The fields the agent must record to satisfy nothing_extracted. */
const aValidField = record('payment_terms', {
  value: '45', unit: 'days', span: SPAN.payment, section: SECTION.payment,
});

/* ── THE ONE THIS REPOSITORY IS FOR ──────────────────────────────────── */

test('the document answers twice and the agent picks one', async () => {
  // Clause 11 says thirty days. Schedule 2 says sixty. The agent reads clause
  // 11, records thirty, and quotes it exactly — everything it looked at is
  // right. The quotation verifies. Nothing about the span reveals the problem,
  // because the problem is in the part of the document it never read.
  const r = await go(calls(record('notice_period', {
    value: '30', unit: 'days', span: SPAN.notice30, section: SECTION.notice,
  })));

  assert.equal(r.sendable, false, 'a confident single answer to a contradicted field must not pass');
  assert.ok(r.guardrails.blocked.includes('silent_disambiguation'));
  // The sentence matters as much as the label. "Do not send" — the
  // framework's old hardcoded wording — is nonsense here: there is no reply
  // to withhold, only a table nobody should act on.
  assert.equal(
    r.blocked_because,
    'DO NOT USE — silent_disambiguation. The extraction is not usable as it stands and needs a person.',
  );
  // The finding has to name the other section, or nobody can act on it.
  assert.match(r.guardrails.issues.find((i) => i.rule === 'silent_disambiguation')!.detail, /SCHEDULE 2/);
  assert.match(r.guardrails.issues.find((i) => i.rule === 'silent_disambiguation')!.detail, /60 day/);
});

test('it fires whichever of the two the agent picks', async () => {
  // Not an artefact of clause order: recording the schedule's figure is
  // flagged against the body just as readily.
  const r = await go(calls(record('notice_period', {
    value: '60', unit: 'days', span: SPAN.notice60, section: SECTION.schedule2,
  })));
  assert.equal(r.sendable, false);
  assert.match(r.guardrails.issues.find((i) => i.rule === 'silent_disambiguation')!.detail, /11\. NOTICES/);
});

test('recording both candidates as ambiguous is the answer that passes', async () => {
  const r = await go(calls({
    name: 'record_ambiguous',
    input: {
      field: 'notice_period',
      note: 'Clause 11.1 and Schedule 2 give different periods and the Agreement states no order of precedence.',
      candidates: [
        { value: '30', unit: 'days', span: SPAN.notice30, section: SECTION.notice },
        { value: '60', unit: 'days', span: SPAN.notice60, section: SECTION.schedule2 },
      ],
    },
  }));

  assert.equal(r.sendable, true, 'the correct answer must actually be reachable');
  assert.equal(r.extraction.notice_period?.state, 'ambiguous');
});

/* ── evidence ─────────────────────────────────────────────────────────── */

test('a span that is not in the document is refused by the tool, in-run', async () => {
  // Refused where the model can still fix it, rather than at the end where
  // the whole extraction is already paid for.
  const r = await go(
    calls(record('governing_law', {
      value: 'England and Wales',
      span: 'This Agreement shall be governed by the laws of the Republic of Ireland.',
      section: SECTION.law,
    })),
    calls(aValidField),
  );

  assert.deepEqual(r.refused_fields, ['governing_law']);
  assert.equal(r.extraction.governing_law, undefined, 'nothing was stored');
  const refusal = r.tool_calls[0]!.output;
  assert.match(String(refusal.note), /not in the document/);
});

test('a real quotation with the wrong figure attached is blocked', async () => {
  // The citation is genuine. The number is not the one it says. This is the
  // miss a reviewer skimming a table of values and citations does not catch,
  // because checking it means reading every quotation against its own figure.
  const r = await go(calls(record('payment_terms', {
    value: '30', unit: 'days', span: SPAN.payment, section: SECTION.payment,
  })));

  assert.equal(r.sendable, false);
  assert.ok(r.guardrails.blocked.includes('value_not_in_span'));
  assert.match(r.guardrails.issues.find((i) => i.rule === 'value_not_in_span')!.detail, /records 30/);
});

test('a unit the span does not contain is blocked', async () => {
  // "two months" recorded as 60 days is the conversion the schema used to
  // invite by having `_days` in the field name.
  const r = await go(calls(record('notice_period', {
    value: '60', unit: 'months', span: SPAN.notice60, section: SECTION.schedule2,
  })));
  assert.equal(r.sendable, false);
  assert.match(r.guardrails.issues.find((i) => i.rule === 'value_not_in_span')!.detail, /unit "months"/);
});

test('a reworded text value is blocked, because a paraphrase is a new term', async () => {
  const r = await go(calls(record('governing_law', {
    value: 'English law', span: SPAN.law, section: SECTION.law,
  })));
  assert.equal(r.sendable, false);
  assert.match(r.guardrails.issues.find((i) => i.rule === 'value_not_in_span')!.detail, /reworded/);
});

test('the same field quoted faithfully passes', async () => {
  const r = await go(calls(record('governing_law', {
    value: 'England and Wales', span: SPAN.law, section: SECTION.law,
  })));
  assert.equal(r.sendable, true);
});

test('a party name the document does not contain is blocked', async () => {
  const r = await go(calls(
    {
      name: 'record_field',
      input: {
        field: 'parties',
        values: ['Verano Foods S.p.A.', 'Northbrook Analytics Limited'],
        span: 'between Verano Foods S.p.A., a company incorporated in Italy',
        section: 'MASTER SERVICES AGREEMENT',
      },
    },
  ));

  assert.equal(r.sendable, false);
  // "Limited" for "Ltd" is a different legal name, and it is exactly the kind
  // of tidy-up a model makes without noticing.
  assert.ok(r.guardrails.blocked.includes('invented_party'));
  assert.match(r.guardrails.issues.find((i) => i.rule === 'invented_party')!.detail, /Northbrook Analytics Limited/);
});

/* ── the three states ─────────────────────────────────────────────────── */

test('absent is a passing answer, and is not the same as a missing field', async () => {
  const r = await go(calls(
    { name: 'record_absent', input: { field: 'termination_for_convenience', note: 'No clause in sections 2, 11 or either schedule.' } },
    aValidField,
  ));

  assert.equal(r.sendable, true);
  assert.equal(r.extraction.termination_for_convenience?.state, 'absent');
  assert.equal(r.extraction.liability_cap, undefined, 'a field nobody looked at stays undefined');
});

test('nothing recorded at all is a failure, not an empty success', async () => {
  const r = await go({ text: 'I read the contract.' });
  assert.equal(r.sendable, false);
  assert.ok(r.guardrails.blocked.includes('nothing_extracted'));
});

test('a clean finish with no text is still judged on what was recorded', async () => {
  const r = await extract({
    document: doc,
    client: fakeClient([calls(aValidField), emptyTurn()]),
  });
  assert.equal(r.extraction.payment_terms?.state, 'found');
  assert.equal(r.sendable, false, 'the model never finished its note');
});

/* ── deletion, not annotation ─────────────────────────────────────────── */

test('a field that fails a check is deleted, not kept with a warning attached', async () => {
  const r = await go(calls(
    record('payment_terms', { value: '30', unit: 'days', span: SPAN.payment, section: SECTION.payment }),
    record('governing_law', { value: 'England and Wales', span: SPAN.law, section: SECTION.law }),
  ));

  assert.ok(r.removed.includes('payment_terms'), 'the bad one is gone');
  assert.equal(r.extraction.payment_terms, undefined);
  assert.equal(r.extraction.governing_law?.state, 'found', 'the good one survives');
});

/* ── dates ────────────────────────────────────────────────────────────── */

test('a date whose day and month order the document never settles is blocked', async () => {
  const d = parseDocument('ambiguous', [
    '1. TERM',
    '',
    '1.1 This Agreement takes effect on 03/04/2027 and continues for twelve (12) months.',
  ].join('\n'));

  const r = await extract({
    document: d,
    client: fakeClient([
      calls({
        name: 'record_field',
        input: {
          field: 'effective_date',
          value: '2027-04-03',
          span: 'This Agreement takes effect on 03/04/2027 and continues for twelve (12) months.',
          section: '1. TERM',
        },
      }),
      { text: 'Done.' },
    ]),
  });

  assert.equal(r.sendable, false);
  assert.ok(r.guardrails.blocked.includes('unresolvable_date'));
});

test('a date written with the month in letters passes', async () => {
  const r = await go(calls(record('effective_date', {
    value: '2027-02-01', span: SPAN.effective, section: SECTION.definitions,
  })));
  assert.equal(r.sendable, true);
});

test('the signature date is not the effective date, and the guard can tell them apart', async () => {
  // The contract carries both. Recording 14 January with the definitions span
  // fails because that span says 1 February.
  const r = await go(calls(record('effective_date', {
    value: '2027-01-14', span: SPAN.effective, section: SECTION.definitions,
  })));
  assert.equal(r.sendable, false);
  assert.match(
    r.guardrails.issues.find((i) => i.rule === 'value_not_in_span')!.detail,
    /its quotation states 2027-02-01/,
  );
});

/* ── what is reported but not blocked ─────────────────────────────────── */

test('a figure for the same field in another unit warns rather than blocks', async () => {
  // Clause 2.2 mentions renewal periods of twelve months in a sentence that
  // also says "notice". Deciding whether that contradicts thirty days means
  // deciding how many days a month has, which this agent refuses to do when
  // extracting — so it would be incoherent to do it in order to accuse the
  // model of an error.
  const r = await go(calls({
    name: 'record_ambiguous',
    input: {
      field: 'notice_period',
      note: 'Clause 11.1 and Schedule 2 disagree.',
      candidates: [
        { value: '30', unit: 'days', span: SPAN.notice30, section: SECTION.notice },
        { value: '60', unit: 'days', span: SPAN.notice60, section: SECTION.schedule2 },
      ],
    },
  }));
  assert.equal(r.sendable, true);

  const single = await go(calls(record('initial_term', {
    value: '24', unit: 'months', span: SPAN.term, section: SECTION.term,
  })));
  assert.equal(single.sendable, true, 'a range inside one section is one provision, not a conflict');
});

test('a cap stated as a formula is recorded as the formula, not as a number', async () => {
  const r = await go(calls(record('liability_cap', {
    value: 'the aggregate Fees paid by the Customer in the twelve (12) months preceding the event giving rise to the claim',
    span: SPAN.cap,
    section: SECTION.liability,
  })));
  assert.equal(r.sendable, true);
  assert.match(String(r.extraction.liability_cap && 'value' in r.extraction.liability_cap ? r.extraction.liability_cap.value : ''), /aggregate Fees/);
});

/* ── the tools ────────────────────────────────────────────────────────── */

test('there is no tool for summarising, interpreting or resolving a conflict', () => {
  // A tool the model can reach for is a tool it will eventually use, and none
  // of these three has a safe version.
  const names = TOOLS.map((t) => t.name) as readonly string[];
  for (const absent of DELIBERATELY_ABSENT) {
    assert.equal(names.includes(absent), false, `${absent} must not exist`);
  }
});

test('a field name outside the schema is refused and surfaced', async () => {
  const r = await go(
    calls(record('renewal_fee_increase', { value: '3', span: SPAN.payment, section: SECTION.payment })),
    calls(aValidField),
  );
  assert.deepEqual(r.refused_fields, ['renewal_fee_increase']);
  assert.equal(r.sendable, true, 'a refused field costs that call, not the run');
});

test('read_section on a heading that does not exist hands back the real headings', () => {
  const out = runTool(doc, {}, 'read_section', { heading: 'INDEMNITIES' }, {
    escalations: [], record: {}, notes: {},
  });
  assert.equal(out.known, false);
  assert.ok(Array.isArray(out.sections));
  assert.ok((out.sections as string[]).includes('14. GOVERNING LAW'));
});

test('search_document attributes every hit to a section', () => {
  const out = runTool(doc, {}, 'search_document', { phrase: 'written notice' }, {
    escalations: [], record: {}, notes: {},
  });
  const hits = out.hits as { section: string; sentence: string }[];
  assert.equal(hits.length, 2, 'both the clause and the schedule');
  assert.deepEqual(hits.map((h) => h.section).sort(), [SECTION.notice, SECTION.schedule2].sort());
});

test('escalation is recorded on the result', async () => {
  const r = await go(calls(
    { name: 'escalate_to_human', input: { reason: 'Clause 7 refers to Annexe C, which is not in the file.', fields: ['liability_cap'] } },
    aValidField,
  ));
  assert.equal(r.escalated, true);
  assert.match(String(r.escalations[0]!.reason), /Annexe C/);
});

/* ── the backstop, tested where it can actually be reached ────────────── */

/**
 * `record_field` refuses a span that is not in the document, so in normal
 * operation nothing unevidenced ever reaches the guards. That makes the guard
 * untestable through the agent — and an untested guard is the one that quietly
 * stops working.
 *
 * It is not redundant. It is the second lock: it holds if a tool is changed to
 * trust its input, if a field is written to the record by some future path
 * that does not go through a tool, or if the two checks drift apart. So it is
 * tested directly, with a record built by hand.
 */
const ctxWith = (record: Record<string, unknown>) => ({
  toolResults: [],
  document: doc,
  config: {},
  expectLanguage: null,
  state: { escalations: [], record, notes: {} },
});

test('the evidence guard blocks a fabricated span when called directly', () => {
  const issue = unevidencedField()('', ctxWith({
    governing_law: {
      state: 'found',
      value: 'England and Wales',
      span: 'This Agreement shall be governed by the laws of the Republic of Ireland.',
      section: SECTION.law,
    },
  }) as never);

  assert.ok(issue, 'a span the document does not contain must fail');
  const one = Array.isArray(issue) ? issue[0]! : issue;
  assert.equal(one.severity, 'block');
  assert.match(one.detail, /governing_law/);
  assert.match(one.detail, /not in the document/);
});

test('it checks every candidate of an ambiguous field, not just the first', () => {
  const issue = unevidencedField()('', ctxWith({
    notice_period: {
      state: 'ambiguous',
      note: 'two clauses',
      candidates: [
        { value: '30', unit: 'days', span: SPAN.notice30, section: SECTION.notice },
        { value: '45', unit: 'days', span: 'not less than forty-five (45) days written notice shall be given', section: SECTION.schedule2 },
      ],
    },
  }) as never);

  assert.ok(issue, 'a fabricated second candidate must fail even though the first is real');
  const one = Array.isArray(issue) ? issue[0]! : issue;
  assert.match(one.detail, /candidate/);
});

test('the tool and the guard agree, because they call the same check', () => {
  // If these ever diverge, a span can pass one and fail the other for a reason
  // nobody can see from the output.
  const real = SPAN.notice30;
  const fake = 'not less than forty-five (45) days written notice shall be given';

  assert.equal(contains(doc, real), true);
  assert.equal(contains(doc, fake), false);

  const state = { escalations: [], record: {}, notes: {} };
  const accepted = runTool(doc, {}, 'record_field',
    { field: 'notice_period', value: '30', unit: 'days', span: real, section: SECTION.notice }, state);
  const rejected = runTool(doc, {}, 'record_field',
    { field: 'notice_period', value: '45', unit: 'days', span: fake, section: SECTION.schedule2 }, state);

  assert.equal(accepted.known, true);
  assert.equal(rejected.known, false);
});

test('every guard that exists is wired into the agent', () => {
  // The failure this catches: a guard that works perfectly and is not in the
  // list. Nothing else in the suite notices, because the guard passes its own
  // direct test and the pipeline simply never calls it.
  const wired = new Set(ALL.map((g) => g.ruleName));
  const defined = Object.entries(guardModule)
    .filter(([name, v]) => typeof v === 'function' && name !== 'normaliseContains')
    .map(([, make]) => (make as () => { ruleName?: string })().ruleName);

  for (const name of defined) {
    assert.ok(name, 'every guard names itself');
    assert.ok(wired.has(name), `${name} is defined but never runs`);
  }
});

test('the grave list names rules that exist', () => {
  // A typo here is silent: the rule still blocks, but it is reported as an
  // ordinary mistake rather than a false output.
  const wired = new Set(ALL.map((g) => g.ruleName));
  for (const name of GRAVE) assert.ok(wired.has(name), `${name} is marked grave but is not a rule`);
});

test('a date in the document own wording is not accepted as the value', async () => {
  // The first live run returned "1 February 2027" where every scripted run
  // had returned "2027-02-01", and both passed. One field, two formats,
  // depending on which phrasing the model copied.
  const r = await go(calls(record('effective_date', {
    value: '1 February 2027', span: SPAN.effective, section: SECTION.definitions,
  })));

  assert.equal(r.sendable, false);
  assert.match(
    r.guardrails.issues.find((i) => i.rule === 'value_not_in_span')!.detail,
    /dates are recorded as YYYY-MM-DD/,
  );
  assert.equal(r.extraction.effective_date, undefined, 'and it is removed, not reformatted');
});
