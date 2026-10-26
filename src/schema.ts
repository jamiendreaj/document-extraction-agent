/**
 * The fields, and what makes each one checkable.
 *
 * A schema in an extraction agent is usually just a list of names and types.
 * This one carries two extra things per field, and they are the reason the
 * guardrails can be exact rather than advisory:
 *
 *   `triggers` marks a sentence as being ABOUT this field. It is never shown
 *   to the model. It is how the code finds every place the document speaks to
 *   a field, so it can tell whether the one the model quoted was the only one.
 *
 *   `unit` is the word a figure has to sit beside to count as a value for this
 *   field. Without it, "clause 11.2" reads as the number 11.2 and every
 *   cross-reference in the contract becomes a candidate notice period.
 */

export type FieldKind = 'text' | 'list' | 'date' | 'boolean' | 'number';

export type FieldSpec = {
  name: string;
  kind: FieldKind;
  /** Shown to the model. Says what the field is, not how to find it. */
  what: string;
  triggers: RegExp;
  /** Number fields only: the unit a figure must be adjacent to. */
  unit?: RegExp;
};

export const FIELDS = [
  {
    name: 'parties',
    kind: 'list',
    what: 'The full legal names of the contracting parties, exactly as the document writes them, including any suffix such as Ltd, S.p.A., GmbH or Inc.',
    triggers: /\b(?:between|party|parties|supplier|customer|this agreement is made)\b/i,
  },
  {
    name: 'effective_date',
    kind: 'date',
    what: 'The date the agreement takes effect. Not the date it was signed, if the document distinguishes them.',
    triggers: /\b(?:effective date|commencement date|commences|takes effect|shall begin)\b/i,
  },
  {
    name: 'initial_term',
    kind: 'number',
    what: 'The length of the initial term, as a figure, together with the unit the document uses — months or years. Do not convert between them.',
    triggers: /\b(?:initial term|term of this agreement|shall continue for|minimum term)\b/i,
    unit: /\bmonths?\b|\byears?\b/i,
  },
  {
    name: 'auto_renews',
    kind: 'boolean',
    what: 'Whether the agreement renews automatically at the end of a term unless notice is given.',
    triggers: /\b(?:automatically renew|auto-?renew|shall renew|renewal term|successive)\b/i,
  },
  {
    name: 'notice_period',
    kind: 'number',
    what: 'How much notice a party must give to prevent renewal or to terminate, as a figure plus the unit the document uses — days or months.',
    triggers: /\b(?:notice|terminat\w+|non-?renewal)\b/i,
    unit: /\bdays?\b|\bmonths?\b/i,
  },
  {
    name: 'liability_cap',
    kind: 'text',
    what: 'The limit on liability, quoted as the document expresses it. Many caps are a formula rather than a figure — if so, record the formula verbatim and do not compute it.',
    triggers: /\b(?:liability|liable|aggregate|cap(?:ped)?|damages)\b/i,
  },
  {
    name: 'payment_terms',
    kind: 'number',
    what: 'How long after invoice payment falls due, as a figure plus the unit the document uses.',
    triggers: /\b(?:payment|invoice|pay(?:able)?|due)\b/i,
    unit: /\bdays?\b|\bmonths?\b/i,
  },
  {
    name: 'governing_law',
    kind: 'text',
    what: 'The law governing the agreement, as a jurisdiction name.',
    triggers: /\b(?:governing law|governed by|construed in accordance|jurisdiction)\b/i,
  },
  {
    name: 'termination_for_convenience',
    kind: 'boolean',
    what: 'Whether a party may terminate without cause. Absent is a common and correct answer here.',
    triggers: /\b(?:for convenience|without cause|at any time by giving|terminate at will)\b/i,
  },
] as const satisfies readonly FieldSpec[];

export type FieldName = (typeof FIELDS)[number]['name'];

export const FIELD_NAMES = FIELDS.map((f) => f.name) as readonly FieldName[];

export const fieldSpec = (name: string): FieldSpec | undefined =>
  FIELDS.find((f) => f.name === name);

/* ── the three states a field can be in ───────────────────────────────── */

/**
 * `absent` is not the same as missing from the output, and `ambiguous` is not
 * the same as a low confidence score.
 *
 * Collapsing these is the mistake that makes extraction output untrustworthy.
 * A field left out of the result could mean the document is silent or could
 * mean nobody looked. A field the document answers twice, differently, is not
 * a confidence problem — averaging it or picking the first is wrong whatever
 * number is attached. It needs a person.
 */
export type Extracted =
  | {
      state: 'found';
      value: string | number | boolean | string[];
      /**
       * Number fields carry the unit the DOCUMENT used, never a unit the
       * schema wanted.
       *
       * This field used to be called `notice_period_days`. A name like that
       * asks the model to turn "two months' notice" into 60 days, and it
       * will, every time, without saying that it did. Two months is not 60
       * days in a month with 31 in it, and on a notice window two days is the
       * difference between serving in time and missing it. The schema no
       * longer names a unit, so there is nothing to convert to.
       */
      unit?: string;
      /** The words in the document that say so. Checked, not trusted. */
      span: string;
      section: string;
    }
  | { state: 'absent'; note: string }
  | {
      state: 'ambiguous';
      candidates: { value: string | number | boolean; unit?: string; span: string; section: string }[];
      note: string;
    };

export type Extraction = Partial<Record<FieldName, Extracted>>;
