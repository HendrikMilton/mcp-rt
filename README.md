# mcp-rt

Ingest pipeline for Estonian court decisions from Riigi Teataja, filtered to those that
substantively concern data protection. It builds the second index served by the MCP endpoint in
[mcp-aki](https://github.com/HendrikMilton/mcp-aki), which exposes both corpora as separate tools under one connector.

## The actual problem

Riigi Teataja publishes 725,752 court decisions. Data-protection cases are under ~1.4% of them
(0 positives in a random sample of 70), the site has no topic filter, and searching `andmekaitse`
finds 703 — most relevant decisions never use the word. **Deciding what belongs in the corpus is
the hard part; retrieval is the solved part**, inherited unchanged from `mcp-aki`.

So the pipeline is two stages, and they stay separate:

1. **Recall** — a union of three independent seed channels against RT's own full-text index,
   deliberately loose, producing ~22k candidates (~3% of the corpus).
2. **Precision** — Claude classifies each candidate before anything is embedded.

Classifying *before* embedding is what keeps the index at tens of MB instead of hundreds, and it is
why the pipeline can afford to keep the extracted text of every reject: re-thresholding or changing
the prompt costs a classify pass, never a re-crawl.

## The undocumented API

No auth. `research/q.py` has the original probe.

```
POST /public-api/api/v1/kohtuteave/otsing/kohtulahendid      search, 30/page, deep via searchAfter
GET  /public-api/api/v1/kohtuteave/liigitus/{kood}/kohtulahendid   decisions under a taxonomy node
GET  /public-api/api/v1/kohtuteave/kohtulahendid/{failiId}/file    the PDF
GET  /public-api/api/v1/kohtuteave/kohtulahendid/liigitused        the classification tree
```

Things that cost time to learn:

- **`morphSearch` is a no-op.** The index is literal: `isikuandmed` 2,963, `isikuandmete` 3,466,
  `isikuandmeid` 2,673 — different sets for one lemma. **Wildcards are the fix**: `isikuandme*`
  returns 8,130, 2.7x the recall. Every vocabulary seed carries one.
- **Case categories are useless as a filter.** The 17 decisions RT itself annotates
  `Haldusõigus -> Isikuandmete kaitse` sit under Maksuõigus, Teenistussuhted, Isikuvastased
  süüteod, Asjaõigus and Andmekogud. The topic cuts across the whole taxonomy.
- **`satteSeosed` and annotations are populated for Riigikohus only** — empty for the
  maakohus/ringkonnakohus bulk. The paragraph channel therefore searches full text for the literal
  citation ("AvTS § 35"), not the `seaduseSatted` precise filter, which would only see Riigikohus.
- **The taxonomy filter is a separate endpoint**, `/liigitus/{kood}/kohtulahendid`. There is no
  märksõna field on the search body — every plausible spelling of one was tried and ignored.
- **Searching `annotatsiooniSisu` badly under-returns**: `"KrMS § 214"` gives 8 there against 86 in
  full text. Anyone searching that way is seeing annotated Riigikohus decisions only.

## Throughput

Cleared with Riigi Teataja directly, and measured rather than assumed:

| | measured |
|---|---|
| search, concurrency 20 | 63 req/s, p50 153ms, **zero 429s** over 240 sustained requests |
| search, serial | 0.6–1.8s per request |
| PDF download, concurrency 25 | ~15/s, zero 429s |

The crawler runs searches at concurrency 16 and downloads at 25. 429 still gets exponential backoff
with full jitter — that is correctness, not courtesy; pushing through a throttle does not return
data faster, and 20 workers retrying in lockstep is how a blip becomes an outage.

## Seeds

`research/seeds.json`, three channels, union and dedupe on `objektId`:

- **19 vocabulary wildcards** — `isikuandme*`, `eraelu puutumatus*`, `videovalv*`, …
- **69 statute paragraphs with measured hit counts** — derived from the consolidated acts, 3,178
  total hits. Top: AvTS § 35 (317), KrMS § 297 (261), IKS § 4 (204).
- **85 taxonomy branches** of the 6,268-node tree — `Haldusõigus -> Isikuandmete kaitse`,
  `kriminaalmenetlus -> jälitustoimingud`, `Registrid, andmekogud`, `Riigisaladus`, `maksusaladus`.

The taxonomy channel returns little on its own (565 hits, 138 of them found by nothing else) but it
reaches decisions whose wording no vocabulary seed predicts — precisely the leak the other two
channels cannot see.

## Chunking

Estonian court decisions carry a fixed skeleton of ALL-CAPS headings across all three tiers —
`RESOLUTSIOON`, `ASJAOLUD JA MENETLUSE KÄIK`, `KOLLEEGIUMI SEISUKOHT`, `KOHTU PÕHJENDUSED` — so
sections are split first and only then windowed to ~1400 chars on sentence boundaries. About 1 in 7
decisions, mostly short procedural rulings, carry no headings and are windowed whole.

**Decisions are much longer than the handoff estimated.** Measured over all 21,926: median 20,555
chars, mean 30,377, p99 190,013, max 2,322,818 — against a handoff figure of 10,369 median. The
tail is mass criminal judgments whose operative part lists a sentence per defendant.

So chunking is capped at **80 chunks per decision**, and what is kept is chosen round-robin across
sections rather than by truncating the document. Measured over a 1,097-decision sample the cap
touches 3.1% of decisions and removes 12% of chunks; median (18) and mean (22) are untouched. The
2.3M-char outlier goes from ~1,600 chunks to 80, spread evenly over its four sections instead of
stopping partway through its operative part. Nothing is lost from the corpus — `get_court_decision`
serves the full text from S3 — only the retrieval granularity of the longest 3%.

## The classifier

One stateless call per decision, temperature 0, 12k chars — the first 6k and the last 6k, since
Estonian decisions put the facts at the front and the reasoning at the back with procedural filler
in the middle. Prompt and parser in `src/ingest/classify.ts`.

Scored on 87 labelled decisions (17 RT-annotated gold + 70 random), `research/step4.json`:

| model | gold (17) | random (70) flagged | false positives |
|---|---|---|---|
| Haiku 4.5 | 14/17 | 1 | **1** |
| Sonnet 4.6 | 14/17 | 0 | **0** |
| Nova Pro | 14/17 | 7 | 7 |

**Haiku, escalating to Sonnet below confidence 0.9.** Haiku's single error came at 0.85 and only 4
of 87 scored under 0.9, so escalation costs a few percent of the run and catches exactly where the
cheap model wavers. Haiku is also ~8x faster, which at 22k decisions matters more than the money.

Nova Pro failed by latching onto boilerplate about requesting anonymisation at publication — a real
trap, present in ~7% of decisions. The prompt names it explicitly as a reason to answer EI.

Both Claudes reject the same three gold cases, which look like annotation edge cases rather than
model errors.

## Hard limits

The pipeline runs unattended, so every limit is a constant with an abort path in
`src/lib/limits.ts`, not something an operator remembers to check:

```
MAX_CANDIDATES      = 25000   checked in the crawl loop and again before ingest
MAX_SPEND_USD       = 150     running meter over the usage Bedrock reports, not an estimate
MAX_SEARCH_REQUESTS = 3000    taken before each request goes out, retries included
MAX_RETRIES         = 5       per request, exponential backoff with full jitter
```

`MAX_SEARCH_REQUESTS` is the one that matters most. Bedrock spend is bounded by arithmetic that is
knowable before the run starts — `candidates × ~4.9k tokens × $1/M`, checked as a pre-flight that
refuses to begin a pass it cannot finish. The genuinely unbounded risk is a crawler bug retrying
forever against a government service.

AWS Budgets are **not** a safety net here: they are alerts, cost data lags by hours, and a Budget
Action would fire long after an overnight run finished. There is a $200 alert as a backstop; the
constants above are the actual protection.

## Storage

```
s3://hycapital-rt-rag/rt/
  raw/{id}.pdf          every candidate, rejects included (lifecycle → IA at 90 days)
  text/{id}.txt         every candidate, rejects included
  classified.jsonl      one line per candidate: verdict, confidence, model, escalated, promptVersion
  index/                meta.json.gz + vectors.i8 + scales.f32 — survivors only
```

Every query-time access pattern is a full scan of a few MB, so a file beats a table and there is no
DynamoDB. Verdicts are appended per row, so a run stopped by a limit loses nothing.

## Operating

```bash
yarn crawl                  # seed channels -> data/pool.json
yarn fetch                  # download + extract text (resumable; SKIP_UPLOAD=1 to stay local)
yarn fetch --upload-only    # push already-downloaded artifacts to S3
yarn classify               # Haiku + escalation -> data/classified.jsonl (resumable)
yarn ingest                 # all of the above, then embed survivors and write the index
yarn audit                  # adversarial out-of-pool sample -> data/audit.json
yarn build:lambda           # produce lambda.zip for terraform
```

Every stage resumes from disk. `data/text/` makes the download stage free on a rerun, and
`classified.jsonl` makes classification free — but a change to `PROMPT_VERSION` deliberately
invalidates stored verdicts, because the text is kept and reclassifying is the cheap half.

## What this does not measure

The seed stage's recall is the weak link. 15 of 17 gold decisions were found by literal seeds and
both misses were inflection, which the wildcards fix — but the gold set is 17 decisions,
Riigikohus-only and positives-only, so it can measure recall and not precision. `yarn audit`
samples 50 decisions from *outside* the pool using near-miss vocabulary chosen to have no overlap
with any seed, which bounds the leak in the region deliberately chosen to be hardest. See
`PROGRESS.md` for the number it produced.
