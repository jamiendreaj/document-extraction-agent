/**
 * The checks, which for this agent are arithmetic rather than judgement.
 *
 * This is the thing that makes extraction different from every other agent I
 * have written. In an enquiry agent the guardrails are heuristics: a regex
 * that recognises the SHAPE of advice, or of a price nobody authorised. They
 * are good, and they are approximations, and a careful sentence gets past
 * them.
 *
 * Extraction is not like that. Every field comes back with the words it came
 * from, and whether those words are in the document is a fact. So is whether
 * the recorded figure appears in them. So is whether some other section of the
 * document answers the same field differently. None of that needs a model to
 * adjudicate, and none of it can be talked around.
 *
 * Which is why the failure mode here is deletion, not warning. An unevidenced
 * field is not a field with a low score attached; it is a sentence the
 * document does not contain, and it leaves.
 */

import { rule } from 'grounded-agents/guards';
import type { Guard, GuardContext } from 'grounded-agents';

import { contains, normalise, sectionOf, type ExtractionDocument } from './document.js';
import { allNumbers } from './numbers.js';
import { parseDates } from './dates.js';
import { candidates, disagreeingSections, normaliseUnit } from './candidates.js';
import { fieldSpec, FIELD_NAMES, type Extracted, type Extraction } from './schema.js';

type Ctx = GuardContext<ExtractionDocument, unknown>;

const fields = (ctx: Ctx): [string, Extracted][] =>
  Object.entries((ctx.state.record ?? {}) as Extraction).filter(
    (e): e is [string, Extracted] => Boolean(e[1]),
  );

const list = (items: string[]): string => items.join('; ');

/** The key a value is compared under: "30 day", or an ISO date. */
const keyOf = (f: Extracted & { state: 'found' }): string =>
  f.unit ? `${f.value} ${normaliseUnit(f.unit)}` : String(f.value);

/* ── 1. the span is really in the document ────────────────────────────── */

/**
 * The check the whole design rests on.
 *
 * A model asked for a quotation will produce one. It will be fluent, it will
 * be in the register of the document, and perhaps a quarter of the time on a
 * long contract it will be a sentence the contract does not contain. Nothing
 * downstream can tell, because a fabricated span reads exactly like a real
 * one — that is what makes it worth checking rather than trusting.
 */
export const unevidencedField = (): Guard<ExtractionDocument, unknown> =>
  rule('unevidenced_field', {
    test: (_t, ctx) => {
      const bad: string[] = [];
      for (const [name, f] of fields(ctx as Ctx)) {
        if (f.state === 'found' && !contains(ctx.document, f.span)) {
          bad.push(`${name} quotes "${f.span.slice(0, 60)}…" which is not in the document`);
        }
        if (f.state === 'ambiguous') {
          for (const c of f.candidates) {
            if (!contains(ctx.document, c.span)) {
              bad.push(`${name} offers a candidate quoting "${c.span.slice(0, 60)}…" which is not in the document`);
            }
          }
        }
      }
      return bad.length ? bad : null;
    },
    detail: (bad: string[]) => list(bad),
  });

/* ── 2. the value is really in the span ───────────────────────────────── */

/**
 * The miss that a span check alone does not catch.
 *
 * `notice_period: 30` with a span reading "not less than sixty (60) days" is a
 * real quotation attached to the wrong number. The citation passes. A reviewer
 * skimming a table of values and citations passes it too, because the
 * quotation is genuine — they would have to read it against the figure to see
 * the problem, and the entire reason they are given a table is so they do not
 * have to.
 */
export const valueNotInSpan = (): Guard<ExtractionDocument, unknown> =>
  rule('value_not_in_span', {
    test: (_t, ctx) => {
      const bad: string[] = [];
      for (const [name, f] of fields(ctx as Ctx)) {
        if (f.state !== 'found') continue;
        const spec = fieldSpec(name);
        if (!spec) continue;

        if (spec.kind === 'number') {
          if (!allNumbers(f.span).has(Number(f.value))) {
            bad.push(`${name} records ${String(f.value)}, which does not appear in its own quotation`);
          }
          if (f.unit && !new RegExp(normaliseUnit(f.unit), 'i').test(f.span)) {
            bad.push(`${name} records the unit "${f.unit}", which does not appear in its own quotation`);
          }
        }

        if (spec.kind === 'date') {
          const seen = parseDates(f.span);
          if (!seen.some((d) => d.iso === f.value || d.raw === f.value)) {
            bad.push(`${name} records ${String(f.value)}, which is not the date its quotation states`);
          }
        }

        // A text value has to be the document's words, not a tidier version of
        // them. "English law" from "the laws of England and Wales" is a
        // paraphrase, and a paraphrase of a contract term is a new term.
        if (spec.kind === 'text') {
          const v = String(f.value);
          if (v.length < 200 && !normaliseContains(f.span, v)) {
            bad.push(`${name} records "${v}", which is not in its own quotation — it has been reworded`);
          }
        }
      }
      return bad.length ? bad : null;
    },
    detail: (bad: string[]) => list(bad),
  });

/**
 * Containment within one span, under the document's own normalisation.
 *
 * Reusing `normalise` rather than writing a second copy of it matters more
 * than it looks: two normalisers that drift apart mean a value can pass this
 * check and fail the document check, or the reverse, for reasons nobody can
 * see from the output.
 */
const normaliseContains = (span: string, value: string): boolean =>
  normalise(span).includes(normalise(value));

/* ── 3. the document does not answer this twice, differently ──────────── */

/**
 * The one that matters most, and the only one of these a prompt could never do.
 *
 * Clause 11 says thirty days. Schedule 2, amended later and separately, says
 * sixty. The model reads clause 11, records thirty, quotes it exactly, and is
 * right about everything it looked at. The error is in what it did not look at,
 * so no amount of care about the quotation finds it.
 *
 * The code reads the document independently and asks whether any other section
 * answers the field with a different figure in the same unit. It does not pick
 * a winner: contracts state their own order of precedence between the body and
 * a schedule, and applying a hierarchy this document did not state would be
 * interpretation. Two answers means a person.
 */
export const silentDisambiguation = (): Guard<ExtractionDocument, unknown> =>
  rule('silent_disambiguation', {
    test: (_t, ctx) => {
      const bad: string[] = [];
      for (const [name, f] of fields(ctx as Ctx)) {
        if (f.state !== 'found') continue;
        const spec = fieldSpec(name);
        if (!spec || (spec.kind !== 'number' && spec.kind !== 'date')) continue;

        for (const d of disagreeingSections(candidates(ctx.document, spec), keyOf(f))) {
          if (d.kind === 'conflict') {
            bad.push(
              `${name} is recorded as ${keyOf(f)} from "${f.section}", but "${d.section}" says ${d.says.join(' / ')} — the document answers this twice and does not say which governs`,
            );
          }
        }
      }
      return bad.length ? bad : null;
    },
    detail: (bad: string[]) => list(bad),
  });

/** The same field answered in a different unit somewhere else. Reported, not resolved. */
export const crossUnitMention = (): Guard<ExtractionDocument, unknown> =>
  rule('cross_unit_mention', {
    severity: 'warn',
    test: (_t, ctx) => {
      const bad: string[] = [];
      for (const [name, f] of fields(ctx as Ctx)) {
        if (f.state !== 'found') continue;
        const spec = fieldSpec(name);
        if (!spec || spec.kind !== 'number') continue;

        for (const d of disagreeingSections(candidates(ctx.document, spec), keyOf(f))) {
          if (d.kind === 'other_unit') {
            bad.push(`"${d.section}" also gives a figure for ${name} (${d.says.join(' / ')}) in a different unit, which is not compared`);
          }
        }
      }
      return bad.length ? bad : null;
    },
    detail: (bad: string[]) => list(bad),
  });

/* ── 4. a date nobody can read ────────────────────────────────────────── */

/**
 * "03/04/2027" is April in London and March in Chicago, and the document does
 * not say which it is. A month of error on a notice window is the difference
 * between serving in time and missing it, so the only correct output is that
 * the date cannot be read.
 */
export const unresolvableDate = (): Guard<ExtractionDocument, unknown> =>
  rule('unresolvable_date', {
    test: (_t, ctx) => {
      const bad: string[] = [];
      for (const [name, f] of fields(ctx as Ctx)) {
        if (f.state !== 'found') continue;
        if (fieldSpec(name)?.kind !== 'date') continue;

        const seen = parseDates(f.span);
        const resolved = seen.filter((d) => d.iso !== null);
        if (!resolved.length && seen.some((d) => d.ambiguous)) {
          bad.push(`${name} comes from "${seen[0]!.raw}", whose day and month order the document never settles`);
        }
        if (!seen.length) {
          bad.push(`${name} is recorded as a date, but its quotation contains none`);
        }
      }
      return bad.length ? bad : null;
    },
    detail: (bad: string[]) => list(bad),
  });

/* ── 5. the small ones ────────────────────────────────────────────────── */

/** A party name the document does not contain. The easiest thing to get subtly wrong. */
export const inventedParty = (): Guard<ExtractionDocument, unknown> =>
  rule('invented_party', {
    test: (_t, ctx) => {
      const f = ((ctx.state.record ?? {}) as Extraction).parties;
      if (!f || f.state !== 'found' || !Array.isArray(f.value)) return null;
      // A legal name is long enough to check in full; dropping "S.p.A." changes
      // which company is bound.
      const bad = f.value.filter((name) => !contains(ctx.document, name) && name.length >= 12);
      return bad.length ? bad : null;
    },
    detail: (bad: string[]) => `names a party the document does not contain: ${list(bad)}`,
  });

/** A span that is in the document, but not where the agent said it was. */
export const wrongSection = (): Guard<ExtractionDocument, unknown> =>
  rule('wrong_section', {
    severity: 'warn',
    test: (_t, ctx) => {
      const bad: string[] = [];
      for (const [name, f] of fields(ctx as Ctx)) {
        if (f.state !== 'found') continue;
        const real = sectionOf(ctx.document, f.span);
        if (real && real !== f.section) {
          bad.push(`${name} is attributed to "${f.section}" but its words are in "${real}"`);
        }
      }
      return bad.length ? bad : null;
    },
    detail: (bad: string[]) => list(bad),
  });

/** A field name that is not in the schema. The tool refuses these; this is the second lock. */
export const unknownField = (): Guard<ExtractionDocument, unknown> =>
  rule('unknown_field', {
    test: (_t, ctx) => {
      const bad = fields(ctx as Ctx)
        .map(([name]) => name)
        .filter((name) => !(FIELD_NAMES as readonly string[]).includes(name));
      return bad.length ? bad : null;
    },
    detail: (bad: string[]) => `recorded fields that are not in the schema: ${list(bad)}`,
  });

/** Nothing recorded at all — a run that looked like it worked and produced no data. */
export const nothingExtracted = (): Guard<ExtractionDocument, unknown> =>
  rule('nothing_extracted', {
    test: (_t, ctx) => (fields(ctx as Ctx).length === 0 ? true : null),
    detail: () => 'no field was recorded, so there is nothing to review',
  });

export const ALL = [
  unevidencedField(),
  valueNotInSpan(),
  silentDisambiguation(),
  unresolvableDate(),
  inventedParty(),
  unknownField(),
  nothingExtracted(),
  wrongSection(),
  crossUnitMention(),
] as const;

/** Failures that are a different kind of failure: the output is not merely imperfect, it is false. */
export const GRAVE = [
  'unevidenced_field',
  'value_not_in_span',
  'silent_disambiguation',
  'invented_party',
  'unknown_field',
] as const;
