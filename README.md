# document-extraction-agent

Pulls structured fields out of a contract. Every field carries the words it
came from, and **a field whose words are not in the document is deleted, not
flagged.**

```bash
npm install
npm test                                              # 58 tests, offline, no API key
npm run sample                                        # a full extraction, scripted
npm run extract -- contracts/example-supply-agreement.txt   # needs ANTHROPIC_API_KEY
```

---

## Why extraction is a different problem

Most of what an agent does can only be checked approximately. You can write a
regex that recognises the *shape* of financial advice, or of a price nobody
authorised, and it will be good, and a careful sentence will still get past it.

Extraction is not like that. If every value comes back with the span it was
read from, then three questions have definite answers:

- Is that span in the document?
- Does the recorded figure appear in that span?
- Does any other part of the document answer the same field differently?

None of those needs a model to adjudicate, and none can be talked around. So
the guardrails here are **arithmetic, not judgement** — and that changes what
they are allowed to do about a failure.

---

## The failure this repository is actually for

A supplier agreement says the notice period is **thirty days** in clause 11.1.
Schedule 2, amended later and separately, says **sixty**.

The model reads clause 11, records thirty, and quotes it exactly. Everything it
looked at is correct. The citation verifies. A reviewer checking the quotation
against the clause finds nothing wrong, because **nothing is wrong with the
part it read** — the error is in the part it never opened.

No prompt prevents this. So the code reads the document independently of the
model and asks whether any other section answers the field with a different
figure in the same unit:

```
notice_period                  REMOVED — evidence did not check out

BLOCK      silent_disambiguation: notice_period is recorded as 30 day from
           "11. NOTICES AND NON-RENEWAL", but "SCHEDULE 2 - OPERATIONAL
           PROVISIONS" says 60 day — the document answers this twice and
           does not say which governs

DO NOT USE — silent_disambiguation. The extraction is not usable as it
stands and needs a person.
```

(The finding is one line in the real output; wrapped here to fit.)

**It does not pick a winner.** Contracts state their own order of precedence
between the body and a schedule, and applying a hierarchy the document did not
state is interpretation — which is the one thing this agent is built not to do.
Two answers means a person.

The correct answer is reachable, and it is the one that passes:

```
notice_period                  AMBIGUOUS — Clause 11.1 and Schedule 2 give different periods and the Agreement states no order of precedence between them.
                               • 30 days   [11. NOTICES AND NON-RENEWAL]
                                 "shall give the other party not less than thirty (30) days written notice before the end
                                  of the then current term."
                               • 60 days   [SCHEDULE 2 - OPERATIONAL PROVISIONS]
                                 "a party wishing to prevent renewal shall give not less than sixty (60) days written
                                  notice before the end of the then current term."
```

---

## Three states, not a confidence score

| | |
| --- | --- |
| `found` | a value, the span it came from, and the section |
| `absent` | looked for; the document does not say |
| `ambiguous` | answered more than once, differently |

There is deliberately **no confidence number**. A field the document answers
twice is not a low-confidence field — picking one is wrong whatever number is
attached to it, and a score invites someone downstream to threshold it and
move on.

`absent` and *not examined* are also different facts, and they print
differently. A dash in a cell means neither.

---

## A field that fails a check is deleted

The alternative — keep the value, attach a warning — reads as more informative
and is worse. The value then travels: somebody copies it into a renewal
calendar, or a model downstream reads the table and not the notes.

A field whose quotation is not in the document is not a low-confidence fact.
**It is not a fact.**

```
notice_period                  REMOVED — evidence did not check out
```

---

## What it checks

| Rule | Catches |
| --- | --- |
| `unevidenced_field` | A span the document does not contain |
| `value_not_in_span` | `30` recorded against a span reading *"sixty (60) days"* — a real quotation with the wrong figure attached |
| `silent_disambiguation` | The document answering one field twice, differently |
| `unresolvable_date` | `03/04/2027`, which is April in London and March in Chicago |
| `invented_party` | *"Northbrook Analytics **Limited**"* for *"Ltd"* — a different legal entity |
| `unknown_field` | Anything not in the schema |
| `nothing_extracted` | A run that looked like it worked and produced no data |

Plus two warnings: `wrong_section`, and `cross_unit_mention` — another section
giving a figure for the same field in a different unit. That one does **not**
block, because deciding whether thirty days contradicts one month means
deciding how many days a month has. This agent refuses that conversion when
extracting, so it would be incoherent to perform it in order to accuse the
model of an error.

---

## Two details that look small

**The unit used to be in the field name.** It was `notice_period_days`. A name
like that asks the model to turn *"two months' notice"* into 60 days, and it
will, every time, without saying that it did. Two months is not 60 days in a
month with 31 in it, and on a notice window two days is the difference between
serving in time and missing it. The schema now names no unit, so there is
nothing to convert to — the figure and the document's own word travel together.

**A cap is often not a number.** *"the aggregate Fees paid by the Customer in
the twelve (12) months preceding the event giving rise to the claim"* is the
cap. Forcing that field to a number invents one, so the field's type is text
and the formula is recorded verbatim.

---

## The tools, and the three that do not exist

| Tool | Does |
| --- | --- |
| `list_sections` | Headings only — the right first call on a long contract |
| `read_section` | One section, verbatim |
| `search_document` | Every sentence containing a phrase, **with its section** |
| `record_field` | Stores a value, and **refuses a span not in the document** |
| `record_absent` | The document is silent |
| `record_ambiguous` | The document answers twice |
| `escalate_to_human` | An annexe referred to and not supplied, and similar |

`search_document` exists so the model *finds* values rather than recalling
them. Asked for a quotation it never retrieved, a model will produce one.

`record_field` runs the same containment check the guardrails run, at the
moment it is called. That is not redundant — a tool error comes back as a tool
result and the model can fix it inside the run, while a guard failure arrives
after everything is spent.

There is **no** `summarise_contract` (a summary of a contract term is a new
term), no `interpret_clause` (what a clause means is legal advice), and no
`resolve_conflict` (that applies a precedence the document did not state). A
tool the model can reach for is a tool it will eventually use, so there is a
test asserting none of them exists.

---

## Reading the document

The containment check cannot be a plain substring test. Contract text arrives
out of a PDF with line breaks mid-sentence, non-breaking spaces, ligatures,
curly quotes and en dashes, and a model quoting a clause tidies all of it. Compare
raw and every honest citation is rejected.

It also cannot normalise freely, because every normalisation widens what counts
as evidence. So exactly the things a faithful quotation changes are collapsed —
whitespace, quote marks, dash shapes, unicode width, case — and nothing else.
Words, numbers and order all have to match. Case is the one concession, and it
is named in the code as one.

Two more things that are silent when wrong:

- **`€1.234,56` is twelve hundred, not one point two three.** Getting it
  backwards authorises a figure the document never contained.
- **"thirty (30) days"** — contracts write figures twice, so both forms are
  read. A check that only sees digits cannot catch `30` cited against *"sixty
  (60) days"*.
- **A figure only counts beside its unit.** *"in accordance with clause 11"*
  contains the number 11. Without that rule every cross-reference in the
  contract becomes a candidate notice period, the conflict check fires on
  everything, and a guard that always fires gets switched off.

---

## It has been run for real

Three live runs against the example contract. The model found all nine fields,
recorded the notice period as **ambiguous with both candidates** — noticing on
its own that Schedule 2 says *"notwithstanding anything else in this
Agreement"* — kept the liability cap as the formula, and marked
termination-for-convenience absent with a note saying where it had looked.

Roughly **28,000 tokens, 22 tool calls, 25 seconds** per contract. Most of that
is the system prompt riding along on every turn; a longer contract costs more
in tool results, not in prompt.

The first run also found a real bug, which is the argument for doing it:
`effective_date` came back as `1 February 2027`, where every scripted test had
produced `2027-02-01`. **Both passed the guard.** One field, two formats,
depending on which phrasing the model happened to copy — and nothing
downstream could parse that reliably. The guard now takes ISO only, the prompt
says so, and the document's own wording stays where it belongs, in the span.

## Tests

58, all offline. `extract()` takes an injectable client, so the whole loop runs
against scripted responses with no API key.

Every guard was checked by removing it and confirming the right tests go red.
Two of them went green with the guard gone, which is how the suite ended up
with the tests it has:

- **`unevidenced_field` had no test that depended on it**, because
  `record_field` refuses bad spans before the guards ever see one. It is the
  second lock, and an untested lock is the one that quietly stops working — so
  it is now tested directly, against a record built by hand.
- **Nothing checked that the guards were wired in.** A guard can pass its own
  test and never run. There is now a test asserting every guard that exists is
  in the list, and that every rule named grave is a real rule.

---

## Layout

```
src/
  document.ts    sections, and the normalisation the whole design rests on
  numbers.ts     figures as contracts write them, with positions
  dates.ts       dates, and the one that cannot be read
  schema.ts      the fields, their triggers and their units
  candidates.ts  every answer the document offers, not just the chosen one
  guards.ts      the checks
  tools.ts       seven tools, and the three that do not exist
  prompt.ts      four rules, stated as prohibitions
  extract.ts     the agent — thin, because the loop is a dependency
  report.ts      printing, which is where the three states get flattened
contracts/       fictional examples; real ones gitignored
```

Built on [grounded-agents](https://github.com/jamiendreaj/grounded-agents),
which is where the loop, the token budget and the stop-reason handling live.
Building this was the first real test of that split — and it immediately found
one assumption baked into the framework, which is now fixed there.

---

## Scope

Not legal advice, and not a lawyer's work. It records what a contract **says**.
What any of it **means** is a different job, done by a person, and there is no
tool here that pretends otherwise.

The example contract is fictional. Both parties, both addresses and every
figure in it were invented for this repository.

MIT.
