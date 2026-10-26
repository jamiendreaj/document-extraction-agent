/**
 * One contract in, a table of evidenced fields out.
 *
 *   npm run extract -- contracts/example-supply-agreement.txt
 *
 * Needs ANTHROPIC_API_KEY. The test suite does not, which is the point of the
 * injectable client — and the reason the suite runs in CI at all.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parseDocument } from './document.js';
import { extract } from './extract.js';
import { report } from './report.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run extract -- <contract.txt>');
  process.exit(2);
}

const doc = parseDocument(basename(file), readFileSync(file, 'utf8'));
console.error(`${doc.title}: ${doc.sections.length} sections, ${doc.text.length} characters\n`);

const r = await extract({ document: doc });

console.log(report(r));
console.log(`\n${r.tokens_used} tokens, ${r.tool_calls.length} tool calls, ${r.latency_ms}ms`);

if (!r.sendable) process.exitCode = 1;
