# Handoff: Estonian legal-decision MCP servers

Two corpora, one pattern. **`mcp-aki/` is built and live.** `mcp-rt/` (this folder) is
designed and measured but not yet written.

---

## Part 1 — what already works: `mcp-aki/`

Remote MCP server over the Estonian Data Protection Inspectorate's published decisions
(<https://www.aki.ee/meist/aki-tegevus/aki-otsused>), live as a Claude Code / claude.ai connector.

- **657 decisions, 12,113 chunks.** Whole published set, 2021 onwards.
- **Deployed**: `aki-mcp-api` + `aki-mcp-ingest` Lambdas, API Gateway, `s3://hycapital-aki-rag`,
  monthly EventBridge re-crawl. Terraform in `terraform/aki-mcp.tf`.
- **Connector URL**: `cd terraform && terraform output -raw aki_mcp_url`
- Registered in `~/.claude.json` **user scope** as `aki` (user scope matters — project scope
  made it invisible from other directories).
- Warm search ~0.8s, ~$0.05/mo fixed + **$2 per 1,000 searches** (rerank dominates).

Read `mcp-aki/README.md` for the retrieval design. The parts worth carrying over:

| decision | why |
|---|---|
| Hybrid BM25 + dense → RRF → Cohere rerank | Neither leg alone survives both query styles (table below) |
| BM25 with 6-char prefix stemming | Estonian has no stock stemmer; worth +0.15 MRR |
| Rerank pool of 80 | Pool recall hit 1.00 at 80, fell off at 40 and 20 |
| Section-aware chunking on ALL-CAPS headings | ~half of chunks land in the legal reasoning section |
| No vector DB — int8 vectors in Lambda memory | 12k chunks is 18MB; ANN would only cost recall |
| Cohere Embed v4 (`eu.cohere.embed-v4:0`) + Rerank 3.5 | Latest available, both in-region, EU-only fan-out |

Measured on 24 synthetic Estonian queries per style:

| | lawyer-phrased MRR | paraphrased MRR |
|---|---|---|
| dense only | 0.58 | 0.66 |
| BM25 only | 0.91 | 0.53 |
| **fused + reranked** | **0.87** | **0.89** |

### Gotchas already paid for

- **MCP SDK + serverless-http is broken.** The Node transport bridges through Hono, which reads
  `req.rawHeaders`; serverless-http's mock request doesn't set it, so every call 415'd. Fixed by
  using `WebStandardStreamableHTTPServerTransport` directly and adapting the API Gateway event.
  `src/server.ts` has the comment. Don't reintroduce express.
- **Handler path** is `dist/lambda.handler`, not `dist/src/lambda.handler` — tsconfig `include`
  sets rootDir to `src`.
- **zod must match the SDK's** (4.x). Mixing zod 3 with the SDK's bundled zod 4 causes
  `TS2589: Type instantiation is excessively deep`.
- `server.tool()` is deprecated — use `registerTool`.
- **Bedrock throttles embed v4 on tokens/min.** Adaptive retry + concurrency 3, see
  `src/lib/bedrock.ts`.
- aki.ee 429s under concurrency — its crawler is deliberately serial with a 1.2s pause.
- 3 AKI decisions are scans; they go through Textract and are flagged `ocr: true`.

---

## Part 2 — what to build: `mcp-rt/`

Estonian court decisions from Riigi Teataja. **The hard problem is not retrieval — it's deciding
what belongs in the corpus at all.**

### The problem

725,752 decisions, of which data-protection cases are **under ~1.4%** (0 positives in a random
sample of 70). There is no topic filter on the site, and the lawyer's requirement is that Claude
can tell data-protection decisions apart from traffic fines and alimony disputes.

Searching `andmekaitse` finds 703 — most relevant decisions never use the word.

### Undocumented public API (no auth)

```
POST /public-api/api/v1/kohtuteave/otsing/kohtulahendid    search, 30/page
GET  /public-api/api/v1/kohtuteave/kohtulahendid/{objektId}          detail JSON
GET  /public-api/api/v1/kohtuteave/kohtulahendid/{failiId}/file      the PDF
GET  /public-api/api/v1/kohtuteave/kohtulahendid/liigitused          classification tree
GET  /public-api/api/v1/akt/lyhendid                                 statute abbrev -> id
GET  /public-api/api/v1/akt/{globaalId}/blob-html                    full statute text
```

Request body shape is in `research/q.py`. Deep pagination works to the end via
`general.searchAfter` (offset, +30 per page).

### Measured facts that drive the design

- **`morphSearch` is a no-op.** The index is literal: `isikuandmed` 2,963, `isikuandmete` 3,466,
  `isikuandmeid` 2,673 — different sets for one lemma.
- **Wildcards work and are the fix**: `isikuandme*` → 8,129, 2.7× the recall.
- **Case categories are useless.** The 17 decisions RT itself annotates
  `Haldusõigus -> Isikuandmete kaitse` sit under Maksuõigus, Teenistussuhted, Isikuvastased
  süüteod, Asjaõigus, Andmekogud. The topic cuts across the whole taxonomy.
- **`satteSeosed` (cited-statute links) is only populated for Riigikohus** — empty for the
  maakohus/ringkonnakohus bulk. Same for annotations.
- **`annotatsiooniSisu` search badly under-returns**: `"KrMS § 214"` gives 8 there vs **86** in
  full text. The lawyer currently searches this way and is seeing ~10% of what exists — tell her.
- **PDF downloads parallelize fine**: 8-way = 0.11s/file, zero 429s (unlike aki.ee). The user has
  cleared higher throughput with Riigi Teataja directly, so run downloads at concurrency ~25 and
  parallelise search requests too. Still honour 429 with backoff — that's correctness, not
  courtesy; pushing through a throttle doesn't return data faster. Search endpoint is
  ~8s/request serially and its parallelism is **untested** — measure it first.
- Decisions average 10,369 chars (median), 7–14 pages, all with text layers.

### Architecture — two pipelines, and keep them separate

**Ingest** (once, then monthly):

1. **Recall stage** — three independent seed channels against RT's own full-text index, union
   and dedupe → ~15–20k candidates (~2–3% of corpus):
   - vocabulary wildcards (`isikuandme*`, `eraelu*`, `videovalv*`, …) — see `research/` and the
     list in this repo's crawler once written
   - statute paragraphs — `research/paracount.json` has 78 paragraphs with hit counts
   - taxonomy branches — `research/tree_hits.json`, 85 relevant nodes of 6,268
2. Download PDFs, extract text. Store text for **every** candidate, including rejects.
3. **Precision stage** — Claude classifies each: data-protection yes/no + confidence.
4. Chunk + embed **only survivors** (~2–3k). Classify *before* embedding — that ordering is what
   keeps the index at ~58MB instead of ~576MB.

**Query** (per search, no LLM in the hot path): identical to `mcp-aki` — BM25 + dense → RRF →
rerank top 80 → top 10.

### The classifier — measured, use these settings

One stateless call per decision, temperature 0, 12k chars (first 6k + last 6k — facts at the
front, reasoning at the back, procedural filler in the middle). Prompt and parser are in
`research/classify.py`; output is `{"vastus":"JAH"|"EI","kindlus":0.0-1.0,"pohjus":"..."}`.

Scored on 87 labelled decisions (17 RT-annotated gold + 70 random) — `research/step4.json`:

| model | gold (17) | random (70) | false positives |
|---|---|---|---|
| Haiku 4.5 | 14/17 | 1 flagged | **1** |
| Sonnet 4.6 | 14/17 | 0 flagged | **0** |
| Nova Pro | 14/17 | 7 flagged | 7 |

**Use Haiku with escalation to Sonnet below confidence 0.9.** Haiku's single error came at 0.85,
and only 4 of 87 scored under 0.9 — so escalation costs ~5% and catches exactly where it wavers.
Haiku is also ~8× faster, which matters more than the money at 15k decisions.

Both Claudes reject the identical three gold cases, which are most likely annotation edge cases
rather than model errors. Nova Pro failed by latching onto boilerplate about requesting
anonymisation at publication — a real trap, present in ~7% of decisions.

Bedrock note: the Anthropic first-time-use form **has been submitted** for this account;
`eu.anthropic.*` Claude models work in `eu-central-1`.

### Storage — S3, no DynamoDB

```
s3://<bucket>/rt/
  raw/{id}.pdf            all candidates
  text/{id}.txt           all candidates, including rejects
  classified.jsonl        one line per candidate: id, nr, vastus, kindlus, pohjus,
                          model, escalated, promptVersion, at
  index/                  meta.json.gz + vectors.i8 + scales.f32, survivors only
```

Every access pattern is a full scan (~3MB), so a file beats a table. Keeping rejects + text means
re-thresholding and prompt changes never re-crawl. Resumability: append locally, flush every few
hundred lines.

### Cost and time

| | time | cost |
|---|---|---|
| Pool build (~1,000 searches, parallelised) | ~20 min | free |
| Download ~18k PDFs (conc 25) | ~10 min | free |
| Classify, Haiku + ~5% Sonnet | ~1.5h | **~$75** |
| Embed survivors | ~20 min | ~$4 |
| **total, unattended** | **~2.5h** | **~$80** |

Ongoing ~$1/mo. Full 725k would be ~$2,500 and ~30h — only worth it to eliminate seed-stage risk
entirely.

### Hard limits — enforce in code, not judgment

This pipeline is expected to run unattended. Every limit below must be a constant in the code
with an abort path, not something the agent remembers to check.

```
MAX_CANDIDATES      = 25000     // abort if the pool exceeds this
MAX_SPEND_USD       = 150       // running Bedrock token counter, abort on breach
MAX_SEARCH_REQUESTS = 3000      // crawler total, guards against a retry loop
MAX_RETRIES         = 5         // per request, exponential backoff
```

Classification cost is deterministic before the run starts: `candidates × ~4k tokens × $1/M`.
At the expected ~18k pool that is ~$75, and it cannot exceed `MAX_SPEND_USD` unless something
loops — which the counter also catches.

AWS Budgets are **not** a safety net here: they are alerts, cost data lags by hours, and Budget
Actions would fire long after an overnight run finished. A $200 budget alert to email is worth
having as a backstop, but the real protection is the constants above.

The genuinely unbounded risk is not Bedrock spend — it is a crawler bug retrying forever against
a government service. `MAX_SEARCH_REQUESTS` exists for that.

Log actual spend and request counts to `PROGRESS.md` when the run finishes.

### Open risks

1. **Seed recall is the weak link and is unmeasured.** 15/17 gold were found by literal seeds
   (both misses were inflection, which wildcards fix), but the random sample produced no positives,
   so there is no leak estimate. De-risk by: going loose, mining seed vocabulary from confirmed
   positives, and an adversarial out-of-pool sample of 50 targeting near-miss wording
   (`jälitustoiming`, `päring registrist`, `saladuse hoidmise kohustus`).
2. **Search-endpoint parallelism untested.** If it parallelizes, pool build drops from 2.2h to
   ~20 min.
3. **Gold set is 17, Riigikohus-only, positives-only.** It can measure recall, not precision.
4. Throughput is cleared with Riigi Teataja — the user asked them. Run hot from one IP; there is
   still no reason to distribute across IPs. Keep `MAX_SEARCH_REQUESTS` as a runaway guard.

### Product decisions already made

- **Separate index from AKI, same MCP server, separate tools.** Merging would bury 654 AKI
  decisions under 10× the court text, and the two answer different questions — AKI is the
  regulator's own practice, courts are how those positions fared on review.
- Tools to add: `search_court_decisions`, `get_court_decision`, `list_court_decisions`, each with
  category/year/norm filters mirroring the AKI ones.
- `list_*` must stay compact past ~20 results — the AKI version returned six lines per decision
  and a 115-result listing got truncated mid-entry, which produced confidently wrong summaries.

### Seed list — already derived, use it

`research/seeds.json` is the finished seed set. Three channels, union and dedupe on `objektId`:

- **19 vocabulary wildcards** — `isikuandme*`, `eraelu puutumatus*`, `videovalv*`, …
- **69 statute paragraphs with measured hit counts** — derived from the consolidated acts
  (AvTS 48/59 relevant, KrMS 24/497, IKS 61/77), 3,178 total hits. Top: AvTS § 35 (317),
  KrMS § 297 (261), IKS § 4 (204), AvTS § 3 (190), AvTS § 23 (183).
- **85 taxonomy branches** — from the 6,268-node classification tree. Core:
  `Haldusõigus -> Isikuandmete kaitse` (7 sub), `Karistusõigus -> kriminaalmenetlus ->
  jälitustoimingud` (12 sub), `Registrid, andmekogud`, `Riigisaladus`, `maksusaladus`.

`research/paras.json` has the raw per-act inventory if the list needs revisiting.

---

## How to work this

Track progress in `mcp-rt/PROGRESS.md`, updating it as steps complete. Use subagents for the
parallelisable research and build steps. `research/` holds the probe artifacts so none of the
measurement above needs redoing.
