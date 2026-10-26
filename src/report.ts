/**
 * The report, separated from the CLI so it can be tested.
 *
 * Printing is where an extraction result stops being data and starts being
 * something a person acts on, and the distinctions this agent works hard to
 * keep have to survive that. Three of them matter:
 *
 *   `absent` and `not examined` print differently. The document being silent
 *   and nobody having looked are opposite facts, and a dash means neither.
 *
 *   `AMBIGUOUS` prints every candidate with its own section and quotation,
 *   because the whole value of the state is that the reviewer sees both and
 *   decides. One line saying "ambiguous" throws away the work.
 *
 *   A removed field says REMOVED rather than vanishing, so the absence is
 *   legible. A field that silently disappears looks like one nobody asked for.
 */

import type { ExtractionResult } from './extract.js';
import { FIELD_NAMES } from './schema.js';

const trim = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pad = (s: string, n: number) => clip(s, n).padEnd(n);

const GUTTER = ' '.repeat(31);
const WIDTH = 88;

/**
 * Quotations WRAP. They are never clipped.
 *
 * An earlier version truncated them to fit, and cut "written notice" off the
 * end of the notice clause. The span is the one thing in this report that is
 * not the agent's word for something — it is the contract's. Shortening it to
 * make a table line up turns the evidence back into a summary, which is the
 * failure the whole repository is built against.
 */
function wrap(text: string, indent: string): string[] {
  const words = trim(text).split(' ');
  const lines: string[] = [];
  let line = '';

  for (const w of words) {
    if (line && (line + ' ' + w).length > WIDTH) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);

  return lines.map((l, i) => indent + (i === 0 ? '"' : ' ') + l + (i === lines.length - 1 ? '"' : ''));
}

export function report(r: ExtractionResult): string {
  const out: string[] = [];

  for (const name of FIELD_NAMES) {
    const f = r.extraction[name];

    if (!f) {
      out.push(
        `${pad(name, 30)} ${r.removed.includes(name) ? 'REMOVED — evidence did not check out' : 'not examined'}`,
      );
      continue;
    }

    if (f.state === 'absent') {
      out.push(`${pad(name, 30)} absent — ${f.note}`);
      continue;
    }

    if (f.state === 'ambiguous') {
      out.push(`${pad(name, 30)} AMBIGUOUS — ${f.note}`);
      for (const c of f.candidates) {
        out.push(`${GUTTER}• ${c.value}${c.unit ? ' ' + c.unit : ''}   [${c.section}]`);
        out.push(...wrap(c.span, GUTTER + '  '));
      }
      continue;
    }

    const value = Array.isArray(f.value) ? f.value.join(' · ') : String(f.value);
    out.push(`${pad(name, 30)} ${value}${f.unit ? ' ' + f.unit : ''}   [${f.section}]`);
    out.push(...wrap(f.span, GUTTER));
  }

  if (r.escalations.length || r.guardrails.issues.length) {
    out.push('');
    for (const e of r.escalations) out.push(`ESCALATED  ${String(e.reason)}`);
    for (const i of r.guardrails.issues) {
      out.push(`${i.severity === 'block' ? 'BLOCK' : 'warn '}      ${i.rule}: ${clip(i.detail, 150)}`);
    }
  }
  out.push('');
  out.push(r.sendable ? 'USABLE — every recorded field carries evidence that checks out.' : String(r.blocked_because));

  return out.join('\n');
}
