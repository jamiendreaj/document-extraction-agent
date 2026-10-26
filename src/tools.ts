/**
 * The tools, and the three that deliberately do not exist.
 *
 * Two ideas run through this file.
 *
 * The first is that the model should FIND values rather than recall them.
 * `search_document` returns real sentences with the section they came from, so
 * quoting is a matter of copying something it has in front of it. An agent
 * asked to produce a quotation it never retrieved will produce one anyway.
 *
 * The second is that `record_field` refuses a span that is not in the document
 * at the moment it is called, rather than letting the guardrails catch it at
 * the end. Both checks are the same arithmetic; the difference is that a tool
 * error comes back as a tool result and the model gets to correct itself
 * inside the run, while a guard failure arrives after everything is spent and
 * costs the whole extraction.
 */

import type { ToolDefinition, ToolInput, AgentState, ToolResult } from 'grounded-agents';

import {
  contains,
  sectionBody,
  search,
  type ExtractionDocument,
} from './document.js';
import { FIELDS, FIELD_NAMES, fieldSpec, type Extracted } from './schema.js';

export const TOOLS = [
  {
    name: 'list_sections',
    description:
      'The headings of the document, in order. Cheap, and the right first call on a long contract — it tells you where to look without reading everything.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_section',
    description:
      'The full verbatim text of one section, by heading. Use this to read a clause you intend to quote.',
    input_schema: {
      type: 'object',
      properties: { heading: { type: 'string', description: 'A heading as list_sections gave it.' } },
      required: ['heading'],
    },
  },
  {
    name: 'search_document',
    description:
      'Every sentence containing a phrase, with the section it belongs to. Use this before recording any field, and use it more than once per field — a contract often answers the same question in two places, and the second place is usually a schedule.',
    input_schema: {
      type: 'object',
      properties: { phrase: { type: 'string', description: 'A short phrase, not a question.' } },
      required: ['phrase'],
    },
  },
  {
    name: 'record_field',
    description:
      'Record a value you have found, with the words from the document that say so. The span must be copied from the document exactly; it is checked here, and a span that is not in the document is refused rather than stored.',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'One of the schema field names.' },
        value: { type: 'string', description: 'The value, as text. Numbers and dates are converted here, not by you.' },
        values: { type: 'array', items: { type: 'string' }, description: 'For list fields such as parties, one entry per item.' },
        unit: { type: 'string', description: 'For a figure, the unit the DOCUMENT uses — days, months, years. Never convert between units.' },
        span: { type: 'string', description: 'The exact words from the document that state this value. At least a clause, not a fragment.' },
        section: { type: 'string', description: 'The heading of the section the span came from.' },
      },
      required: ['field', 'span', 'section'],
    },
  },
  {
    name: 'record_absent',
    description:
      'Record that the document does not answer a field. This is a correct and common answer — many contracts have no termination-for-convenience clause — and it is not the same as leaving the field out.',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string' },
        note: { type: 'string', description: 'Where you looked.' },
      },
      required: ['field', 'note'],
    },
  },
  {
    name: 'record_ambiguous',
    description:
      'Record that the document answers a field in more than one way. Use this instead of choosing. Two clauses giving different notice periods is not a confidence problem — picking one is wrong whatever confidence is attached.',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string' },
        note: { type: 'string' },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              unit: { type: 'string' },
              span: { type: 'string' },
              section: { type: 'string' },
            },
            required: ['value', 'span', 'section'],
          },
        },
      },
      required: ['field', 'note', 'candidates'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Hand the document to a person. Use it when the document is not what you were told it is, when it refers to an amendment or annexe that is not present, or when a field matters and you cannot evidence it either way.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        fields: { type: 'array', items: { type: 'string' } },
      },
      required: ['reason'],
    },
  },
] as const satisfies readonly ToolDefinition[];

export type ToolName = (typeof TOOLS)[number]['name'];

/* ── there is no tool for any of these ────────────────────────────────── */

/**
 * `summarise_contract` — a summary of a contract term is a new term, written
 * by something nobody authorised to write terms. The insurance agent in this
 * set exists almost entirely because of this problem.
 *
 * `interpret_clause` — what a clause MEANS is legal advice. Extraction stops
 * at what a clause SAYS.
 *
 * `resolve_conflict` — picking between clause 11 and Schedule 2 applies an
 * order of precedence the document did not state.
 *
 * These are not missing features. A tool the model can reach for is a tool it
 * will eventually use, and none of the three has a safe version. There is a
 * test asserting they do not exist.
 */
export const DELIBERATELY_ABSENT = [
  'summarise_contract',
  'interpret_clause',
  'resolve_conflict',
] as const;

/* ── running them ─────────────────────────────────────────────────────── */

const coerce = (
  kind: string,
  value: string | undefined,
  values: readonly string[] | undefined,
): { ok: true; value: string | number | boolean | string[] } | { ok: false; why: string } => {
  if (kind === 'list') {
    const items = values ?? (value ? [value] : []);
    return items.length ? { ok: true, value: [...items] } : { ok: false, why: 'this field needs `values`, one entry per item' };
  }
  if (value === undefined) return { ok: false, why: 'this field needs `value`' };

  if (kind === 'number') {
    const n = Number(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, why: `"${value}" is not a figure` };
  }
  if (kind === 'boolean') {
    const t = value.trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(t)) return { ok: true, value: true };
    if (['false', 'no', 'n'].includes(t)) return { ok: true, value: false };
    return { ok: false, why: `"${value}" is not true or false` };
  }
  return { ok: true, value: String(value) };
};

export function runTool(
  doc: ExtractionDocument,
  _config: unknown,
  name: string,
  input: unknown,
  state: AgentState,
): ToolResult {
  const record = state.record as Record<string, Extracted>;

  switch (name as ToolName) {
    case 'list_sections':
      return { known: true, sections: doc.sections.map((s) => s.heading) };

    case 'read_section': {
      const { heading } = input as ToolInput<typeof TOOLS, 'read_section'>;
      const body = sectionBody(doc, heading);
      return body
        ? { known: true, heading, text: body }
        : { known: false, note: `no section matching "${heading}"`, sections: doc.sections.map((s) => s.heading) };
    }

    case 'search_document': {
      const { phrase } = input as ToolInput<typeof TOOLS, 'search_document'>;
      const hits = search(doc, phrase);
      return hits.length
        ? { known: true, phrase, hits: hits.map((h) => ({ section: h.section, sentence: h.text })) }
        : { known: false, phrase, note: 'no sentence in the document contains that phrase' };
    }

    case 'record_field': {
      const a = input as ToolInput<typeof TOOLS, 'record_field'>;
      const spec = fieldSpec(a.field);
      if (!spec) return { known: false, refused: [a.field], note: `"${a.field}" is not a field in this schema`, schema: FIELD_NAMES };

      // Refused here rather than at the end, so the model can fix it in-run.
      if (!contains(doc, a.span)) {
        return {
          known: false,
          refused: [a.field],
          note: 'that span is not in the document. Copy the words exactly from read_section or search_document rather than retyping them, and quote at least a full clause.',
        };
      }

      const got = coerce(spec.kind, a.value, a.values);
      if (!got.ok) return { known: false, refused: [a.field], note: got.why };

      record[a.field] = {
        state: 'found',
        value: got.value,
        ...(a.unit ? { unit: a.unit } : {}),
        span: a.span,
        section: a.section,
      };
      return { known: true, recorded: a.field, value: got.value };
    }

    case 'record_absent': {
      const a = input as ToolInput<typeof TOOLS, 'record_absent'>;
      if (!fieldSpec(a.field)) return { known: false, refused: [a.field], note: `"${a.field}" is not a field in this schema` };
      record[a.field] = { state: 'absent', note: a.note };
      return { known: true, recorded: a.field, state: 'absent' };
    }

    case 'record_ambiguous': {
      const a = input as ToolInput<typeof TOOLS, 'record_ambiguous'>;
      if (!fieldSpec(a.field)) return { known: false, refused: [a.field], note: `"${a.field}" is not a field in this schema` };

      const unverified = a.candidates.filter((c) => !contains(doc, c.span));
      if (unverified.length) {
        return {
          known: false,
          refused: [a.field],
          note: `${unverified.length} of the candidate spans are not in the document. Every candidate needs real words behind it.`,
        };
      }

      record[a.field] = {
        state: 'ambiguous',
        note: a.note,
        candidates: a.candidates.map((c) => ({
          value: c.value,
          ...(c.unit ? { unit: c.unit } : {}),
          span: c.span,
          section: c.section,
        })),
      };
      return { known: true, recorded: a.field, state: 'ambiguous', candidates: a.candidates.length };
    }

    case 'escalate_to_human': {
      const a = input as ToolInput<typeof TOOLS, 'escalate_to_human'>;
      state.escalations.push({ at: new Date().toISOString(), reason: a.reason, fields: a.fields ?? [] });
      return { known: true, escalated: true };
    }

    default:
      return { known: false, error: `no tool named "${name}"` };
  }
}

export const schemaForPrompt = (): string =>
  FIELDS.map((f) => `  ${f.name} (${f.kind}) — ${f.what}`).join('\n');
