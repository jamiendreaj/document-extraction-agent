/**
 * The document, and the normalisation that decides whether this agent works.
 *
 * Every field this agent extracts has to carry the words it came from, and
 * every one of those spans is checked against the document before the result
 * leaves. That check is the whole product, so it is worth being precise about
 * what "the span is in the document" means.
 *
 * It cannot be a plain substring test. Contract text arrives out of a PDF with
 * line breaks in the middle of sentences, non-breaking spaces, ligatures,
 * curly quotes and en dashes. A model quoting a clause back will silently tidy
 * all of that. Compare raw and honest quotations get rejected.
 *
 * It also cannot normalise freely, because every normalisation widens what
 * counts as evidence. So this file collapses exactly the things a faithful
 * quotation changes — whitespace, quote marks, dash shapes, unicode width,
 * case — and nothing else. Words, numbers and order all have to match.
 */

export type Section = {
  heading: string;
  /** Where the heading sits in the raw text, so a span can be located. */
  start: number;
  end: number;
};

export type ExtractionDocument = {
  title: string;
  /** The raw text, which is what gets quoted back to a reviewer. */
  text: string;
  /** The same text normalised once, so containment is not O(n) work per check. */
  normalised: string;
  sections: Section[];
};

/* ── normalisation ────────────────────────────────────────────────────── */

/**
 * The only transformations a faithful quotation is allowed to make.
 *
 * NFKC folds the things PDF extraction introduces: non-breaking spaces,
 * ligatures like "ﬁ", full-width punctuation. Then quotes and dashes are
 * flattened to one shape each, whitespace runs become single spaces, and the
 * result is lowercased.
 *
 * Lowercasing is the one that gives something away: a contract clause set in
 * capitals, quoted back in sentence case, still passes. That is deliberate —
 * all-caps clauses are everywhere in contracts and nobody retypes them
 * faithfully — but it does mean case is not evidence here.
 */
export function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ── the check ────────────────────────────────────────────────────────── */

/** Is this span genuinely in the document? Not a heuristic. */
export function contains(doc: ExtractionDocument, span: string): boolean {
  const needle = normalise(span);
  // An empty or near-empty span would match anything. A citation has to be
  // long enough to be a citation.
  if (needle.length < 12) return false;
  return doc.normalised.includes(needle);
}

/** Which section a span sits in, or null when it is not in the document. */
export function sectionOf(doc: ExtractionDocument, span: string): string | null {
  const needle = normalise(span);
  if (needle.length < 12) return null;

  // Locate the span by walking sections rather than mapping normalised offsets
  // back to raw ones, which is where this kind of code usually goes wrong.
  for (const s of doc.sections) {
    const body = normalise(doc.text.slice(s.start, s.end));
    if (body.includes(needle)) return s.heading;
  }
  return doc.normalised.includes(needle) ? '(unsectioned)' : null;
}

/* ── structure ────────────────────────────────────────────────────────── */

const ANNEXE = /^(?:schedule|annex(?:e|ure)?|exhibit|appendix|amendment|addendum)\b/i;
const NUMBERED = /^\d+(?:\.\d+)*\.?(?:\s|$)/;

/**
 * Is this line a heading?
 *
 * Deliberately conservative. A missed heading costs a little precision in
 * reporting; a false heading splits a clause in two and can hide a conflict
 * between its halves, which is the failure this agent exists to catch.
 */
function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 90) return false;

  if (ANNEXE.test(t)) return true;

  // A clause ends in a full stop. A heading does not. This one line is doing
  // most of the work: without it, `1.1 "Effective Date" means 1 February
  // 2027.` reads as a heading, every short numbered clause becomes its own
  // section, and the conflict check loses the section boundaries it depends
  // on. A bare marker like "3." is the only exception.
  if (/[.;:,]$/.test(t) && !/^\d+(?:\.\d+)*\.$/.test(t)) return false;

  if (NUMBERED.test(t)) {
    // "11.2 Notice" is a heading. "11.2 The Supplier shall give the Customer
    // not less than thirty days written notice" is a clause that happens to
    // start with a number.
    const rest = t.replace(NUMBERED, '').trim();
    return rest.length <= 70 && rest.split(/\s+/).length <= 9;
  }

  // An all-caps line with no sentence punctuation.
  return t === t.toUpperCase() && /[A-Z]{3}/.test(t) && !/[.!?]/.test(t);
}

export function parseDocument(title: string, raw: string): ExtractionDocument {
  const lines = raw.split('\n');
  const sections: Section[] = [];

  let offset = 0;
  const starts: { heading: string; at: number }[] = [];
  for (const line of lines) {
    if (isHeading(line)) starts.push({ heading: line.trim(), at: offset });
    offset += line.length + 1;
  }

  for (let i = 0; i < starts.length; i++) {
    const here = starts[i]!;
    sections.push({
      heading: here.heading,
      start: here.at,
      end: starts[i + 1]?.at ?? raw.length,
    });
  }

  return { title, text: raw, normalised: normalise(raw), sections };
}

/* ── reading ──────────────────────────────────────────────────────────── */

export function sectionBody(doc: ExtractionDocument, heading: string): string | null {
  const want = normalise(heading);
  const hit =
    doc.sections.find((s) => normalise(s.heading) === want) ??
    doc.sections.find((s) => normalise(s.heading).includes(want));
  return hit ? doc.text.slice(hit.start, hit.end).trim() : null;
}

export type Sentence = { text: string; section: string };

/**
 * Every sentence in the document, tagged with the section it belongs to.
 *
 * Sentence splitting on contract text has to survive "No. 1", "Section 11.2",
 * "approx." and "e.g.", so the split only fires on a full stop followed by
 * whitespace and a capital or a digit, and never inside a number.
 */
export function sentences(doc: ExtractionDocument): Sentence[] {
  const out: Sentence[] = [];
  const spans = doc.sections.length
    ? doc.sections.map((s) => ({ heading: s.heading, body: doc.text.slice(s.start, s.end) }))
    : [{ heading: '(unsectioned)', body: doc.text }];

  for (const { heading, body } of spans) {
    for (const piece of body.split(/(?<=[a-z0-9)\]"'])\.\s+(?=[A-Z0-9])|\n{2,}/)) {
      const t = piece.replace(/\s+/g, ' ').trim();
      if (t) out.push({ text: t, section: heading });
    }
  }
  return out;
}

/** Sentences mentioning a phrase, so the model can find candidates rather than recall them. */
export function search(doc: ExtractionDocument, phrase: string): Sentence[] {
  const needle = normalise(phrase);
  if (!needle) return [];
  return sentences(doc).filter((s) => normalise(s.text).includes(needle));
}
