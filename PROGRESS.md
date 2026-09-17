# mcp-rt progress

Update this as steps land. Read `HANDOFF.md` first — it has every measured number and the
gotchas already paid for. Probe artifacts are in `research/`; don't re-measure what's there.

**Status:** paused mid-classification, resumable. Everything up to and including the download stage
is finished; 4,876 of 21,926 candidates are classified. **Resume with `yarn ingest`** — it rehydrates
verdicts, skips every finished row, and runs through embedding and index write without re-crawling
or re-downloading anything.

**Blocker to clear first: Bedrock's per-day token quota, not money.** See the log below.

## Build

- [x] Scaffold `mcp-rt/` (copy `mcp-aki` tsconfig, package.json, build-lambda.sh; zod must match the SDK's 4.x)
- [x] `src/ingest/crawl.ts` — RT API client, `searchAfter` pagination, three seed channels, dedupe
- [x] Measured search-endpoint parallelism — **it parallelises**: 63 req/s at concurrency 20, p50 153ms, zero 429s over 240 sustained requests. HANDOFF's "~8s/request serially" was stale; single requests are 0.6–1.8s. Crawler runs at concurrency 16. Pool build took ~4 min, not 2.2h.
- [x] `src/ingest/fetch.ts` — concurrent download (conc ~25, 429 backoff), pdf-parse
- [x] `src/ingest/classify.ts` — Haiku, escalate <0.9 to Sonnet, JSONL append + resume
- [x] `src/ingest/build.ts` — orchestrate, write second index to S3
- [x] Two-index support in `store.ts` — `Corpus<D>` descriptor, one cache entry per corpus, so a container answering only AKI questions never downloads the court index
- [x] 3 MCP tools: `search_court_decisions`, `get_court_decision`, `list_court_decisions`
- [x] Terraform: `terraform/rt-mcp.tf` — `hycapital-rt-rag` bucket, `rt-mcp-ingest` Lambda, monthly EventBridge (2nd of the month, a day after AKI so the two never contend for Bedrock tokens), read grant to the existing MCP role, $200 Bedrock budget backstop. Applied: 13 added, 0 changed.
- [ ] Deploy + verify against real queries

## Limits (must be constants in code — see HANDOFF.md)

- [x] `MAX_CANDIDATES = 25000` — `src/lib/limits.ts`, checked in the crawler loop and again before ingest
- [x] `MAX_SPEND_USD = 150` — `SpendMeter` accumulates the token usage Bedrock *reports* on every response, not an estimate; throws `LimitExceeded` on breach. Plus a deterministic pre-flight that refuses to start a classify pass it cannot finish inside the budget.
- [x] `MAX_SEARCH_REQUESTS = 3000` — every request through the RT client takes from the budget *before* it goes out, including retries, so a retry loop trips the cap instead of spinning
- [ ] Actual spend logged below when the run completes

## Data

- [x] Pool built — **21,929 unique candidates** in **1,231 search requests** (~4 min). Channels, unique-at-first-sight: vocab 20,769 · paragraphs 1,022 · taxonomy 138.
- [x] PDFs downloaded — **21,926 of 21,929**; 3 without a text layer, **0 failures, 0 429s** at
      concurrency 25 (~25 min). Corpus is 666M chars, 3.6GB of PDF.
- [~] Classified — **4,876 of 21,926** so far: 668 JAH (13.7%), 4,208 EI, 398 escalated (8.2%).
      Stopped by a Bedrock daily token cap, not by the spend limit. Resumable per row.
- [ ] Survivors embedded — docs, chunks, index MB: ____
- [~] Bedrock spend so far: **$33.52** of $150 (Haiku $27.56 / 4,983 calls; Sonnet $5.96 / 400 calls).
      Search requests used: **1,231** of 3,000 for the pool, plus ~180 for the audit and mining probes.

## Validation

- [x] Adversarial out-of-pool sample (50, near-miss vocabulary) → **3 of 50** classified JAH (6%).
      `yarn audit`, full output in `data/audit.json`. Drawn from 18 near-miss terms chosen to have
      no prefix overlap with any seed wildcard, each confirmed absent from the pool before scoring.

      Reading the three by hand: **two are genuine leaks**, one is a classifier false positive.
      - `3-26-2137/3` (`turvakaamera`) — a prisoner filmed by a toilet camera, arguing explicitly
        for esialgne õiguskaitse "tema eraelu kaitseks". Squarely on topic. A pure vocabulary gap:
        `videovalv*` is a seed, `turvakaamera` is not.
      - `3-26-2664/3` (`saladuse hoidmise kohustus`) — an advocate seeking release from
        kutsesaladus under AdvS § 45, weighing "asjaosaliste eraelu ning ärisaladuste kaitse".
        The *taxonomy* channel has this exact node (kood 342368211), but märksõnad are only
        populated for annotated decisions, so the node never returned it.
      - `3-24-3484/11` (`nime avalikustamine`) — a nature-conservation and building-rights case.
        Read in full, the *only* line in it touching personal data is §18: "Kuna otsuse sisu
        mõistmiseks ei ole kaebaja nime avalikustamine vajalik, tuleb tema nimi …" — the standard
        anonymisation-at-publication clause, which is exactly the trap HANDOFF flags as present in
        ~7% of decisions and which sank Nova Pro. Haiku fell for it here despite the prompt naming
        it. Counted as a classifier false positive, not a leak.

      **So ~4% leak in the region deliberately chosen to be hardest.** This is not the corpus-wide
      leak rate and should not be quoted as one — every term was picked *because* no seed covers
      it. The corpus-wide figure is necessarily far lower, and the honest statement is that it
      remains unmeasured: at a base rate under 1.4%, a uniform sample of 50 would be expected to
      contain well under one positive and could not distinguish 0% leak from 3%.
- [ ] Mine seed vocabulary from confirmed positives; re-run pool, record the delta
- [ ] Spot-check rejects for wrong "no"s

## For the user

- [ ] Tell the lawyer: her `annotatsiooniSisu` search returns ~10% of what full text does
      (`"KrMS § 214"` gives 8 there vs 86 in full text — re-confirmed 2026-09-16). She is seeing
      annotated Riigikohus decisions only. This is worth telling her now, independently of the
      corpus — it changes how she should search today.
- [ ] Optional: have her review `research/seeds.json` paragraphs once the corpus exists —
      not a blocker, the list is already derived.


## Log

### 2026-09-16/17 — build, pool, download, classification paused

**Done and verified**

- Whole pipeline written and typechecking; `mcp-aki` extended to serve both corpora as six tools.
  Regression-checked locally: AKI still loads 657 docs / 12,113 chunks and answers real queries.
- Infrastructure applied (13 added, 0 changed) — nothing existing was touched.
- Pool: **21,929 unique candidates in 1,231 search requests**, ~4 min.
- Download: **21,926 texts, 3 without a text layer, 0 failures, 0 429s** at concurrency 25, ~25 min.
- Gold-set check reproduces HANDOFF exactly: **14/17**, and the same three rejects, so the prompt
  and plumbing behave as measured.
- Adversarial out-of-pool audit: **3 of 50**, two genuine leaks and one false positive, each read
  in the source rather than taken from the classifier's own reason string.

**Surprises, in the order they cost time**

1. **The search endpoint parallelises, and HANDOFF's "~8s/request serially" was stale.** It sustains
   63 req/s at concurrency 20 with zero 429s. Pool build went from a projected 2.2h to 4 minutes.
2. **There is no märksõna field on the search body.** Ten plausible spellings were all silently
   ignored — they returned the unfiltered 725,792. The taxonomy channel is a *different endpoint*,
   `GET /kohtuteave/liigitus/{kood}/kohtulahendid`, found by reading the site's Angular bundle.
   Worth knowing before anyone re-derives the seed list.
3. **Decisions are twice as long as recorded.** Median 20,555 chars against HANDOFF's 10,369; mean
   30,377, p99 190k, max 2.3M. This is the root cause of the cost overrun below, and it also forced
   a chunk cap (80/decision, round-robin across sections) so that mass criminal judgments could not
   contribute 1,600 near-identical passages each.
4. **Estonian tokenises at ~2.45 chars/token, so 12k chars costs ~4,900 tokens, not 4,000.** Combined
   with a 21.9k pool (not ~18k) and 8.2% escalation (not 5%), the classification run projects to
   **$144**, not the $75 in HANDOFF — 1.9x. It still fits under $150, but with under 2% headroom,
   which is why `EMBED_RESERVE_USD` now holds back the embedding budget explicitly: without it the
   two stages race and classification wins, leaving no index.
5. **The actual stopper was a Bedrock quota, not the budget.** At 4,876 rows:
   `ThrottlingException: Too many tokens per day, please wait before trying again` (HTTP 429, not
   retryable — `$retryable: undefined`). ~25M Haiku input tokens in about an hour. The adaptive
   backoff in `bedrock.ts` is built for per-minute throttling and cannot wait out a per-day cap, so
   the run surfaced it rather than spinning. This is a per-account limit, so it will recur on any
   single-day attempt at the full pool.

**Before resuming, decide two things**

- **The daily token quota.** Either request a quota increase for Haiku 4.5 in eu-central-1, or split
  the run across nights — resume is free, so 3-4 evenings of `yarn ingest` costs nothing extra.
  A third option worth pricing: Bedrock **batch inference** is ~50% cheaper and asynchronous, which
  would fix the budget margin and the quota in one move, at the cost of reworking `classify.ts`.
- **The $150 cap.** The projection is $147 for the whole pipeline. It fits on the central estimate
  but the margin is inside the estimate's own error bars. Raising `MAX_SPEND_USD` to ~165 would
  remove the risk of aborting at 99% and leave room for the reject spot-check; actual spend would
  still land near $149. The constant is deliberately left at 150 — that is the number you set.

**Still open**

- Embedding + index write (needs classification finished).
- Deploy the rebuilt `mcp-aki` artifact — **not yet deployed**, so the live connector still serves
  only the three AKI tools and is unaffected by any of this.
- `yarn mine` (vocabulary from confirmed positives) and `yarn verify` (reject spot-check) — both
  written and ready, neither run.

