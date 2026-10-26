/**
 * A complete extraction, scripted.
 *
 * This exists so the output in the README is output the code produced rather
 * than output I typed into the README. It is also the fixture the report tests
 * run against, so the sample and the assertions can never drift.
 *
 * The scripted turns are what a careful run looks like: the schedule searched
 * as well as the clause, the contradiction recorded as ambiguous rather than
 * resolved, a cap left as the formula the contract wrote, one field genuinely
 * absent, and one escalation.
 */

import { readFileSync } from 'node:fs';

import { fakeClient } from 'grounded-agents/testing';
import type { ContentBlock } from 'grounded-agents';

import { parseDocument } from './document.js';
import { extract, type ExtractionResult } from './extract.js';

export const sampleDocument = () =>
  parseDocument(
    'Verano / Northbrook MSA',
    readFileSync(new URL('../contracts/example-supply-agreement.txt', import.meta.url), 'utf8'),
  );

const turn = (...list: { name: string; input: unknown }[]): { content: ContentBlock[] } => ({
  content: list.map((c, i) => ({ type: 'tool_use' as const, id: `t${i}`, name: c.name, input: c.input })),
});

export function sampleRun(): Promise<ExtractionResult> {
  const doc = sampleDocument();

  return extract({
    document: doc,
    client: fakeClient([
      turn({ name: 'list_sections', input: {} }),
      turn(
        { name: 'search_document', input: { phrase: 'written notice' } },
        { name: 'read_section', input: { heading: '2. TERM' } },
      ),
      turn(
        {
          name: 'record_field',
          input: {
            field: 'parties',
            values: ['Verano Foods S.p.A.', 'Northbrook Analytics Ltd'],
            span: 'This Agreement is made between Verano Foods S.p.A., a company incorporated in Italy',
            section: 'MASTER SERVICES AGREEMENT',
          },
        },
        {
          name: 'record_field',
          input: {
            field: 'effective_date',
            value: '2027-02-01',
            span: '"Effective Date" means 1 February 2027.',
            section: '1. DEFINITIONS',
          },
        },
        {
          name: 'record_field',
          input: {
            field: 'initial_term',
            value: '24',
            unit: 'months',
            span: 'shall continue for an initial term of twenty-four (24) months',
            section: '2. TERM',
          },
        },
        {
          name: 'record_field',
          input: {
            field: 'auto_renews',
            value: 'true',
            span: 'this Agreement shall automatically renew for successive periods of twelve (12) months each',
            section: '2. TERM',
          },
        },
      ),
      turn(
        {
          // The contradiction, recorded rather than resolved.
          name: 'record_ambiguous',
          input: {
            field: 'notice_period',
            note: 'Clause 11.1 and Schedule 2 give different periods and the Agreement states no order of precedence between them.',
            candidates: [
              {
                value: '30',
                unit: 'days',
                span: 'shall give the other party not less than thirty (30) days written notice before the end of the then current term.',
                section: '11. NOTICES AND NON-RENEWAL',
              },
              {
                value: '60',
                unit: 'days',
                span: 'a party wishing to prevent renewal shall give not less than sixty (60) days written notice before the end of the then current term.',
                section: 'SCHEDULE 2 - OPERATIONAL PROVISIONS',
              },
            ],
          },
        },
        {
          name: 'record_field',
          input: {
            field: 'payment_terms',
            value: '45',
            unit: 'days',
            span: 'The Customer shall pay the Fees within forty-five (45) days of the date of each valid invoice.',
            section: '3. FEES AND PAYMENT',
          },
        },
        {
          // A cap that is a formula stays a formula.
          name: 'record_field',
          input: {
            field: 'liability_cap',
            value: 'the aggregate Fees paid by the Customer in the twelve (12) months preceding the event giving rise to the claim',
            span: 'shall not exceed the aggregate Fees paid by the Customer in the twelve (12) months preceding the event giving rise to the claim.',
            section: '9. LIMITATION OF LIABILITY',
          },
        },
        {
          name: 'record_field',
          input: {
            field: 'governing_law',
            value: 'England and Wales',
            span: 'shall be governed by and construed in accordance with the laws of England and Wales.',
            section: '14. GOVERNING LAW',
          },
        },
        {
          name: 'record_absent',
          input: {
            field: 'termination_for_convenience',
            note: 'No such right in clause 2, clause 11 or either schedule.',
          },
        },
      ),
      {
        text:
          'Recorded. The notice period is ambiguous: clause 11.1 says thirty days, ' +
          'Schedule 2 says sixty, and the Agreement contains no order of precedence, ' +
          'so a person needs to decide which governs. No termination-for-convenience ' +
          'right exists. The liability cap is a formula and is recorded as written.',
      },
    ]),
  });
}
