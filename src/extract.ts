/**
 * The agent.
 *
 * Almost nothing here, which is the point: the loop, the token budget, the
 * stop-reason handling and the one-sentence explanation all come from
 * `grounded-agents`. What is left is this domain's prompt, its tools, and its
 * rules — and that is the first real test of whether extracting that framework
 * was worth doing.
 */

import { defineAgent, run } from 'grounded-agents';
import type { MessageClient, RunResult } from 'grounded-agents';

import { ALL, GRAVE } from './guards.js';
import { prompt, type Config } from './prompt.js';
import { TOOLS, runTool } from './tools.js';
import type { ExtractionDocument } from './document.js';
import type { Extraction } from './schema.js';

export const agent = defineAgent<ExtractionDocument, Config>({
  name: 'document-extraction',
  prompt,
  tools: () => [...TOOLS],
  runTool,
  guards: ALL,
  grave: GRAVE,
  graveLabel: 'DO NOT USE',
  graveAdvice: 'The extraction is not usable as it stands and needs a person.',

  /*
   * Nine fields, each wanting a search, a read and a record, and some wanting
   * two searches because the second answer lives in a schedule. That is a much
   * longer loop than an enquiry agent needs, and the ceilings are set from
   * that arithmetic rather than from the framework defaults — which exist for
   * a four-turn conversation and would cut this off halfway through.
   */
  maxTurns: 30,
  maxTokens: 2000,
  tokenBudget: 200_000,
});

export type ExtractionResult = RunResult<ExtractionDocument, Config> & {
  /** The fields, after the guards have had their say. */
  extraction: Extraction;
  /** Fields removed because their evidence did not survive checking. */
  removed: string[];
};

export async function extract(opts: {
  document: ExtractionDocument;
  config?: Config;
  client?: MessageClient;
  instruction?: string;
}): Promise<ExtractionResult> {
  const result = await run(agent, {
    document: opts.document,
    config: opts.config ?? {},
    input: opts.instruction ?? 'Extract every field in the schema from this contract.',
    ...(opts.client ? { client: opts.client } : {}),
  });

  const extraction = result.record as Extraction;

  /*
   * A failed field is DELETED, not annotated.
   *
   * This is the one decision in the repo I would defend hardest. The
   * alternative — keep the value, attach the warning — reads as more
   * informative and is worse, because the value then travels. Somebody copies
   * it into a renewal calendar, or a model downstream reads the table and not
   * the notes. A field whose quotation is not in the document is not a
   * low-confidence fact. It is not a fact.
   */
  const removed: string[] = [];
  const blocked = new Set(result.guardrails.blocked);
  if (blocked.size) {
    for (const issue of result.guardrails.issues) {
      if (issue.severity !== 'block') continue;
      for (const name of Object.keys(extraction)) {
        if (issue.detail.includes(name) && !removed.includes(name)) {
          delete extraction[name as keyof Extraction];
          removed.push(name);
        }
      }
    }
  }

  return { ...result, extraction, removed };
}
